import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const pollingLimit = 100_000;
const attemptBudgetMs = 10_000;

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

function fields(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && required.every(name => Object.hasOwn(value, name))
    && Object.keys(value).every(name => required.includes(name) || optional.includes(name));
}

function instant(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : NaN;
}

function validatePollingContract(data) {
  const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!fields(data, ["schema_version", "state", "time_zone", "generated_at",
    "source_succeeded_at", "primary", "secondary", "error"])
    || data.time_zone !== "America/Los_Angeles" || !Number.isFinite(instant(data.generated_at)))
    fail("invalid_polling_contract");
  if (data.state === "current" ? data.error !== null
    : !fields(data.error, ["code", "message"]) || typeof data.error.message !== "string")
    fail("invalid_polling_contract");
  for (const day of [data.primary, data.secondary]) {
    if (!fields(day, ["date", "label", "eligible_total", "occurrences"]) || !date(day.date)
      || typeof day.label !== "string" || !Array.isArray(day.occurrences)
      || (data.state === "error" ? day.eligible_total !== null || day.occurrences.length !== 0
        : !Number.isSafeInteger(day.eligible_total) || day.eligible_total < day.occurrences.length))
      fail("invalid_polling_contract");
    for (const occurrence of day.occurrences) {
      if (occurrence === null || typeof occurrence !== "object" || Array.isArray(occurrence))
        fail("invalid_polling_contract");
      const allDay = occurrence.time_kind === "all_day";
      const timing = allDay ? ["start_date", "end_date_exclusive"] : ["start_at", "end_at"];
      if (!fields(occurrence, ["time_kind", "id", "title", ...timing], ["location"])
        || !["all_day", "timed"].includes(occurrence.time_kind)
        || typeof occurrence.id !== "string" || !occurrence.id.length
        || typeof occurrence.title !== "string"
        || (occurrence.location !== undefined && occurrence.location !== null && typeof occurrence.location !== "string")
        || (allDay ? !date(occurrence.start_date) || !date(occurrence.end_date_exclusive)
          || occurrence.start_date >= occurrence.end_date_exclusive
          : !Number.isFinite(instant(occurrence.start_at)) || !Number.isFinite(instant(occurrence.end_at))
          || instant(occurrence.end_at) <= instant(occurrence.start_at)))
        fail("invalid_polling_contract");
    }
  }
  const sourceAge = instant(data.generated_at) - instant(data.source_succeeded_at);
  if (data.state === "stale" && !(sourceAge >= 0 && sourceAge < 3_600_000))
    fail("invalid_source_success_time");
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
  if (!["current", "stale", "error"].includes(expectedState)
    || (expectedCode !== undefined && !/^[a-z_]{1,48}$/.test(expectedCode))
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
  let data;
  try {
    data = JSON.parse(response.body);
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid_polling_json");
    throw error;
  }
  if (!data || Array.isArray(data) || data.schema_version !== 1 || data.state !== expectedState)
    fail("unexpected_calendar_state");
  if (expectedCode !== undefined && data.error?.code !== expectedCode)
    fail("unexpected_calendar_error");
  if (response.content_type?.split(";")[0].trim().toLowerCase() !== "application/json")
    fail("invalid_polling_content_type");
  validatePollingContract(data);
  if (data.source_succeeded_at !== null && !Number.isFinite(instant(data.source_succeeded_at)))
    fail("invalid_source_success_time");
  const sourceTime = data.source_succeeded_at === null ? null : new Date(data.source_succeeded_at);
  if ((expectedState !== "error" && sourceTime === null)
    || (sourceTime !== null && !Number.isFinite(sourceTime.getTime())))
    fail("invalid_source_success_time");
  // Native single-URL polling exposes the parsed object's fields at the top level.
  // IDX_0 is for multiple URLs; merge_variables is the different webhook contract.
  const combinedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (combinedBytes >= pollingLimit)
    fail("combined_polling_too_large", { combined_polling_utf8_bytes: combinedBytes });
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
    poll: {
      http_status: response.status,
      state: data.state,
      error_code: expectedCode ?? null,
      source_succeeded_at: sourceTime?.toISOString() ?? null,
      raw_response_utf8_bytes: response.bytes,
      combined_polling_utf8_bytes: combinedBytes,
      measured_before_probes: true,
      cold_start_confirmed: false,
      attempts,
      retry_used: attempts.length > 1
    }
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
