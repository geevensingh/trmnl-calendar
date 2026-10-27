import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgendaContractError, validateAgenda } from "../../scripts/agenda-contract.mjs";

const key = "SYNTHETIC_FUNCTION_SCOPED_KEY";
const current = {
  schema_version: 2,
  state: "current",
  time_zone: "America/Los_Angeles",
  generated_at: "2026-10-19T18:00:00Z",
  source_succeeded_at: "2026-10-19T18:00:00Z",
  primary: { date: "2026-10-19", label: "Monday, Oct 19", eligible_total: 0, occurrences: [] },
  secondary: { date: "2026-10-20", label: "Tuesday, Oct 20", eligible_total: 0, occurrences: [] },
  error: null
};

function agendaWithOccurrence(expectation = "unknown") {
  const agenda = structuredClone(current);
  agenda.primary.eligible_total = 1;
  agenda.primary.occurrences = [{
    time_kind: "timed", id: "synthetic", title: "Synthetic event",
    participation_expectation: expectation,
    start_at: "2026-10-19T19:00:00Z", end_at: "2026-10-19T20:00:00Z"
  }];
  return agenda;
}
test("agenda contract requires participation in schema 2 and permits independent timed emphasis", () => {
  assert.equal(validateAgenda(structuredClone(current)).schema_version, 2);
  assert.throws(() => validateAgenda({ ...structuredClone(current), schema_version: 1 }), AgendaContractError);
  const ongoing = structuredClone(current);
  ongoing.schema_version = 2;
  ongoing.primary.occurrences = [
    { time_kind: "timed", id: "in-progress", title: "Current", participation_expectation: "definite",
      start_at: "2026-10-19T17:00:00Z",
      end_at: "2026-10-19T19:00:00Z", emphasis: "in_progress" },
    { time_kind: "all_day", id: "all-day", title: "Date-only", participation_expectation: "unknown",
      start_date: "2026-10-19",
      end_date_exclusive: "2026-10-20" }
  ];
  ongoing.primary.eligible_total = ongoing.primary.occurrences.length;
  assert.equal(validateAgenda(ongoing).primary.occurrences[0].emphasis, "in_progress");
  const legacy = structuredClone(ongoing);
  legacy.schema_version = 1;
  delete legacy.primary.occurrences[0].emphasis;
  assert.throws(() => validateAgenda(legacy), AgendaContractError);

  const upcoming = structuredClone(current);
  upcoming.schema_version = 2;
  upcoming.primary.occurrences = [
    { time_kind: "timed", id: "upcoming", title: "Next", participation_expectation: "likely",
      start_at: "2026-10-19T18:10:00Z",
      end_at: "2026-10-19T19:00:00Z", emphasis: "upcoming" }
  ];
  upcoming.primary.eligible_total = 1;
  assert.equal(validateAgenda(upcoming).primary.occurrences[0].emphasis, "upcoming");
  assert.throws(() => validateAgenda({ ...upcoming, schema_version: 1 }), AgendaContractError);
  assert.throws(() => validateAgenda({
    ...upcoming,
    primary: { ...upcoming.primary, occurrences: [
      { ...upcoming.primary.occurrences[0], emphasis: "unknown" }
    ] }
  }), AgendaContractError);
  assert.throws(() => validateAgenda({
    ...ongoing,
    primary: { ...ongoing.primary, eligible_total: 3, occurrences: [
      ...ongoing.primary.occurrences,
      { ...ongoing.primary.occurrences[1], emphasis: "upcoming" }
    ] }
  }), AgendaContractError);
});

