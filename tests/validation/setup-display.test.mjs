import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("dependency cache planning uses exact native identities without changing selected tools or foreign state", async t => {
  const fixture = await checkout(t);
  const planScript = join(fixture.directory, "scripts", "plan-dependency-cache.ps1");
  const result = fixture.run({ DISPLAY_SCRIPT: planScript, ImageOS: "win25", ImageVersion: "20261025.1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.match(plan.gems.key, /^trmnl-deps-v1-gems-[a-f0-9]{64}$/);
  assert.match(plan.framework.key, /^trmnl-deps-v1-framework-[a-f0-9]{64}$/);
  assert.equal(plan.gems.path, join(fixture.directory, "vendor", "bundle"));
  assert.equal(plan.framework.path, join(fixture.directory, ".tools", "framework"));
  assert.equal(plan.gems.restore, true);
  assert.equal(plan.framework.restore, true);
  assert.deepEqual(plan.gems.paths.map(path => path.replaceAll(fixture.directory, "<worktree>")), [
    ...["lib", "LICENSE*", "COPYING*", "BSDL", "LEGAL"].map(name =>
      join("<worktree>", "vendor", "bundle", "*", "*", "gems", "*", name)),
    join("<worktree>", "vendor", "bundle", "*", "*", "specifications", "*.gemspec"),
    join("<worktree>", "vendor", "bundle", "*", "*", "extensions", "*", "*", "*", "**", "*.so"),
    join("<worktree>", "vendor", "bundle", "*", "*", "extensions", "*", "*", "*", "gem.build_complete")
  ]);
  assert.deepEqual(plan.framework.paths.map(path => path.replaceAll(fixture.directory, "<worktree>")), [
    join("<worktree>", ".tools", "framework", "css", "3.4.3", "plugins.css"),
    join("<worktree>", ".tools", "framework", "js", "3.4.3", "plugins.js"),
    ...["woff", "woff2", "ttf"].map(extension =>
      join("<worktree>", ".tools", "framework", "fonts", "**", `*.${extension}`))
  ]);
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
});

test("cache identities invalidate changed locks, Ruby runtime or ABI, image and pinned asset acquisition", async t => {
  const fixture = await checkout(t);
  const environment = {
    DISPLAY_SCRIPT: join(fixture.directory, "scripts", "plan-dependency-cache.ps1"),
    ImageOS: "win25", ImageVersion: "20261025.1"
  };
  const plan = (extra = {}) => {
    const result = fixture.run({ ...environment, ...extra });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  };
  const original = plan();
  assert.deepEqual(plan(), original);
  for (const extra of [
    { DISPLAY_RUBY_VERSION: "4.0.1" }, { DISPLAY_NATIVE_ABI: "4.1.0" },
    { ImageVersion: "20261026.1" }
  ]) {
    const changed = plan(extra);
    assert.notEqual(changed.gems.key, original.gems.key);
  }
  for (const [file, affected] of [
    ["Gemfile", "gems"], ["Gemfile.lock", "gems"],
    [join("scripts", "setup-display.ps1"), "framework"],
    [join("scripts", "display-toolchain.ps1"), "framework"]
  ]) {
    const path = join(fixture.directory, file);
    const content = await readFile(path, "utf8");
    await writeFile(path, file === "Gemfile.lock"
      ? content.replace("oily_png (1.2.1)", "oily_png (1.2.2)")
      : `${content}\n# cache identity change\n`);
    assert.notEqual(plan()[affected].key, original[affected].key, file);
    await writeFile(path, content);
  }
  const invalid = fixture.run({ ...environment, DISPLAY_FAIL: "cache-identity" });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /native cache identity is unavailable/);
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
});

test("cache planning refuses existing worktree or linked foreign destinations without changing shared selections", async t => {
  const fixture = await checkout(t);
  const foreign = join(fixture.directory, "foreign dependencies");
  await mkdir(foreign);
  await writeFile(join(foreign, "sentinel"), "foreign bytes");
  await mkdir(join(fixture.directory, "vendor"));
  await writeFile(join(fixture.directory, "vendor", "bundle"), "existing destination");
  const result = fixture.run({
    DISPLAY_SCRIPT: join(fixture.directory, "scripts", "plan-dependency-cache.ps1"),
    BUNDLE_PATH: foreign, BUNDLE_USER_CACHE: foreign,
    PLAYWRIGHT_BROWSERS_PATH: foreign
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(plan.gems.restore, false);
  assert.equal(plan.framework.restore, true);
  await symlink(foreign, join(fixture.directory, ".tools"), process.platform === "win32" ? "junction" : "dir");
  const linked = fixture.run({ DISPLAY_SCRIPT: join(fixture.directory, "scripts", "plan-dependency-cache.ps1") });
  assert.equal(linked.status, 0, linked.stdout + linked.stderr);
  assert.equal(JSON.parse(linked.stdout.slice(linked.stdout.indexOf("{"))).framework.restore, false);
  assert.equal(await readFile(join(foreign, "sentinel"), "utf8"), "foreign bytes");
  assert.deepEqual(await readdir(foreign), ["sentinel"]);
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
});

test("cold setup and a dependency-only warm transfer both run authoritative native, build and browser readiness", async t => {
  const cold = await checkout(t);
  const coldResult = cold.run({ TRMNL_GEMS_CACHE_STATE: "not-hit", TRMNL_FRAMEWORK_CACHE_STATE: "not-hit" });
  assert.equal(coldResult.status, 0, coldResult.stdout + coldResult.stderr);
  const warm = await checkout(t);
  await cp(join(cold.directory, "vendor", "bundle", "ruby"), join(warm.directory, "vendor", "bundle", "ruby"), { recursive: true });
  await cp(join(cold.directory, ".tools", "framework"), join(warm.directory, ".tools", "framework"), { recursive: true });
  await assert.rejects(readFile(join(warm.directory, ".bundle", "config")), { code: "ENOENT" });
  const result = warm.run({ TRMNL_GEMS_CACHE_STATE: "exact-hit", TRMNL_FRAMEWORK_CACHE_STATE: "exact-hit" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = await warm.calls();
  assert.ok(calls.some(call => call.tool === "native-probe"));
  assert.ok(calls.some(call => call.tool === "ruby" && call.arguments[1].includes('require "oily_png"')));
  assert.ok(calls.some(call => call.tool === "dotnet" && call.arguments[0] === "restore"));
  assert.ok(calls.some(call => call.tool === "dotnet" && call.arguments[0] === "build"));
  assert.ok(calls.some(call => call.tool === "playwright" && call.arguments[0] === "screenshot"));
  assert.ok(calls.some(call => call.tool === "playwright" && call.arguments[0] === "install"));
  assert.ok(!calls.some(call => call.tool === "download" || call.tool === "ruby" && call.arguments.includes("install")));
  for (const [run, state, reused] of [[coldResult, "not-hit", false], [result, "exact-hit", true]]) {
    const reportPath = run.stdout.match(/Timing report: (.+)/)[1].trim();
    const report = JSON.parse(await readFile(join(reportPath, "summary.json"), "utf8"));
    assert.equal(report.provenance.cache.gems_restore, state);
    assert.equal(report.provenance.cache.framework_restore, state);
    assert.equal(report.provenance.cache.bundler_reused, reused);
    assert.equal(report.provenance.cache.fonts_reused, reused);
    assert.equal(report.outcome, "passed");
  }
  const { before, after } = await warm.environment();
  assert.deepEqual(after, before);
});

test("restored dependencies never bypass incomplete-state recovery or native, build and real browser failures", async t => {
  const seed = await checkout(t);
  const seeded = seed.run();
  assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
  for (const [failure, guidance] of [
    ["incomplete", null], ["raster-native", /locked Liquid\/raster gems.*native extensions/s],
    ["dotnet:build", /Display harness build failed/], ["browser-launch", /Chromium setup failed/]
  ]) {
    await t.test(failure, async t => {
      const fixture = await checkout(t);
      await cp(join(seed.directory, "vendor", "bundle", "ruby"), join(fixture.directory, "vendor", "bundle", "ruby"), { recursive: true });
      await cp(join(seed.directory, ".tools", "framework"), join(fixture.directory, ".tools", "framework"), { recursive: true });
      const foreign = join(fixture.directory, "foreign shared state");
      await mkdir(foreign);
      await writeFile(join(foreign, "sentinel"), "never delete foreign shared state");
      if (failure === "incomplete") {
        await rm(join(fixture.directory, "vendor", "bundle", "ruby", "4.0.0", "gems", "synthetic-gem", "lib", "ready"));
        await rm(join(fixture.directory, ".tools", "framework", "fonts", "classic.ttf"));
      }
      const result = fixture.run({
        TRMNL_GEMS_CACHE_STATE: "exact-hit", TRMNL_FRAMEWORK_CACHE_STATE: "exact-hit",
        BUNDLE_PATH: foreign, BUNDLE_USER_CACHE: foreign, PLAYWRIGHT_BROWSERS_PATH: foreign,
        DISPLAY_FAIL: guidance ? failure : ""
      });
      assert.equal(result.status, guidance ? 1 : 0, result.stdout + result.stderr);
      if (guidance) {
        assert.match(result.stderr, guidance);
        assert.doesNotMatch(result.stdout, /Display setup PASSED/);
      } else {
        const calls = await fixture.calls();
        assert.ok(calls.some(call => call.tool === "ruby" && call.arguments.includes("install")));
        assert.ok(calls.some(call => call.tool === "download" && call.uri.includes("fonts")));
      }
      assert.equal(await readFile(join(foreign, "sentinel"), "utf8"), "never delete foreign shared state");
      const { before, after } = await fixture.environment();
      assert.deepEqual(after, before);
    });
  }
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

test("public setup reports staging cleanup failures instead of successful preparation", async t => {
  const fixture = await checkout(t);
  const result = fixture.run({ DISPLAY_FAIL: "cleanup" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Synthetic staging cleanup failure/);
  assert.ok(!result.stdout.includes("Display setup PASSED"));
  const reportPath = result.stdout.match(/Timing report: (.+)/)?.[1].trim();
  assert.ok(reportPath, result.stdout + result.stderr);
  const report = JSON.parse(await readFile(join(reportPath, "summary.json"), "utf8"));
  assert.equal(report.outcome, "failed");
  assert.equal(report.stages.at(-1).result, "failed");
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
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
