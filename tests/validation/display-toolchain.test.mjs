import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkout } from "./display-toolchain-fixture.mjs";

test("an invalid explicit Ruby selection fails with recovery guidance and never falls back to PATH", async t => {
  const fixture = await checkout(t);
  const result = fixture.run({ TRMNL_RUBY: join(fixture.directory, "missing runtime", "ruby.exe") });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /TRMNL_RUBY.*unavailable.*Install Ruby 4/s);
  assert.deepEqual(await fixture.calls(), []);
});

test("setup rejects unusable or unsupported Ruby before attempting dependency restoration", async t => {
  const fixture = await checkout(t);
  for (const [environment, guidance] of [
    [{ DISPLAY_RUBY_VERSION: "3.4.5" }, /Ruby 4 is required.*3\.4\.5.*TRMNL_RUBY/s],
    [{ DISPLAY_FAIL: "ruby" }, /Ruby.*unusable.*TRMNL_RUBY/s]
  ]) {
    const result = fixture.run(environment);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, guidance);
  }
  assert.ok((await fixture.calls()).every(call => !call.arguments.includes("install") &&
    !call.arguments.includes("config")));
});

test("setup requires the lockfile's Bundler in the selected Ruby without installing shared tools", async t => {
  const fixture = await checkout(t);
  for (const environment of [{ DISPLAY_FAIL: "bundler" }, { DISPLAY_BUNDLER_VERSION: "4.0.19" }]) {
    const result = fixture.run(environment);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Bundler 4\.0\.20.*gem install bundler --version 4\.0\.20/s);
    assert.match(result.stderr, /-rrubygems\/gem_runner.*Gem::GemRunner\.new\.run\(ARGV\).*-- install bundler --version 4\.0\.20/s);
  }
  const calls = await fixture.calls();
  assert.ok(calls.some(call => call.arguments.includes("4.0.20")));
  assert.ok(!calls.some(call => call.arguments.includes("install") || call.arguments.includes("config")));
});

test("setup diagnoses broken native-extension tools before restoring gems", async t => {
  const fixture = await checkout(t);
  const result = fixture.run({ DISPLAY_FAIL: "native" });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /native-extension.*compiler.*Devkit.*setup-display/s);
  const calls = await fixture.calls();
  assert.ok(!calls.some(call => call.arguments.includes("config") || call.arguments.includes("install")));
});

test("repeat setup reuses locked gems, pinned assets and usable Chromium without changing lockfiles", async t => {
  const fixture = await checkout(t);
  const lockfile = await readFile(join(fixture.directory, "Gemfile.lock"), "utf8");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(await readFile(join(fixture.directory, "Gemfile.lock"), "utf8"), lockfile);
  }
  const calls = await fixture.calls();
  assert.equal(calls.filter(call => call.tool === "ruby" && call.arguments.includes("install")).length, 1);
  assert.equal(calls.filter(call => call.tool === "download").length, 4);
  assert.equal(calls.filter(call => call.tool === "extract").length, 2);
  assert.equal(calls.filter(call => call.tool === "playwright" && call.arguments[0] === "install").length, 1);
});

