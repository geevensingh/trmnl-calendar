import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scenarios = [
  ["validation.test.mjs", "public reports bind exact event/evaluated identities"],
  ["timing.test.mjs", "workbench timing end failures"]
];
const outcomes = [
  { name: "timeout", status: null, signal: "SIGTERM", code: "ETIMEDOUT" },
  { name: "launch", status: null, signal: null, code: "ENOENT" },
  { name: "buffer", status: null, signal: "SIGTERM", code: "ENOBUFS" },
  { name: "exit", status: 128, signal: null, code: null },
  { name: "signal", status: null, signal: "SIGTERM", code: null },
  { name: "error-with-zero-status", status: 0, signal: null, code: "ENOBUFS" }
];

test("both reported Git fixture paths preserve safe failure diagnostics without retrying", async t => {
  for (const [file, pattern] of scenarios) {
    for (const outcome of outcomes) {
      await t.test(`${file}: ${outcome.name}`, () => {
        const injection = `
          import assert from "node:assert/strict";
          import tools from "node:child_process";
          import { syncBuiltinESMExports } from "node:module";
          import { join } from "node:path";
          const original = tools.spawnSync;
          const outcome = ${JSON.stringify(outcome)};
          tools.spawnSync = (command, args, options) => {
            if (command !== "git" || args[0] !== "add") return original(command, args, options);
            assert.equal(options.timeout, 10_000);
            assert.equal(options.encoding, "utf8");
            assert.equal(options.env.GIT_INDEX_FILE, undefined);
            assert.equal(options.env.GIT_FUTURE_SELECTOR, undefined);
            assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
            assert.equal(options.env.GIT_CONFIG_GLOBAL, join(options.cwd, "empty.gitconfig"));
            process.stderr.write("fixture Git attempt\\n");
            return {
              status: outcome.status, signal: outcome.signal,
              stdout: "CONFIDENTIAL fixture stdout", stderr: "CONFIDENTIAL fixture stderr",
              error: outcome.code ? Object.assign(new Error("CONFIDENTIAL process message"), {
                code: outcome.code, path: "CONFIDENTIAL executable path",
                spawnargs: ["CONFIDENTIAL arguments"]
              }) : undefined
            };
          };
          syncBuiltinESMExports();
        `;
        const env = {
          ...process.env, GIT_INDEX_FILE: "CONFIDENTIAL owner index",
          GIT_FUTURE_SELECTOR: "CONFIDENTIAL future selector"
        };
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, [
          "--import", `data:text/javascript,${encodeURIComponent(injection)}`,
          "--test", `--test-name-pattern=^${pattern}`,
          join(root, "tests", "validation", file)
        ], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
        assert.equal(result.error, undefined);
        const output = result.stdout + result.stderr;
        assert.equal(result.status, 1, output);
        assert.equal(output.match(/fixture Git attempt/g)?.length, 1, output);
        assert.doesNotMatch(output, /CONFIDENTIAL/);
        const diagnostic = output.match(/Git fixture failed: (\{[^\r\n]+\})/);
        assert.ok(diagnostic, "Fixture failure must report structured process metadata.");
        const report = JSON.parse(diagnostic[1]);
        assert.deepEqual(Object.keys(report), [
          "command", "operation", "status", "signal", "error_code", "elapsed_ms", "timeout_ms"
        ]);
        assert.equal(report.command, "git");
        assert.equal(report.operation, "add");
        assert.equal(report.status, outcome.status);
        assert.equal(report.signal, outcome.signal);
        assert.equal(report.error_code, outcome.code);
        assert.ok(Number.isFinite(report.elapsed_ms) && report.elapsed_ms >= 0);
        assert.equal(report.timeout_ms, 10_000);
        assert.match(output, /\bfail 1\b/);
        assert.match(output, /\bpass 0\b/);
      });
    }
  }
});
