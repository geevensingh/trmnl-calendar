import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function checkout(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda display setup "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
  for (const file of ["Gemfile", "Gemfile.lock"])
    await cp(join(root, file), join(directory, file));
  const calls = join(directory, "calls.jsonl");
  const browser = join(directory, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0", "playwright.ps1");
  await mkdir(dirname(browser), { recursive: true });
  await writeFile(browser, String.raw`
@{ tool = 'playwright'; arguments = @($args); cache = $env:PLAYWRIGHT_BROWSERS_PATH } |
  ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
$installed = Join-Path $env:PLAYWRIGHT_BROWSERS_PATH 'synthetic-pinned-chromium'
if ($args[0] -eq 'install') {
  if ($env:DISPLAY_FAIL -eq 'browser-install-throw') { throw 'Synthetic unusable browser installer' }
  if ($env:DISPLAY_FAIL -eq 'browser-install') { exit 61 }
  New-Item -ItemType Directory -Force $env:PLAYWRIGHT_BROWSERS_PATH | Out-Null
  'ready' | Set-Content -LiteralPath $installed
  exit 0
}
if (!(Test-Path -LiteralPath $installed) -or $env:DISPLAY_FAIL -eq 'browser-launch') { exit 62 }
'synthetic screenshot' | Set-Content -LiteralPath $args[-1]
exit 0
`);
  const run = (environment = {}) => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command", String.raw`
      function global:Get-Command {
        [CmdletBinding()]
        param([Parameter(Position = 0)][string]$Name)
        if ($Name -eq 'ruby' -and $env:DISPLAY_MISSING_RUBY) { return }
        Microsoft.PowerShell.Core\Get-Command @PSBoundParameters
      }
      function global:Invoke-SyntheticRuby {
        @{ tool = 'ruby'; arguments = @($args); gemfile = $env:BUNDLE_GEMFILE;
           config = $env:BUNDLE_APP_CONFIG; bundlePath = $env:BUNDLE_PATH;
           frozen = $env:BUNDLE_FROZEN; ignoreConfig = $env:BUNDLE_IGNORE_CONFIG;
           userCache = $env:BUNDLE_USER_CACHE } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        if ($args[0] -eq '-e' -and $args[1] -match 'RUBY_VERSION') {
          if ($env:DISPLAY_FAIL -eq 'ruby') {
            $global:LASTEXITCODE = 31
          } else {
            if ($env:DISPLAY_RUBY_VERSION) { $env:DISPLAY_RUBY_VERSION } else { '4.0.0' }
            $global:LASTEXITCODE = 0
          }
          return
        }
        if ($args[0] -eq '-e' -and $args[1] -match 'Bundler::VERSION') {
          if ($env:DISPLAY_FAIL -eq 'bundler') {
            $global:LASTEXITCODE = 32
          } else {
            if ($env:DISPLAY_BUNDLER_VERSION) { $env:DISPLAY_BUNDLER_VERSION } else { '4.0.20' }
            $global:LASTEXITCODE = 0
          }
          return
        }
        if ($args[0] -eq '-e' -and $args[1] -match 'mkmf') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'native') { 33 } else { 0 }
          return
        }
        if ($args -contains 'check') {
          $global:LASTEXITCODE = if (Test-Path -LiteralPath (Join-Path $env:BUNDLE_PATH 'synthetic-gems')) { 0 } else { 54 }
          return
        }
        if ($args -contains 'config') {
          if ($env:DISPLAY_FAIL -eq 'bundle-config') { $global:LASTEXITCODE = 58; return }
          New-Item -ItemType Directory -Force $env:BUNDLE_APP_CONFIG | Out-Null
          $config = Join-Path $env:BUNDLE_APP_CONFIG 'config'
          if ($env:BUNDLE_IGNORE_CONFIG) {
            ($args -join ' ') | Set-Content -LiteralPath $config
          } else {
            ($args -join ' ') | Add-Content -LiteralPath $config
          }
          $global:LASTEXITCODE = 0
          return
        }
        if ($args -contains 'install') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'bundle-install') { 55 } else { 0 }
          New-Item -ItemType Directory -Force $env:BUNDLE_PATH | Out-Null
          'interrupted gem restore' | Set-Content -LiteralPath (Join-Path $env:BUNDLE_PATH 'partial-gem')
          if ($LASTEXITCODE -eq 0) {
            'ready' | Set-Content -LiteralPath (Join-Path $env:BUNDLE_PATH 'synthetic-gems')
          }
          return
        }
        if (($args -join ' ') -match 'trmnl/liquid') {
          $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq 'gems') { 56 } else { 0 }
          return
        }
        $global:LASTEXITCODE = 53
      }
      function global:Invoke-WebRequest {
        param($Uri, $OutFile, $TimeoutSec)
        @{ tool = 'download'; uri = "$Uri"; target = $OutFile } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        if ($env:DISPLAY_FAIL -eq 'download') {
          'interrupted download' | Set-Content -LiteralPath $OutFile
          throw 'Synthetic network failure'
        }
        $content = if ("$Uri" -match '\.css$') {
          '@font-face{src:url("/fonts/trmnl.woff2")} @font-face{src:url("/fonts/classic.ttf")}'
        } else { 'synthetic complete asset' }
        $content | Set-Content -LiteralPath $OutFile
      }
      function global:Expand-Archive {
        param($LiteralPath, $Path, $DestinationPath, [switch]$Force)
        if (!$LiteralPath) { $LiteralPath = $Path }
        @{ tool = 'extract'; archive = $LiteralPath; target = $DestinationPath } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:DISPLAY_CALLS
        New-Item -ItemType Directory -Force $DestinationPath | Out-Null
        $font = if ($LiteralPath -match 'classic') { 'classic.ttf' } else { 'trmnl.woff2' }
        'incomplete font' | Set-Content -LiteralPath (Join-Path $DestinationPath $font)
        if ($env:DISPLAY_FAIL -eq 'extract') { throw 'Synthetic corrupt archive' }
        'synthetic font' | Set-Content -LiteralPath (Join-Path $DestinationPath $font)
      }
      function global:dotnet {
        @{ tool = 'dotnet'; arguments = @($args); certificate = $env:DOTNET_GENERATE_ASPNET_CERTIFICATE } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        if ($args[0] -eq '--version') { '10.0.100' }
        $global:LASTEXITCODE = if ($env:DISPLAY_FAIL -eq "dotnet:$($args[0])") { 57 } else { 0 }
      }
      function global:Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $RedirectStandardOutput,
          $RedirectStandardError, [switch]$PassThru, [switch]$NoNewWindow)
        @{ tool = 'native-probe'; arguments = @($ArgumentList); executable = $FilePath } |
          ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        '' | Set-Content -LiteralPath $RedirectStandardOutput
        '' | Set-Content -LiteralPath $RedirectStandardError
        $process = [pscustomobject]@{
          ExitCode = if ($env:DISPLAY_FAIL -eq 'native') { 33 } else { 0 }
          Killed = $false
        }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
          param($Milliseconds)
          @{ tool = 'native-wait'; arguments = @($Milliseconds) } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
          return $env:DISPLAY_FAIL -ne 'native-timeout' -or $this.Killed
        }
        $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
          param($EntireTree)
          $this.Killed = $true
          @{ tool = 'native-kill'; arguments = @($EntireTree) } |
            ConvertTo-Json -Compress | Add-Content -LiteralPath $env:DISPLAY_CALLS
        }
        $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
        return $process
      }
      function global:Remove-Item {
        [CmdletBinding()]
        param($LiteralPath, $Path, [switch]$Recurse, [switch]$Force)
        if ($env:DISPLAY_FAIL -eq 'cleanup' -and $LiteralPath -match 'display-setup-') {
          throw 'Synthetic staging cleanup failure'
        }
        Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
      }
      Set-Alias -Name $env:DISPLAY_SHARED_RUBY -Value Invoke-SyntheticRuby -Scope Global
      Set-Alias -Name ruby -Value Invoke-SyntheticRuby -Scope Global
      Set-Alias -Name (Join-Path $env:DISPLAY_ROOT '.tools\ruby\bin\ruby.exe') -Value Invoke-SyntheticRuby -Scope Global
      $before = @{}
      Get-ChildItem Env: | Where-Object {
        $_.Name -like 'BUNDLE_*' -or $_.Name -in @('PATH', 'TRMNL_RUBY', 'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'PLAYWRIGHT_BROWSERS_PATH')
      } | ForEach-Object { $before[$_.Name] = $_.Value }
      $code = 0
      try { & $env:DISPLAY_SCRIPT }
      catch { [Console]::Error.WriteLine($_.Exception.Message); $code = 1 }
      finally {
        $after = @{}
        Get-ChildItem Env: | Where-Object {
          $_.Name -like 'BUNDLE_*' -or $_.Name -in @('PATH', 'TRMNL_RUBY', 'DOTNET_GENERATE_ASPNET_CERTIFICATE', 'PLAYWRIGHT_BROWSERS_PATH')
        } | ForEach-Object { $after[$_.Name] = $_.Value }
        @{ before = $before; after = $after } | ConvertTo-Json -Depth 5 |
          Set-Content -LiteralPath $env:DISPLAY_ENVIRONMENT
      }
      exit $code
    `
  ], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env, DISPLAY_ROOT: directory, DISPLAY_SCRIPT: join(directory, "scripts", "setup-display.ps1"),
      DISPLAY_CALLS: calls, DISPLAY_SHARED_RUBY: join(directory, "shared tools", "bin", "ruby.exe"),
      DISPLAY_ENVIRONMENT: join(directory, "environment.json"),
      PLAYWRIGHT_BROWSERS_PATH: join(directory, "shared browser cache"),
      TRMNL_RUBY: join(directory, "shared tools", "bin", "ruby.exe"), ...environment
    }
  });
  return {
    directory, run,
    environment: async () => JSON.parse(await readFile(join(directory, "environment.json"), "utf8")),
    calls: async () => {
      try { return (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    }
  };
}

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