test("setup restores caller environment and does not report success when staging cleanup fails", async t => {
  const fixture = await checkout(t);
  const result = fixture.run({
    DISPLAY_FAIL: "cleanup", DOTNET_GENERATE_ASPNET_CERTIFICATE: "true",
    BUNDLE_PATH: join(fixture.directory, "peer", "gems"), BUNDLE_FROZEN: "false"
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /staging cleanup failure/);
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
  assert.doesNotMatch(result.stdout, /Display setup PASSED/);
});

test("runtime precedence is explicit selection, then an existing local Ruby, then PATH, with no hidden search", async t => {
  const fixture = await checkout(t);
  const localRuby = join(fixture.directory, ".tools", "ruby", "bin", "ruby.exe");
  const sharedRuby = join(fixture.directory, "shared tools", "bin", "ruby.exe");
  await mkdir(dirname(localRuby), { recursive: true });
  await writeFile(localRuby, "synthetic executable boundary");
  for (const [selection, expected] of [[sharedRuby, sharedRuby], ["", localRuby]]) {
    const result = fixture.run({ TRMNL_RUBY: selection, DISPLAY_FAIL: "bundler" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Bundler 4\.0\.20/);
    assert.ok(result.stdout.includes(`Ruby 4.0.0 : ${expected}`), result.stdout);
  }
  await rm(localRuby);
  const path = fixture.run({ TRMNL_RUBY: "", DISPLAY_FAIL: "bundler" });
  assert.equal(path.status, 1, path.stdout + path.stderr);
  assert.ok(path.stdout.includes("Ruby 4.0.0 : ruby"), path.stdout);
  const missing = fixture.run({ TRMNL_RUBY: "", DISPLAY_MISSING_RUBY: "1" });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /PATH Ruby executable.*unavailable.*Install Ruby 4/s);
});

test("setup ignores inherited project destinations, preserves shared caches and restores the caller environment", async t => {
  const fixture = await checkout(t);
  const canonical = join(fixture.directory, "synthetic canonical");
  const peer = join(fixture.directory, "synthetic peer");
  for (const path of [canonical, peer]) {
    await mkdir(path);
    await writeFile(join(path, "sentinel"), "untouched checkout");
  }
  const cache = join(fixture.directory, "normal shared gem cache");
  const lockfile = await readFile(join(fixture.directory, "Gemfile.lock"), "utf8");
  const result = fixture.run({
    BUNDLE_APP_CONFIG: peer, BUNDLE_PATH: canonical, BUNDLE_GEMFILE: join(canonical, "Gemfile"),
    BUNDLE_BIN: peer, BUNDLE_CACHE_PATH: canonical, BUNDLE_FROZEN: "false",
    BUNDLE_WITHOUT: "display", BUNDLE_USER_CACHE: cache, DOTNET_GENERATE_ASPNET_CERTIFICATE: "true"
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
  assert.equal(await readFile(join(fixture.directory, "Gemfile.lock"), "utf8"), lockfile);
  for (const path of [canonical, peer]) {
    assert.deepEqual(await readdir(path), ["sentinel"]);
    assert.equal(await readFile(join(path, "sentinel"), "utf8"), "untouched checkout");
  }
  const calls = await fixture.calls();
  for (const call of calls.filter(call => call.tool === "ruby")) {
    assert.equal(call.gemfile, join(fixture.directory, "Gemfile"));
    assert.equal(call.config, join(fixture.directory, ".bundle"));
    assert.equal(call.bundlePath, join(fixture.directory, "vendor", "bundle"));
    assert.equal(call.frozen, "true");
    if (!call.arguments.includes("config")) assert.equal(call.ignoreConfig, "true");
    assert.equal(call.userCache, cache);
    assert.ok(!call.arguments.includes("gem") && !call.arguments.includes("update"));
  }
  for (const call of calls.filter(call => call.tool === "dotnet"))
    assert.equal(call.certificate, "false", `Certificate generation enabled for ${call.arguments[0]}`);
  for (const call of calls.filter(call => call.tool === "playwright"))
    assert.equal(call.cache, join(fixture.directory, "shared browser cache"));
});

test("interrupted asset acquisition never publishes partial downloads or extracted fonts for reuse", async t => {
  for (const failure of ["download", "extract"]) {
    const fixture = await checkout(t);
    const failed = fixture.run({ DISPLAY_FAIL: failure });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stderr, /download|extraction/);
    assert.doesNotMatch(failed.stdout, /Display setup PASSED/);
    const absent = failure === "download"
      ? join(fixture.directory, ".tools", "framework", "css", "3.4.3", "plugins.css")
      : join(fixture.directory, ".tools", "framework", "fonts", "trmnl.woff2");
    await assert.rejects(readFile(absent), { code: "ENOENT" });
    assert.ok(!(await readdir(join(fixture.directory, ".tools"))).some(name =>
      name.startsWith("display-setup-") || name.startsWith("native-probe-")));
    const recovered = fixture.run();
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(await readFile(join(fixture.directory, ".tools", "framework", "css", "3.4.3", "plugins.css"), "utf8"),
      /trmnl\.woff2/);
    assert.equal((await readFile(join(fixture.directory, ".tools", "framework", "fonts", "trmnl.woff2"), "utf8")).trim(),
      "synthetic font");
  }
});

test("failed restore, native-gem load, SDK, build and browser setup are actionable failures with no environment leaks", async t => {
  for (const [failure, guidance] of [
    ["bundle-config", /Bundler configuration failed.*setup-display/s],
    ["bundle-install", /gem restore failed.*setup-display/s],
    ["gems", /locked Liquid\/raster gems.*setup-display/s],
    ["dotnet:--version", /\.NET 10 SDK/],
    ["dotnet:restore", /dependency restore failed.*setup-display/s],
    ["dotnet:build", /build failed.*setup-display/s],
    ["browser-install", /Chromium setup failed.*setup-display/s],
    ["browser-install-throw", /Chromium setup failed.*setup-display/s],
    ["browser-launch", /Chromium setup failed.*setup-display/s]
  ]) {
    const fixture = await checkout(t);
    const lockfile = await readFile(join(fixture.directory, "Gemfile.lock"), "utf8");
    const result = fixture.run({
      DISPLAY_FAIL: failure, DOTNET_GENERATE_ASPNET_CERTIFICATE: "true",
      BUNDLE_PATH: join(fixture.directory, "peer", "gems")
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, guidance);
    assert.doesNotMatch(result.stdout, /Display setup PASSED/);
    const { before, after } = await fixture.environment();
    assert.deepEqual(after, before);
    assert.equal(await readFile(join(fixture.directory, "Gemfile.lock"), "utf8"), lockfile);
    for (const call of (await fixture.calls()).filter(call => call.tool === "dotnet"))
      assert.equal(call.certificate, "false");
  }
});

test("partial gem restoration is retried rather than reused as a ready bundle", async t => {
  const fixture = await checkout(t);
  const failed = fixture.run({ DISPLAY_FAIL: "bundle-install" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const recovered = fixture.run();
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal((await fixture.calls()).filter(call => call.tool === "ruby" && call.arguments.includes("install")).length, 2);
});

test("setup retains all local Bundler settings for renderers outside the setup process", async t => {
  const fixture = await checkout(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const config = await readFile(join(fixture.directory, ".bundle", "config"), "utf8");
  assert.match(config, /path vendor\/bundle/);
  assert.match(config, /frozen true/);
  assert.match(config, /disable_shared_gems true/);
});

test("a timed-out native build fails and terminates its owned compiler process tree before restoration", async t => {
  const fixture = await checkout(t);
  const result = fixture.run({ DISPLAY_FAIL: "native-timeout" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /45 seconds.*setup-display|setup-display.*45 seconds/s);
  const calls = await fixture.calls();
  assert.ok(calls.some(call => call.tool === "native-wait" && call.arguments[0] === 45000));
  assert.ok(calls.some(call => call.tool === "native-kill" && call.arguments[0] === true));
  assert.ok(!calls.some(call => call.arguments.includes("config") || call.arguments.includes("install")));
});

test("setup diagnoses missing, unsupported and unusable SDKs before dependency restoration", async t => {
  const fixture = await checkout(t);
  for (const environment of [
    { DISPLAY_MISSING_TOOL: "dotnet" }, { DISPLAY_SDK_VERSION: "9.0.100" },
    { DISPLAY_FAIL: "dotnet:--version" }, { DISPLAY_FAIL: "dotnet:throw" }
  ]) {
    const result = fixture.run({ DOTNET_GENERATE_ASPNET_CERTIFICATE: "true", ...environment });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Install.*\.NET 10 SDK|\.NET 10 SDK.*Install/s);
    assert.doesNotMatch(result.stdout, /Display setup PASSED/);
    const { before, after } = await fixture.environment();
    assert.deepEqual(after, before);
  }
  assert.ok(!(await fixture.calls()).some(call => call.arguments.includes("config") ||
    call.arguments.includes("install") || call.arguments.includes("restore")));
});
