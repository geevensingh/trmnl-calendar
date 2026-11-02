import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const head = "1".repeat(40);

function gate(result, extra = []) {
  return spawnSync(process.execPath, [
    join(root, "scripts", "check-required-validation.mjs"),
    "--full-result", result, "--event-name", "workflow_dispatch", "--head-commit", head,
    ...extra
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
}

test("Required validation accepts only successful Full from the current execution", () => {
  const success = gate("success");
  assert.equal(success.status, 0, success.stdout + success.stderr);
  const report = JSON.parse(success.stdout);
  assert.equal(report.required_validation_succeeded, true);
  assert.equal(report.policy_path, "full");
  assert.equal(report.evaluated_commit, head);
  assert.deepEqual(report.errors, []);

  for (const result of ["failure", "blocked", "cancelled", "skipped", "", "absent", "Success"]) {
    const failure = gate(result);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    const report = JSON.parse(failure.stderr);
    assert.equal(report.required_validation_succeeded, false);
    assert.deepEqual(report.errors, ["genuine_full_success_required"]);
    assert.equal(failure.stdout, "");
  }
});

test("Required validation rejects unknown events and missing or nonliteral dispatch pins", () => {
  for (const extra of [
    ["--event-name", ""], ["--event-name", "pull_request_target"],
    ["--head-commit", ""], ["--head-commit", "HEAD"], ["--head-commit", head.slice(0, 7)],
    ["--unknown-option", "unexpected"]
  ]) {
    const result = gate("success", extra);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stderr).required_validation_succeeded, false);
    assert.equal(result.stdout, "");
  }
});
