import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("the public Node reporter retains nested fixture costs without inventing elapsed totals or leaking errors", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda timing "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "fixture.test.mjs");
  await writeFile(source, `
    import test from "node:test";
    test("fixture matrix", async t => {
      await t.test("first selector", () => {});
      await t.test("second selector", () => { throw new Error("CONFIDENTIAL fixture input"); });
    });
  `);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test",
    `--test-reporter=${pathToFileURL(join(root, "scripts", "node-timing-reporter.mjs")).href}`, source],
  { encoding: "utf8", timeout: 15_000, env: environment });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  const tests = events.filter(event => event.kind === "test");
  assert.equal(tests.length, 3);
  assert.equal(tests.filter(event => event.nesting === 0).length, 1);
  assert.equal(tests.filter(event => event.nesting === 1).length, 2);
  assert.ok(tests.every(event => event.duration_ms >= 0));
  assert.equal(events.at(-1).kind, "summary");
  assert.equal(events.at(-1).failed, 2);
  assert.ok(!result.stdout.includes("CONFIDENTIAL"));
  assert.ok(!result.stdout.includes("elapsed_total"));
});

test("the public workbench reports Ruby spawn errors and deadline termination as failures, not supersession", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda workbench timing "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["scripts", "display"])
    await cp(join(root, name), join(directory, name), { recursive: true });
  await mkdir(join(directory, "docs"));
  await cp(join(root, "docs", "agenda-contract.md"), join(directory, "docs", "agenda-contract.md"));
  for (const asset of ["css/3.4.3/plugins.css", "js/3.4.3/plugins.js", "fonts/synthetic.woff2"]) {
    const path = join(directory, ".tools", "framework", ...asset.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset.endsWith(".css") ? '@font-face{src:url("/fonts/synthetic.woff2")}' : "synthetic");
  }
  await writeFile(join(directory, "empty.gitconfig"), "");
  const environment = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty.gitconfig")
  });
  for (const args of [
    ["init", "--quiet", "--template="], ["add", "."],
    ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic baseline"]
  ]) {
    const result = spawnSync("git", args, { cwd: directory, env: environment, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const preload = join(directory, "external-ruby.mjs");
  await writeFile(preload, `
    import tools from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { promisify } from "node:util";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    const execute = promisify(tools.execFile);
    const spawn = tools.spawn;
    tools.execFile = Object.assign(() => {}, {
      [promisify.custom]: (command, ...args) => command === "synthetic-ruby"
        ? Promise.resolve({ stdout: "4.0.0", stderr: "" }) : execute(command, ...args)
    });
    tools.spawn = (command, args, options) => {
      if (command !== "synthetic-ruby") return spawn(command, args, options);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; };
      if (!process.env.SYNTHETIC_RUBY_TIMEOUT) queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("synthetic missing executable"), { code: "ENOENT" }));
        child.emit("close", 1);
      });
      return child;
    };
    syncBuiltinESMExports();
  `);
  for (const timeout of [false, true]) {
    const reports = join(directory, `reports-${timeout}`);
    await mkdir(reports);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href,
      join(directory, "scripts", "agenda-workbench.mjs"), "--workspace", directory, "--port", "0"],
    {
      cwd: directory,
      env: { ...environment, TRMNL_RUBY: "synthetic-ruby", TRMNL_TIMING_DIRECTORY: reports,
        SYNTHETIC_RUBY_TIMEOUT: timeout ? "1" : "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    try {
      const lines = createInterface({ input: child.stdout });
      const signal = AbortSignal.timeout(35_000);
      const line = await Promise.race([
        once(lines, "line", { signal }).then(([value]) => value),
        once(child, "exit", { signal }).then(() => { throw new Error(diagnostics); })
      ]);
      const { url } = JSON.parse(line);
      const response = await fetch(new URL("/api/comparison?scenario=reference&target=og-full", url),
        { signal: AbortSignal.timeout(25_000) });
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, timeout ? /timed out/ : /Could not start Ruby/);
      const files = await readdir(reports);
      const events = (await Promise.all(files.map(file => readFile(join(reports, file), "utf8"))))
        .join("").trim().split(/\r?\n/).map(JSON.parse);
      const ends = events.filter(event => event.kind === "end");
      assert.ok(ends.length > 0);
      assert.ok(ends.every(event => event.result === "failed"), JSON.stringify(ends));
      assert.ok(ends.every(event => event.terminated === timeout));
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }
});
