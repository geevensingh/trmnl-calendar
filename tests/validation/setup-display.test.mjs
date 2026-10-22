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
  const scripts = join(directory, "scripts");
  const tools = join(directory, "synthetic tools");
  const sdkHome = join(directory, "sdk home");
  const browser = join(directory, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0");
  for (const path of [scripts, tools, sdkHome, browser])
    await mkdir(path, { recursive: true });
  const setup = join(scripts, "setup-display.ps1");
  await cp(join(root, "scripts", "setup-display.ps1"), setup);
  const calls = join(directory, "calls.jsonl");
  const ruby = join(tools, "ruby.ps1");
  await writeFile(ruby, `
    @{ tool = 'ruby'; arguments = @($args) } | ConvertTo-Json -Compress |
      Add-Content -LiteralPath $env:SETUP_CALLS
    $global:LASTEXITCODE = if ($env:SETUP_FAIL -eq "ruby:$($args[1])") { 23 } else { 0 }
  `);
  await writeFile(join(browser, "playwright.ps1"), `
    @{ tool = 'browser'; arguments = @($args) } | ConvertTo-Json -Compress |
      Add-Content -LiteralPath $env:SETUP_CALLS
    dotnet fixture-playwright.dll @args
    if ($env:SETUP_FAIL -eq 'browser') { $global:LASTEXITCODE = 31 }
  `);
  const run = (environment = {}) => {
    const inherited = { ...process.env };
    for (const name of Object.keys(inherited)) {
      if (["DOTNET_GENERATE_ASPNET_CERTIFICATE", "DOTNET_CLI_HOME", "TRMNL_RUBY"].includes(name.toUpperCase()) ||
          name.toUpperCase().startsWith("SETUP_"))
        delete inherited[name];
    }
    return spawnSync("pwsh", [
      "-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        $env:PATH = $env:SETUP_TOOLS
        function global:dotnet {
          $state = Join-Path $env:DOTNET_CLI_HOME 'fixture-first-run'
          $firstRun = !(Test-Path -LiteralPath $state)
          @{
            tool = 'dotnet'
            arguments = @($args)
            sdkHome = $env:DOTNET_CLI_HOME
            firstRun = $firstRun
            certificateGeneration = $env:DOTNET_GENERATE_ASPNET_CERTIFICATE
            certificateAttempt = $firstRun -and $env:DOTNET_GENERATE_ASPNET_CERTIFICATE -ne 'false'
          } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:SETUP_CALLS
          Set-Content -LiteralPath $state 'synthetic SDK first-run state'
          $global:LASTEXITCODE = if ($env:SETUP_FAIL -eq "dotnet:$($args[0])") { 29 } else { 0 }
        }
        function global:Invoke-WebRequest {
          param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
          @{ tool = 'download'; arguments = @($Uri) } | ConvertTo-Json -Compress |
            Add-Content -LiteralPath $env:SETUP_CALLS
          Set-Content -LiteralPath $OutFile 'synthetic framework asset'
        }
        function global:Expand-Archive {
          param([string]$Path, [string]$DestinationPath, [switch]$Force)
          @{ tool = 'unzip'; arguments = @($Path) } | ConvertTo-Json -Compress |
            Add-Content -LiteralPath $env:SETUP_CALLS
          Set-Content -LiteralPath (Join-Path $DestinationPath 'synthetic.woff2') 'synthetic font'
        }
        & $env:SETUP_SCRIPT
      `
    ], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: {
        ...inherited, SETUP_SCRIPT: setup, SETUP_CALLS: calls, SETUP_TOOLS: tools,
        DOTNET_CLI_HOME: sdkHome, TRMNL_RUBY: ruby, SETUP_FAIL: "", ...environment
      }
    });
  };
  return {
    directory, sdkHome, run,
    calls: async () => (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(JSON.parse)
  };
}

function setupCommands(directory) {
  const bundle = join(directory, "synthetic tools", "bundle");
  return [
    ["ruby", bundle, "config", "set", "--local", "path", "vendor/bundle"],
    ["ruby", bundle, "install", "--quiet"],
    ["download", "https://trmnl.com/css/3.4.3/plugins.css"],
    ["download", "https://trmnl.com/js/3.4.3/plugins.js"],
    ["download", "https://trmnl.com/fonts/bundles/trmnl/trmnl-fonts-bundle--trmnl.zip"],
    ["unzip", join(directory, ".tools", "trmnl-fonts.zip")],
    ["download", "https://trmnl.com/fonts/bundles/classic/trmnl-fonts-bundle--classic.zip"],
    ["unzip", join(directory, ".tools", "classic-fonts.zip")],
    ["dotnet", "restore", ".\\src\\CalendarAgenda\\CalendarAgenda.csproj", "--nologo", "--verbosity", "quiet"],
    ["dotnet", "build", ".\\tests\\CalendarAgenda.Tests\\CalendarAgenda.Tests.csproj", "--nologo", "--verbosity", "quiet"],
    ["browser", "install", "chromium"],
    ["dotnet", "fixture-playwright.dll", "install", "chromium"]
  ];
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
    certificateGeneration: first.certificateGeneration,
    certificateAttempt: first.certificateAttempt
  }, {
    sdkHome: fixture.sdkHome,
    firstRun: true,
    certificateGeneration: "false",
    certificateAttempt: false
  });
  assert.deepEqual(calls.map(call => call.certificateGeneration), ["false", "false", "false"]);
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
  }
  const calls = (await fixture.calls()).filter(call => call.tool === "dotnet");
  assert.deepEqual(calls.map(call => call.arguments[0]), [
    "restore", "build", "fixture-playwright.dll", "restore", "build", "fixture-playwright.dll"
  ]);
  assert.deepEqual(calls.map(call => call.firstRun), [true, false, false, false, false, false]);
  for (const call of calls) {
    assert.equal(call.sdkHome, fixture.sdkHome);
    assert.equal(call.certificateGeneration, "false");
    assert.equal(call.certificateAttempt, false);
  }
  assert.deepEqual(names.map(name => process.env[name]), parentEnvironment);
});

test("successful display setup preserves Bundler, framework, restore, build, and Chromium installation", async t => {
  const fixture = await checkout(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    (await fixture.calls()).map(call => [call.tool, ...call.arguments]),
    setupCommands(fixture.directory)
  );
});

test("display setup reports failed stages and stops before dependent commands", async t => {
  for (const [failure, message, completed] of [
    ["ruby:config", "Bundler configuration failed.", 1],
    ["ruby:install", "TRMNL Liquid dependency restore failed.", 2],
    ["dotnet:restore", "Functions restore failed.", 9],
    ["dotnet:build", "Display harness build failed.", 10],
    ["browser", "Browser restore failed.", 12],
    ["dotnet:fixture-playwright.dll", "Browser restore failed.", 12]
  ]) {
    await t.test(failure, async t => {
      const fixture = await checkout(t);
      const result = fixture.run({ SETUP_FAIL: failure });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(result.stderr.includes(message), result.stdout + result.stderr);
      assert.deepEqual(
        (await fixture.calls()).map(call => [call.tool, ...call.arguments]),
        setupCommands(fixture.directory).slice(0, completed)
      );
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
      await rm(join(fixture.directory, "synthetic tools", "ruby.ps1"));
      await rm(join(fixture.directory, "tests", "CalendarAgenda.Tests", "bin"), { recursive: true });
      const restore = join(fixture.directory, "fast-restore.ps1");
      await writeFile(restore, block[1]);
      assert.deepEqual(await readdir(fixture.sdkHome), []);
      const environment = { SETUP_SCRIPT: restore };
      if (generation !== undefined) environment.DOTNET_GENERATE_ASPNET_CERTIFICATE = generation;
      const result = fixture.run(environment);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(await fixture.calls(), [{
        tool: "dotnet",
        arguments: ["restore", ".\\tests\\CalendarAgenda.Tests\\CalendarAgenda.Tests.csproj"],
        sdkHome: fixture.sdkHome,
        firstRun: true,
        certificateGeneration: "false",
        certificateAttempt: false
      }]);
    });
  }
});
