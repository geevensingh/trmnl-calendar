import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkout } from "./display-toolchain-fixture.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function setupCommands(directory) {
  const project = join(directory, "tests", "CalendarAgenda.Tests", "CalendarAgenda.Tests.csproj");
  const browserCheck = ["screenshot", "--browser", "chromium", "--timeout", 15000, "about:blank"];
  return [
    ["dotnet", "--version"],
    ["bundle", "config", "set", "--local", "path", "vendor/bundle"],
    ["bundle", "config", "set", "--local", "frozen", "true"],
    ["bundle", "config", "set", "--local", "disable_shared_gems", "true"],
    ["bundle", "check"],
    ["bundle", "install", "--quiet"],
    ["download", "https://trmnl.com/css/3.4.3/plugins.css"],
    ["download", "https://trmnl.com/js/3.4.3/plugins.js"],
    ["download", "https://trmnl.com/fonts/bundles/trmnl/trmnl-fonts-bundle--trmnl.zip"],
    ["extract", "trmnl-fonts.zip"],
    ["download", "https://trmnl.com/fonts/bundles/classic/trmnl-fonts-bundle--classic.zip"],
    ["extract", "classic-fonts.zip"],
    ["dotnet", "restore", project, "--nologo", "--verbosity", "quiet"],
    ["dotnet", "build", project, "--no-restore", "--nologo", "--verbosity", "quiet"],
    ["playwright", ...browserCheck],
    ["dotnet", "fixture-playwright.dll", ...browserCheck],
    ["playwright", "install", "chromium"],
    ["dotnet", "fixture-playwright.dll", "install", "chromium"],
    ["playwright", ...browserCheck],
    ["dotnet", "fixture-playwright.dll", ...browserCheck]
  ];
}

function setupCalls(calls) {
  return calls.flatMap(call => {
    if (call.tool === "ruby" && call.arguments[1].includes("Gem.bin_path"))
      return [["bundle", ...call.arguments.slice(3)]];
    if (call.tool === "download") return [["download", call.uri]];
    if (call.tool === "extract") return [["extract", basename(call.archive)]];
    if (call.tool === "dotnet" || call.tool === "playwright")
      return [[call.tool, ...(call.arguments.includes("screenshot") ? call.arguments.slice(0, -1) : call.arguments)]];
    return [];
  });
}

test("display setup suppresses certificate generation before the first SDK call in a fresh SDK home", async t => {
  const fixture = await checkout(t);
  assert.deepEqual(await readdir(fixture.sdkHome), []);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = (await fixture.calls()).filter(call => call.tool === "dotnet");
  const first = calls[0];
  assert.deepEqual({
    sdkHome: first.sdkHome,
    firstRun: first.firstRun,
    certificateGeneration: first.certificate,
    certificateAttempt: first.certificateAttempt
  }, {
    sdkHome: fixture.sdkHome,
    firstRun: true,
    certificateGeneration: "false",
    certificateAttempt: false
  });
  assert.deepEqual(calls.map(call => call.arguments[0]), [
    "--version", "restore", "build", "fixture-playwright.dll", "fixture-playwright.dll", "fixture-playwright.dll"
  ]);
  assert.ok(calls.every(call => call.certificate === "false"));
  assert.ok(calls.every(call => !call.certificateAttempt));
});

