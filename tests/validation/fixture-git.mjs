import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function fixtureGit(args, { cwd, env }) {
  const timeout = 10_000;
  const started = performance.now();
  const result = spawnSync("git", args, {
    cwd, env, encoding: "utf8", timeout
  });
  const elapsed = Math.round(performance.now() - started);
  if (result.error || result.status !== 0 || result.signal !== null) {
    const operation = args.find(arg => ["init", "add", "commit", "rev-parse", "update-index"].includes(arg)) ?? "unknown";
    const report = {
      command: "git", operation, status: result.status, signal: result.signal,
      error_code: result.error ? (/^[A-Z][A-Z0-9_]{0,31}$/.test(result.error.code) ? result.error.code : "UNKNOWN") : null,
      elapsed_ms: elapsed, timeout_ms: timeout
    };
    assert.fail(`Git fixture failed: ${JSON.stringify(report)}`);
  }
  return result.stdout.trim();
}