async function serve(t, handler) {
  const server = createServer(handler);
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}/api/agenda`;
}

async function smokeCli(t, endpoint, arguments_ = []) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../../scripts/smoke-delivery.mjs", import.meta.url)),
    "--synthetic-local", "--endpoint", endpoint, ...arguments_
  ], { env: { ...process.env, TRMNL_FUNCTION_KEY: key }, signal: t.signal });
  const closed = once(child, "close");
  const read = async stream => {
    stream.setEncoding("utf8");
    let text = "";
    for await (const chunk of stream) text += chunk;
    return text;
  };
  const [stdout, stderr, [status]] = await Promise.all([
    read(child.stdout), read(child.stderr), closed
  ]);
  return { stdout, stderr, status };
}

function unavailable() {
  const agenda = structuredClone(current);
  agenda.state = "error";
  agenda.primary.eligible_total = null;
  agenda.secondary.eligible_total = null;
  agenda.error = { code: "source_unavailable", message: "CONFIDENTIAL_RAW_EXCEPTION_AND_SOURCE_URL" };
  return agenda;
}

test("the CLI preserves redacted first-poll error evidence without running warming auth probes", async t => {
  const agenda = structuredClone(current);
  agenda.state = "error";
  agenda.generated_at = "2026-10-20T18:00:00Z";
  agenda.primary.label = "CONFIDENTIAL_PRIMARY_DATE_LABEL";
  agenda.secondary.label = "CONFIDENTIAL_SECONDARY_DATE_LABEL";
  agenda.primary.eligible_total = null;
  agenda.secondary.eligible_total = null;
  agenda.error = { code: "source_unavailable", message: "CONFIDENTIAL_SOURCE_URL_AND_RAW_EXCEPTION" };
  const body = JSON.stringify(agenda);
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });

  const result = await smokeCli(t, endpoint);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const report = JSON.parse(result.stderr);
  assert.equal(report.checks_passed, false);
  assert.equal(report.activation_complete, false);
  assert.equal(report.error, "unexpected_calendar_state");
  assert.deepEqual(seenKeys, [key]);
  assert.equal(report.evidence.http_status, 200);
  assert.equal(report.evidence.state, "error");
  assert.equal(report.evidence.error_code, "source_unavailable");
  assert.equal(report.evidence.source_succeeded_at, "2026-10-19T18:00:00.000Z");
  assert.equal(report.evidence.raw_response_utf8_bytes, Buffer.byteLength(body));
  assert.equal(report.evidence.combined_polling_utf8_bytes, Buffer.byteLength(body));
  assert.equal(report.evidence.measured_before_probes, true);
  assert.equal(report.evidence.cold_start_confirmed, false);
  assert.equal(report.evidence.retry_used, false);
  assert.equal(report.evidence.attempts.length, 1);
  assert.equal(report.evidence.attempts[0].http_status, 200);
  assert.ok(report.evidence.attempts[0].elapsed_ms > 0 && report.evidence.attempts[0].elapsed_ms < 10_000);
  assert.doesNotMatch(result.stderr, /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY|occurrences|label|rules_json/);
});

test("an impossible source-success date is not normalized into trusted first-poll evidence", async t => {
  const agenda = structuredClone(current);
  agenda.state = "error";
  agenda.source_succeeded_at = "2026-02-30T18:00:00Z";
  agenda.primary.eligible_total = null;
  agenda.secondary.eligible_total = null;
  agenda.error = { code: "source_unavailable", message: "CONFIDENTIAL_RAW_EXCEPTION" };
  let polls = 0;
  const endpoint = await serve(t, (_request, response) => {
    polls++;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });

  const result = await smokeCli(t, endpoint);
  const report = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(report.error, "invalid_source_success_time");
  assert.equal(report.evidence.source_succeeded_at, null);
  assert.equal(report.evidence.state, "unknown");
  assert.equal(report.evidence.error_code, "unknown");
  assert.equal(report.evidence.attempts[0].http_status, 200);
  assert.equal(polls, 1);
  assert.doesNotMatch(result.stderr, /CONFIDENTIAL|2026-0[23]|SYNTHETIC_FUNCTION_SCOPED_KEY/);
});

test("a mismatched expected error stays RED with only allowlisted first-poll evidence fields", async t => {
  const agenda = unavailable();
  agenda.source_succeeded_at = null;
  agenda.primary.label = "CONFIDENTIAL_PRIMARY_DATE_LABEL";
  const body = JSON.stringify(agenda, null, 2);
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });

  const result = await smokeCli(t, endpoint, [
    "--expected-state", "error", "--expected-code", "source_invalid"
  ]);
  const report = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(report.checks_passed, false);
  assert.equal(report.activation_complete, false);
  assert.equal(report.error, "unexpected_calendar_error");
  assert.deepEqual(Object.keys(report.evidence).sort(), [
    "attempts", "cold_start_confirmed", "combined_polling_utf8_bytes", "error_code", "http_status",
    "measured_before_probes", "raw_response_utf8_bytes", "retry_used", "source_succeeded_at", "state"
  ]);
  assert.equal(report.evidence.state, "error");
  assert.equal(report.evidence.error_code, "source_unavailable");
  assert.equal(report.evidence.source_succeeded_at, null);
  assert.equal(report.evidence.raw_response_utf8_bytes, Buffer.byteLength(body));
  assert.equal(report.evidence.combined_polling_utf8_bytes, Buffer.byteLength(JSON.stringify(agenda)));
  assert.ok(report.evidence.raw_response_utf8_bytes > report.evidence.combined_polling_utf8_bytes);
  assert.deepEqual(Object.keys(report.evidence.attempts[0]).sort(), ["elapsed_ms", "http_status"]);
  assert.deepEqual(seenKeys, [key]);
  assert.doesNotMatch(result.stderr, /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY|occurrences|label|message|rules_json/);
});

test("unexpected current and stale states retain safe actual state without disclosing commitments", async t => {
  let agenda;
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });
  for (const state of ["current", "stale"]) {
    agenda = structuredClone(current);
    agenda.state = state;
    agenda.primary.label = "CONFIDENTIAL_PRIMARY_DATE_LABEL";
    agenda.primary.eligible_total = 1;
    agenda.primary.occurrences = [{
      time_kind: "all_day", id: "CONFIDENTIAL_RECORD_ID", title: "CONFIDENTIAL_CALENDAR_TITLE",
      participation_expectation: "unknown",
      location: "CONFIDENTIAL_LOCATION", start_date: "2026-10-19", end_date_exclusive: "2026-10-20"
    }];
    if (state === "stale") {
      agenda.generated_at = "2026-10-19T18:30:00Z";
      agenda.error = { code: "source_unavailable", message: "CONFIDENTIAL_RAW_EXCEPTION" };
    }
    const result = await smokeCli(t, endpoint, state === "current"
      ? ["--expected-state", "error", "--expected-code", "source_unavailable"] : []);
    const report = JSON.parse(result.stderr);

    assert.equal(result.status, 1);
    assert.equal(report.checks_passed, false);
    assert.equal(report.activation_complete, false);
    assert.equal(report.error, "unexpected_calendar_state");
    assert.equal(report.evidence.state, state);
    assert.equal(report.evidence.error_code, state === "current" ? null : "source_unavailable");
    assert.equal(report.evidence.source_succeeded_at, "2026-10-19T18:00:00.000Z");
    assert.equal(report.evidence.combined_polling_utf8_bytes, Buffer.byteLength(JSON.stringify(agenda)));
    assert.equal(report.evidence.attempts.length, 1);
    assert.doesNotMatch(result.stderr, /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY|title|location|occurrences|label/);
  }
  assert.deepEqual(seenKeys, [key, key]);
});

test("regex-shaped private unknown error codes become a fixed marker and cannot be expected into success", async t => {
  const agenda = unavailable();
  const privateCode = "private_calendar_rule_and_source_key";
  agenda.error.code = privateCode;
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });

  const result = await smokeCli(t, endpoint, [
    "--expected-state", "error", "--expected-code", "source_unavailable"
  ]);
  const report = JSON.parse(result.stderr);
  assert.equal(result.status, 1);
  assert.equal(report.error, "unexpected_calendar_error");
  assert.equal(report.evidence.state, "error");
  assert.equal(report.evidence.error_code, "unknown");
  assert.equal(report.evidence.source_succeeded_at, "2026-10-19T18:00:00.000Z");
  const invalid = await smokeCli(t, endpoint, ["--expected-state", "error", "--expected-code", privateCode]);
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error, "invalid_expectation");
  assert.deepEqual(seenKeys, [key]);
  assert.doesNotMatch(result.stderr + invalid.stderr,
    /private_calendar_rule_and_source_key|CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY/);
});

test("malformed or unknown first responses retain transport evidence but no unvalidated calendar fields", async t => {
  const cases = [
    ["invalid_polling_json", "CONFIDENTIAL_INVALID_JSON_AND_RAW_SOURCE"],
    ["invalid_polling_contract", null],
    ["invalid_polling_contract", [current]],
    ["invalid_polling_contract", { ...unavailable(), state: "private_calendar_state" }],
    ["invalid_polling_contract", { ...unavailable(), schema_version: 1 }],
    ["invalid_polling_contract", { ...unavailable(), schema_version: 3 }],
    ["invalid_polling_contract", {
      ...agendaWithOccurrence(), primary: { ...agendaWithOccurrence().primary,
        occurrences: [{ ...agendaWithOccurrence().primary.occurrences[0], participation_expectation: undefined }] }
    }],
    ["invalid_polling_contract", {
      ...agendaWithOccurrence("not-a-level"), primary: agendaWithOccurrence("not-a-level").primary
    }],
    ["invalid_polling_contract", { ...unavailable(), source_url: "CONFIDENTIAL_SOURCE_URL" }],
    ["invalid_polling_contract", { ...unavailable(), error: { code: { private: "CONFIDENTIAL" }, message: "CONFIDENTIAL" } }],
    ["invalid_polling_contract", { ...unavailable(), generated_at: "2026-10-19T24:00:00Z" }],
    ["invalid_polling_contract", { ...unavailable(), primary: { ...unavailable().primary, date: "2026-02-30" } }],
    ["invalid_source_success_time", { ...unavailable(), source_succeeded_at: "CONFIDENTIAL_SOURCE_SUCCESS" }],
    ["invalid_source_success_time", { ...unavailable(), source_succeeded_at: "2026-10-19T24:00:00Z" }],
    ["invalid_source_success_time", {
      ...current, state: "stale", generated_at: "2026-10-19T19:00:00Z",
      error: { code: "source_unavailable", message: "CONFIDENTIAL_EXPIRED_STALE" }
    }]
  ];
  let body;
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(200, { "Content-Type": "application/json" }).end(body);
  });

  for (const [code, data] of cases) {
    body = typeof data === "string" ? data : JSON.stringify(data);
    const result = await smokeCli(t, endpoint);
    const report = JSON.parse(result.stderr);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(report.checks_passed, false);
    assert.equal(report.activation_complete, false);
    assert.equal(report.error, code);
    assert.equal(report.evidence.http_status, 200);
    assert.equal(report.evidence.state, "unknown");
    assert.equal(report.evidence.error_code, "unknown");
    assert.equal(report.evidence.source_succeeded_at, null);
    assert.equal(report.evidence.raw_response_utf8_bytes, Buffer.byteLength(body));
    assert.equal(report.evidence.combined_polling_utf8_bytes, undefined);
    assert.equal(report.evidence.attempts.length, 1);
    assert.equal(report.evidence.attempts[0].http_status, 200);
    assert.ok(report.evidence.attempts[0].elapsed_ms > 0 && report.evidence.attempts[0].elapsed_ms < 10_000);
    assert.equal(report.evidence.retry_used, false);
    assert.equal(report.evidence.measured_before_probes, true);
    assert.doesNotMatch(result.stderr, /CONFIDENTIAL|private_calendar_state|SYNTHETIC_FUNCTION_SCOPED_KEY|occurrences|label/);
  }
  assert.deepEqual(seenKeys, cases.map(() => key));
});

test("an unexpected calendar error after one HTTP retry retains both attempts and never probes auth", async t => {
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    if (seenKeys.length === 1) {
      response.writeHead(503).end("CONFIDENTIAL_UPSTREAM_EXCEPTION_AND_SOURCE_URL");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(unavailable()));
  });

  const result = await smokeCli(t, endpoint);
  const report = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(report.error, "unexpected_calendar_state");
  assert.equal(report.evidence.retry_used, true);
  assert.deepEqual(report.evidence.attempts.map(attempt => attempt.http_status), [503, 200]);
  assert.ok(report.evidence.attempts.every(attempt => attempt.elapsed_ms > 0 && attempt.elapsed_ms < 10_000));
  assert.equal(report.evidence.state, "error");
  assert.equal(report.evidence.error_code, "source_unavailable");
  assert.deepEqual(seenKeys, [key, key]);
  assert.doesNotMatch(result.stderr, /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY/);
});

test("scheduled-refresh failures preserve allowlisted first evidence and cannot be mislabeled current", async t => {
  let code;
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    const agenda = unavailable();
    agenda.error.code = code;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });
  for (code of ["refresh_missing", "refresh_delayed", "refresh_incomplete"]) {
    const result = await smokeCli(t, endpoint);
    const report = JSON.parse(result.stderr);
    assert.equal(result.status, 1);
    assert.equal(report.error, "unexpected_calendar_state");
    assert.equal(report.checks_passed, false);
    assert.equal(report.activation_complete, false);
    assert.equal(report.evidence.error_code, code);
    assert.equal(report.evidence.attempts.length, 1);
    assert.equal(report.evidence.measured_before_probes, true);
    assert.doesNotMatch(result.stderr, /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY/);
  }
  assert.deepEqual(seenKeys, [key, key, key]);
});

test("the smoke contract rejects current at exactly fifteen minutes without warming auth probes", async t => {
  const agenda = structuredClone(current);
  agenda.generated_at = "2026-10-19T18:15:00Z";
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });

  const result = await smokeCli(t, endpoint);
  const report = JSON.parse(result.stderr);

  assert.equal(result.status, 1);
  assert.equal(report.error, "invalid_source_success_time");
  assert.equal(report.evidence.state, "unknown");
  assert.equal(report.evidence.source_succeeded_at, null);
  assert.deepEqual(seenKeys, [key]);
});

test("freshness validation preserves native seven-digit timestamp boundaries rather than rounding to milliseconds", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  const agenda = structuredClone(current);
  agenda.source_succeeded_at = "2026-10-19T18:00:00.0000001Z";
  const endpoint = await serve(t, (request, response) => {
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });

  agenda.generated_at = "2026-10-19T18:15:00.0000000Z";
  const currentReport = await smokeDelivery({ endpoint, key, syntheticLocal: true });
  assert.equal(currentReport.poll.state, "current");
  agenda.state = "stale";
  agenda.error = { code: "source_unavailable", message: "Safe synthetic failure." };
  agenda.generated_at = "2026-10-19T19:00:00.0000000Z";
  const staleReport = await smokeDelivery({
    endpoint, key, syntheticLocal: true, expectedState: "stale", expectedCode: "source_unavailable"
  });
  assert.equal(staleReport.poll.state, "stale");
  agenda.state = "current";
  agenda.error = null;
  agenda.generated_at = "2026-10-19T18:00:00.0000000Z";
  await assert.rejects(smokeDelivery({ endpoint, key, syntheticLocal: true }),
    { code: "invalid_source_success_time" });
});

test("smoke checks absent, wrong and function-scoped headers without claiming live activation", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  const seenKeys = new Set();
  const endpoint = await serve(t, (request, response) => {
    seenKeys.add(request.headers["x-functions-key"]);
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(current));
  });
  const report = await smokeDelivery({ endpoint, key, syntheticLocal: true });

  assert.equal(report.checks_passed, true);
  assert.equal(report.evidence_scope, "local_synthetic");
  assert.equal(report.activation_complete, false);
  assert.equal(report.authentication.missing_key_status, 401);
  assert.equal(report.authentication.wrong_key_status, 401);
  assert.equal(report.poll.state, "current");
  assert.equal(report.poll.combined_polling_utf8_bytes, Buffer.byteLength(JSON.stringify(current)));
  assert.ok(seenKeys.has(undefined) && seenKeys.has(key) && seenKeys.size === 3);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_FUNCTION_SCOPED_KEY|occurrences|Monday/);
});

test("polling allows one transport retry and records the failed attempt rather than its private body", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  let polls = 0;
  const endpoint = await serve(t, (request, response) => {
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(403).end();
      return;
    }
    if (++polls === 1) {
      response.writeHead(503).end("CONFIDENTIAL_UPSTREAM_EXCEPTION_AND_URL");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(current));
  });

  const report = await smokeDelivery({ endpoint, key, syntheticLocal: true });

  assert.equal(report.poll.retry_used, true);
  assert.equal(polls, 2);
  assert.deepEqual(report.poll.attempts.map(attempt => attempt.http_status), [503, 200]);
  assert.doesNotMatch(JSON.stringify(report), /CONFIDENTIAL|SYNTHETIC_FUNCTION_SCOPED_KEY/);
});

test("native single-URL combined polling data accepts 99,999 UTF-8 bytes and rejects exactly 100,000", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  const agenda = structuredClone(current);
  agenda.primary.eligible_total = 1;
  agenda.primary.occurrences = [{
    time_kind: "all_day", id: "synthetic", title: "", location: null,
    participation_expectation: "unknown",
    start_date: "2026-10-19", end_date_exclusive: "2026-10-20"
  }];
  const overhead = Buffer.byteLength(JSON.stringify(agenda));
  let targetSize = 99_999;
  const endpoint = await serve(t, (request, response) => {
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    agenda.primary.occurrences[0].title = "A".repeat(targetSize - overhead);
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });

  const report = await smokeDelivery({ endpoint, key, syntheticLocal: true });
  assert.equal(report.poll.combined_polling_utf8_bytes, 99_999);
  targetSize = 100_000;
  await assert.rejects(smokeDelivery({ endpoint, key, syntheticLocal: true }), error => {
    assert.equal(error.code, "combined_polling_too_large");
    assert.equal(error.evidence.combined_polling_utf8_bytes, 100_000);
    return true;
  });
});

test("a response rescued by the one retry does not excuse a first attempt over ten seconds", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  let polls = 0;
  let requests = 0;
  const endpoint = await serve(t, (request, response) => {
    requests++;
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    if (++polls === 1) {
      setTimeout(() => response.writeHead(200).end(JSON.stringify(current)), 10_500).unref();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(current));
  });
  const started = performance.now();

  await assert.rejects(smokeDelivery({ endpoint, key, syntheticLocal: true }), error => {
    assert.equal(error.code, "polling_budget_exceeded");
    assert.equal(error.evidence.attempts[0].error, "attempt_over_budget");
    assert.equal(error.evidence.attempts[1].http_status, 200);
    assert.ok(error.evidence.attempts[0].elapsed_ms >= 9_900);
    assert.ok(error.evidence.attempts[1].elapsed_ms > 0 && error.evidence.attempts[1].elapsed_ms < 10_000);
    return true;
  });
  assert.equal(polls, 2);
  assert.equal(requests, 2);
  assert.ok(performance.now() - started >= 9_900);
});

test("the measured authorized poll is the first request, before probes can warm a cold host", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  const seenKeys = [];
  const endpoint = await serve(t, (request, response) => {
    seenKeys.push(request.headers["x-functions-key"]);
    response.writeHead(request.headers["x-functions-key"] === key ? 200 : 401,
      { "Content-Type": "application/json" }).end(JSON.stringify(current));
  });

  await smokeDelivery({ endpoint, key, syntheticLocal: true });

  assert.equal(seenKeys[0], key);
});

test("edited rule text travels as a string and a renderable configuration error is not called fresh", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  const rulesJson = 'CONFIDENTIAL_EDITED_RULE\n"},"rules_json":"[]"';
  const broken = structuredClone(current);
  broken.state = "error";
  broken.source_succeeded_at = null;
  broken.primary.eligible_total = null;
  broken.secondary.eligible_total = null;
  broken.error = { code: "configuration_invalid", message: "Rule configuration is missing or malformed." };
  let transported;
  const endpoint = await serve(t, async (request, response) => {
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    transported = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(transported.rules_json === rulesJson ? broken : current));
  });

  const report = await smokeDelivery({
    endpoint, key, syntheticLocal: true, rulesJson,
    expectedState: "error", expectedCode: "configuration_invalid"
  });

  assert.deepEqual(transported, { rules_json: rulesJson });
  assert.equal(report.poll.state, "error");
  assert.equal(report.poll.error_code, "configuration_invalid");
  assert.equal(report.poll.source_succeeded_at, null);
  assert.equal(report.activation_complete, false);
  assert.doesNotMatch(JSON.stringify(report), /CONFIDENTIAL|rules_json/);
});

test("an error cannot claim healthy zero counts or include extra private source fields", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  let agenda = structuredClone(current);
  agenda.state = "error";
  agenda.source_succeeded_at = null;
  agenda.error = { code: "source_unavailable", message: "The calendar source could not be checked." };
  const endpoint = await serve(t, (request, response) => {
    if (request.headers["x-functions-key"] !== key) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agenda));
  });
  const options = {
    endpoint, key, syntheticLocal: true, expectedState: "error", expectedCode: "source_unavailable"
  };

  await assert.rejects(smokeDelivery(options), { code: "invalid_polling_contract" });
  agenda.primary.eligible_total = null;
  agenda.secondary.eligible_total = null;
  const report = await smokeDelivery(options);
  assert.equal(report.poll.state, "error");
  agenda.source_url = "https://synthetic.invalid/CONFIDENTIAL_SOURCE_CREDENTIAL";
  await assert.rejects(smokeDelivery(options), error => {
    assert.equal(error.code, "invalid_polling_contract");
    assert.doesNotMatch(JSON.stringify(error.evidence) + error.message, /CONFIDENTIAL/);
    return true;
  });
});

test("a bodyless HTTP rejection is reported by status and is not retried as a transport exception", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  let polls = 0;
  const endpoint = await serve(t, (_request, response) => {
    polls++;
    response.writeHead(204).end();
  });

  await assert.rejects(smokeDelivery({ endpoint, key, syntheticLocal: true }), error => {
    assert.equal(error.code, "authorized_poll_rejected");
    assert.equal(error.evidence.attempts[0].http_status, 204);
    return true;
  });
  assert.equal(polls, 1);
});