test("display setup overrides inherited certificate generation for every SDK call and repeated runs", async t => {
  const fixture = await checkout(t);
  const names = ["DOTNET_GENERATE_ASPNET_CERTIFICATE", "DOTNET_CLI_HOME", "TRMNL_RUBY", "PATH"];
  const parentEnvironment = names.map(name => process.env[name]);
  assert.deepEqual(await readdir(fixture.sdkHome), []);
  for (let run = 0; run < 2; run++) {
    const result = fixture.run({ DOTNET_GENERATE_ASPNET_CERTIFICATE: "true" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { before, after } = await fixture.environment();
    assert.deepEqual(after, before);
  }
  const calls = (await fixture.calls()).filter(call => call.tool === "dotnet");
  assert.deepEqual(calls.map(call => call.arguments[0]), [
    "--version", "restore", "build", "fixture-playwright.dll", "fixture-playwright.dll", "fixture-playwright.dll",
    "--version", "restore", "build", "fixture-playwright.dll"
  ]);
  assert.deepEqual(calls.map(call => call.firstRun), [true, ...Array(9).fill(false)]);
  for (const call of calls) {
    assert.equal(call.sdkHome, fixture.sdkHome);
    assert.equal(call.certificate, "false");
    assert.equal(call.certificateAttempt, false);
  }
  assert.deepEqual(names.map(name => process.env[name]), parentEnvironment);
});

test("successful display setup preserves Bundler, framework, restore, build, and Chromium installation", async t => {
  const fixture = await checkout(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    setupCalls(await fixture.calls()),
    setupCommands(fixture.directory)
  );
});

test("public setup reports observed cache reuse, stage durations and failure without environment dumps", async t => {
  const fixture = await checkout(t);
  for (const failure of [undefined, "dotnet:restore"]) {
    const result = fixture.run(failure ? { DISPLAY_FAIL: failure } : {});
    assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
    const reportPath = result.stdout.match(/Timing report: (.+)/)?.[1].trim();
    assert.ok(reportPath, result.stdout + result.stderr);
    const report = JSON.parse(await readFile(join(reportPath, "summary.json"), "utf8"));
    assert.equal(report.scope, "Setup");
    assert.equal(report.outcome, failure ? "failed" : "passed");
    assert.ok(report.duration_ms >= Math.max(...report.stages.map(stage => stage.duration_ms)));
    assert.ok(report.stages.every(stage => ["passed", "failed"].includes(stage.result)));
    assert.equal(report.provenance.cache.bundler_reused, Boolean(failure));
    assert.ok(!JSON.stringify(report).includes("BUNDLE_USER_CACHE"));
  }
});

test("display setup reports failed stages and stops before dependent commands", async t => {
  for (const [failure, message, completed] of [
    ["dotnet:--version", ".NET 10 SDK", 1],
    ["bundle-config", "Bundler configuration failed.", 2],
    ["bundle-install", "gem restore failed.", 6],
    ["dotnet:restore", "dependency restore failed.", 13],
    ["dotnet:build", "Display harness build failed.", 14],
    ["browser-install", "Chromium setup failed.", 18],
    ["dotnet:fixture-playwright.dll", "Chromium setup failed.", 18]
  ]) {
    await t.test(failure, async t => {
      const fixture = await checkout(t);
      const result = fixture.run({ DISPLAY_FAIL: failure, DOTNET_GENERATE_ASPNET_CERTIFICATE: "true" });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(message), result.stdout + result.stderr);
      assert.deepEqual(
        setupCalls(await fixture.calls()),
        setupCommands(fixture.directory).slice(0, completed)
      );
      const { before, after } = await fixture.environment();
      assert.deepEqual(after, before);
    });
  }
});

test("the documented Fast-only restore suppresses first-run certificates without display tooling", async t => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  const instructions = readme.match(/For Fast-only work,([\s\S]*?)For Full validation,/);
  assert.ok(instructions, "Missing Fast-only setup instructions in README.md");
  const block = instructions[1].match(/```powershell\r?\n([\s\S]*?)```/);
  assert.ok(block, "Fast-only restore must have an executable PowerShell command block");
  for (const generation of [undefined, "true"]) {
    await t.test(generation ?? "absent", async t => {
      const fixture = await checkout(t);
      await rm(join(fixture.directory, "scripts"), { recursive: true });
      await rm(join(fixture.directory, "tests", "CalendarAgenda.Tests", "bin"), { recursive: true });
      const restore = join(fixture.directory, "fast-restore.ps1");
      await writeFile(restore, block[1]);
      assert.deepEqual(await readdir(fixture.sdkHome), []);
      const environment = { DISPLAY_SCRIPT: restore, TRMNL_RUBY: "missing-synthetic-ruby", DISPLAY_MISSING_RUBY: "1" };
      if (generation !== undefined) environment.DOTNET_GENERATE_ASPNET_CERTIFICATE = generation;
      const result = fixture.run(environment);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(await fixture.calls(), [{
        tool: "dotnet",
        arguments: ["restore", ".\\tests\\CalendarAgenda.Tests\\CalendarAgenda.Tests.csproj"],
        sdkHome: fixture.sdkHome,
        firstRun: true,
        certificate: "false",
        certificateAttempt: false
      }]);
    });
  }
});
