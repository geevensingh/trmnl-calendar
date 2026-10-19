import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

const key = "SYNTHETIC_FUNCTION_SCOPED_KEY";
const current = {
  schema_version: 1,
  state: "current",
  time_zone: "America/Los_Angeles",
  generated_at: "2026-10-19T18:00:00Z",
  source_succeeded_at: "2026-10-19T18:00:00Z",
  primary: { date: "2026-10-19", label: "Monday, Oct 19", eligible_total: 0, occurrences: [] },
  secondary: { date: "2026-10-20", label: "Tuesday, Oct 20", eligible_total: 0, occurrences: [] },
  error: null
};

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
  await assert.rejects(smokeDelivery({ endpoint, key, syntheticLocal: true }),
    { code: "combined_polling_too_large", evidence: { combined_polling_utf8_bytes: 100_000 } });
});

test("a response rescued by the one retry does not excuse a first attempt over ten seconds", async t => {
  const { smokeDelivery } = await import("../../scripts/smoke-delivery.mjs");
  let polls = 0;
  const endpoint = await serve(t, (request, response) => {
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
    return true;
  });
  assert.equal(polls, 2);
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
