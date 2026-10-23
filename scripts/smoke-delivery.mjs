import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { AgendaContractError, validateAgenda } from "./agenda-contract.mjs";

const pollingLimit = 100_000;
const attemptBudgetMs = 10_000;
const calendarStates = new Set(["current", "stale", "error"]);
const calendarErrorCodes = new Set([
  "configuration_invalid", "source_configuration", "source_unavailable", "source_invalid",
  "compatibility_unsupported", "agenda_too_large", "cache_configuration", "cache_unavailable", "cache_invalid",
  "refresh_missing", "refresh_delayed", "refresh_incomplete"
]);

class DeliveryFailure extends Error {
  constructor(code, evidence = {}) {
    super(code);
    this.code = code;
    this.evidence = evidence;
  }
}

function fail(code, evidence) {
  throw new DeliveryFailure(code, evidence);
}

function validatePollingContract(data, evidence) {
  try {
    validateAgenda(data);
  } catch (error) {
    if (error instanceof AgendaContractError) fail(error.code, evidence);
    throw error;
  }
}

function pollingEvidence(response, attempts, data) {
  const evidence = {
    http_status: response.status,
    state: "unknown",
    error_code: "unknown",
    source_succeeded_at: null,
    raw_response_utf8_bytes: response.bytes,
    measured_before_probes: true,
    cold_start_confirmed: false,
    attempts,
    retry_used: attempts.length > 1
  };
  if (data === undefined) return evidence;
  validatePollingContract(data, evidence);
  return {
    ...evidence,
    state: data.state,
    error_code: data.error === null ? null
      : calendarErrorCodes.has(data.error.code) ? data.error.code : "unknown",
    source_succeeded_at: data.source_succeeded_at === null ? null
      : new Date(data.source_succeeded_at).toISOString(),
    combined_polling_utf8_bytes: Buffer.byteLength(JSON.stringify(data), "utf8")
  };
}

export async function smokeDelivery({
  endpoint, key, syntheticLocal = false, expectedState = "current", expectedCode, rulesJson = "[]"
}) {
  let url;
  try {
    url = new URL(endpoint);
  } catch (error) {
    if (error instanceof TypeError) fail("invalid_endpoint");
    throw error;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/agenda"
    || (syntheticLocal ? !loopback || url.protocol !== "http:" : loopback || url.protocol !== "https:"))
    fail("invalid_endpoint");
  if (typeof key !== "string" || !key.length || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key))
    fail("function_key_required");
  if (!calendarStates.has(expectedState)
    || (expectedCode !== undefined && !calendarErrorCodes.has(expectedCode))
    || (expectedState !== "current" && expectedCode === undefined))
    fail("invalid_expectation");
  if (typeof rulesJson !== "string" || Buffer.byteLength(rulesJson, "utf8") > 16 * 1024)
    fail("invalid_rule_text_input");

  async function request(headerKey, rules = "[]") {
    const started = performance.now();
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(attemptBudgetMs),
        headers: {
          "Content-Type": "application/json",
          ...(headerKey === undefined ? {} : { "x-functions-key": headerKey })
        },
        body: JSON.stringify({ rules_json: rules })
      });
      const chunks = [];
      let bytes = 0;
      if (response.body !== null) {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > 2 * pollingLimit) fail("response_too_large", { raw_response_utf8_bytes: bytes });
          chunks.push(chunk);
        }
      }
      const elapsed = performance.now() - started;
      if (elapsed >= attemptBudgetMs) fail("attempt_over_budget", { elapsed_ms: Math.ceil(elapsed) });
      let body;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof TypeError) fail("invalid_polling_utf8");
        throw error;
      }
      return {
        status: response.status, body, content_type: response.headers.get("content-type"),
        bytes, elapsed_ms: Math.ceil(elapsed)
      };
    } catch (error) {
      if (error instanceof DeliveryFailure) throw error;
      if (error.name === "TimeoutError" || error.name === "AbortError")
        fail("attempt_over_budget", { elapsed_ms: Math.ceil(performance.now() - started) });
      if (error instanceof TypeError)
        fail("transport_failed", { elapsed_ms: Math.ceil(performance.now() - started) });
      throw error;
    }
  }

  const attempts = [];
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await request(key, rulesJson);
    } catch (error) {
      if (!(error instanceof DeliveryFailure)
        || !["transport_failed", "attempt_over_budget"].includes(error.code)) throw error;
      attempts.push({ error: error.code, elapsed_ms: error.evidence.elapsed_ms });
      if (attempt === 0) continue;
      fail(error.code, { attempts });
    }
    attempts.push({ http_status: response.status, elapsed_ms: response.elapsed_ms });
    if (response.status === 200) break;
    if (attempt === 0 && (response.status >= 500 || [408, 429].includes(response.status))) continue;
    fail("authorized_poll_rejected", { attempts });
  }
  if (attempts.some(attempt => attempt.error === "attempt_over_budget"))
    fail("polling_budget_exceeded", { attempts });
  const received = pollingEvidence(response, attempts);
  let data;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid_polling_json", received);
    throw error;
  }
  if (response.content_type?.split(";")[0].trim().toLowerCase() !== "application/json")
    fail("invalid_polling_content_type", received);
  const evidence = pollingEvidence(response, attempts, data);
  if (data.state !== expectedState)
    fail("unexpected_calendar_state", evidence);
  if (expectedCode !== undefined && data.error?.code !== expectedCode)
    fail("unexpected_calendar_error", evidence);
  // Native single-URL polling exposes the parsed object's fields at the top level.
  // IDX_0 is for multiple URLs; merge_variables is the different webhook contract.
  if (evidence.combined_polling_utf8_bytes >= pollingLimit)
    fail("combined_polling_too_large", evidence);
  const missing = await request(undefined);
  const wrong = await request(`wrong-${randomBytes(24).toString("hex")}`);
  if (![401, 403].includes(missing.status) || ![401, 403].includes(wrong.status))
    fail("authentication_not_enforced", { missing_key_status: missing.status, wrong_key_status: wrong.status });

  return {
    checks_passed: true,
    activation_complete: false,
    evidence_scope: syntheticLocal ? "local_synthetic" : "deployed_http_only",
    checked_at: new Date().toISOString(),
    authentication: { missing_key_status: missing.status, wrong_key_status: wrong.status },
    poll: evidence
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        endpoint: { type: "string" },
        "expected-state": { type: "string", default: "current" },
        "expected-code": { type: "string" },
        "rules-file": { type: "string" },
        "synthetic-local": { type: "boolean", default: false }
      }
    });
    const key = process.env.TRMNL_FUNCTION_KEY;
    delete process.env.TRMNL_FUNCTION_KEY;
    let rulesJson = "[]";
    if (values["rules-file"]) {
      const file = await open(values["rules-file"], "r");
      try {
        const buffer = Buffer.alloc(16 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length === buffer.length) fail("rule_file_too_large");
        try {
          rulesJson = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
        } catch (error) {
          if (error instanceof TypeError) fail("invalid_rule_file_utf8");
          throw error;
        }
      } finally {
        await file.close();
      }
    }
    const report = await smokeDelivery({
      endpoint: values.endpoint, key, expectedState: values["expected-state"],
      expectedCode: values["expected-code"], syntheticLocal: values["synthetic-local"], rulesJson
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      checks_passed: false, activation_complete: false,
      error: error instanceof DeliveryFailure ? error.code : "smoke_tool_failed",
      evidence: error instanceof DeliveryFailure ? error.evidence : {}
    }));
    process.exitCode = 1;
  }
}
