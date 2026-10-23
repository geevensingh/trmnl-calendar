import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function checkout(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda validation "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
  await cp(join(root, "display", "workbench"), join(directory, "display", "workbench"), { recursive: true });
  for (const name of ["delivery", "validation"]) {
    await cp(join(root, "tests", name), join(directory, "tests", name), { recursive: true });
  }
  for (const project of [["src", "CalendarAgenda"], ["tests", "CalendarAgenda.Tests"]]) {
    await mkdir(join(directory, ...project, "obj"), { recursive: true });
    await writeFile(join(directory, ...project, "obj", "project.assets.json"), "{}");
  }
  for (const asset of [
    ["css", "3.4.3", "plugins.css"], ["js", "3.4.3", "plugins.js"], ["fonts", "synthetic.woff2"]
  ]) {
    const path = join(directory, ".tools", "framework", ...asset);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "synthetic local asset");
  }
  const calls = join(directory, "calls.jsonl");
  const run = (scope = "Fast", environment = {}) => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command", `
      function global:Get-Command {
        [CmdletBinding()]
        param([Parameter(Position = 0)][string]$Name)
        if ($Name -eq $env:VALIDATION_MISSING) { return }
        Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
      }
      function global:dotnet {
        @{ tool = 'dotnet'; arguments = @($args) } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        if ($args[0] -eq '--version') { '10.0.100' }
        if ($args[0] -eq '--list-runtimes' -and !$env:VALIDATION_NO_RUNTIME) {
          'Microsoft.NETCore.App 10.0.0 [synthetic]'
          'Microsoft.AspNetCore.App 10.0.0 [synthetic]'
        }
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq "dotnet:$($args[0])") { 23 } else { 0 }
      }
      function global:node {
        @{ tool = 'node'; arguments = @($args); bicepCheck = $env:AZURE_BICEP_CHECK_VERSION } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        if ($args[0] -eq '--version') { 'v24.0.0' }
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq "node:$($args[0])") { 29 } else { 0 }
      }
      function global:ruby {
        @{ tool = 'ruby'; arguments = @($args) } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        '4.0.0'
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq 'ruby') { 31 } else { 0 }
      }
      function global:func {
        '4.0.0'
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq 'func') { 37 } else { 0 }
      }
      function global:az {
        @{ tool = 'az'; arguments = @($args); bicepCheck = $env:AZURE_BICEP_CHECK_VERSION } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        'Bicep CLI version 0.38.0'
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq 'az:bicep') { 41 } else { 0 }
      }
      & $env:VALIDATION_SCRIPT -Scope $env:VALIDATION_SCOPE
    `
  ], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: {
      ...process.env, VALIDATION_SCRIPT: join(directory, "scripts", "validate.ps1"),
      VALIDATION_SCOPE: scope, VALIDATION_CALLS: calls, TRMNL_RUBY: "ruby", ...environment
    }
  });
  return {
    directory, run,
    calls: async () => (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(JSON.parse)
  };
}

test("fast validation reports success, checks formatting without edits, and compiles without restoring", async t => {
  const fixture = await checkout(t);
  const result = fixture.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Fast validation PASSED/);
  const calls = await fixture.calls();
  const format = calls.find(call => call.tool === "dotnet" && call.arguments[0] === "format");
  assert.ok(format.arguments.includes("--verify-no-changes"));
  assert.ok(format.arguments.includes("--no-restore"));
  assert.equal(format.arguments[1], "whitespace");
  const build = calls.find(call => call.tool === "dotnet" && call.arguments[0] === "build");
  assert.ok(build.arguments.includes("--no-restore"));
  assert.ok(!calls.some(call => call.arguments.includes("test") || call.arguments.includes("--test")));
  for (const name of ["app.mjs", "preview.mjs", "layout-checks.mjs"])
    assert.ok(calls.some(call => call.tool === "node" && call.arguments[0] === "--check"
      && call.arguments[1].endsWith(name)), `Missing browser syntax check: ${name}`);
});

test("a failed component cannot become overall success when later commands pass", async t => {
  const fixture = await checkout(t);
  for (const failure of ["dotnet:format", "dotnet:build", "node:--check"]) {
    const result = fixture.run("Fast", { VALIDATION_FAIL: failure });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Fast validation FAILED/);
    assert.doesNotMatch(result.stdout, /Fast validation PASSED/);
    assert.match(result.stdout, /exited with code (23|29)/);
    if (failure.startsWith("dotnet:"))
      assert.match(result.stdout, /PowerShell and Node syntax\s+PASSED/);
  }
});

test("missing SDKs, Node, or restored dependencies fail with setup guidance and block dependent checks", async t => {
  const fixture = await checkout(t);
  for (const [failure, guidance] of [
    ["dotnet:--version", /\.NET 10 SDK.*Install/s],
    ["node:--version", /Install Node\.js 22/]
  ]) {
    const result = fixture.run("Fast", { VALIDATION_FAIL: failure });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, guidance);
    assert.match(result.stdout, /BLOCKED/);
    assert.match(result.stdout, /Fast validation FAILED/);
  }
  await rm(join(fixture.directory, "tests", "CalendarAgenda.Tests", "obj", "project.assets.json"));
  const missingRestore = fixture.run();
  assert.equal(missingRestore.status, 1, missingRestore.stdout + missingRestore.stderr);
  assert.match(missingRestore.stdout, /Missing restored .NET dependencies.*dotnet restore/);
  assert.ok(!(await fixture.calls()).some(call =>
    ["restore", "format", "build", "--check"].includes(call.arguments[0])));
});

test("full validation runs the production .NET rendering suite and every local Node test without installing tools", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Full validation PASSED/);
  const calls = await fixture.calls();
  const tests = calls.find(call => call.tool === "dotnet" && call.arguments[0] === "test");
  assert.ok(tests.arguments.some(argument => argument.endsWith("CalendarAgenda.Tests.csproj")));
  assert.ok(tests.arguments.includes("--no-build"));
  assert.ok(tests.arguments.includes("--no-restore"));
  assert.ok(!tests.arguments.includes("--filter"));
  const nodeTests = calls.find(call => call.tool === "node" && call.arguments[0] === "--test");
  for (const name of [
    "deployment.test.mjs", "deploy-command.test.mjs", "smoke.test.mjs", "validation.test.mjs", "hooks.test.mjs"
  ])
    assert.ok(nodeTests.arguments.some(argument => argument.endsWith(name)), `Missing ${name}`);
  const format = calls.find(call => call.tool === "dotnet" && call.arguments[0] === "format");
  assert.ok(format.arguments.includes("--verify-no-changes"));
  assert.ok(!format.arguments.includes("whitespace"));
  assert.ok(!calls.some(call => call.arguments.some(argument =>
    ["restore", "install", "deploy", "login"].includes(argument))));
});

test("full validation propagates test failures and blocks .NET execution after a failed build", async t => {
  const fixture = await checkout(t);
  for (const failure of ["dotnet:test", "node:--test", "dotnet:build"]) {
    const result = fixture.run("Full", { VALIDATION_FAIL: failure });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Full validation FAILED/);
    if (failure === "dotnet:build")
      assert.match(result.stdout, /\.NET tests \(production rendering\)\s+BLOCKED/);
    if (failure !== "node:--test")
      assert.match(result.stdout, /Node delivery and guardrail tests\s+PASSED/);
  }
});

test("missing full-scope runtimes, tools, gems, and assets produce actionable failures rather than skipped success", async t => {
  const fixture = await checkout(t);
  for (const [environment, guidance] of [
    [{ VALIDATION_NO_RUNTIME: "1" }, /Install the \.NET 10 and ASP\.NET Core 10 runtimes/],
    [{ VALIDATION_MISSING: "func" }, /Missing func on PATH.*Core Tools v4/],
    [{ VALIDATION_MISSING: "az" }, /Missing az on PATH.*Azure CLI/],
    [{ VALIDATION_FAIL: "az:bicep" }, /Install Bicep once with az bicep install/],
    [{ TRMNL_RUBY: "missing-synthetic-ruby" }, /Install Ruby 4.*setup-display/],
    [{ VALIDATION_FAIL: "ruby" }, /locked Liquid\/raster gems.*setup-display/]
  ]) {
    const result = fixture.run("Full", environment);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, guidance);
    assert.match(result.stdout, /\.NET tests \(production rendering\)\s+BLOCKED/);
    assert.match(result.stdout, /Full validation FAILED/);
  }
  await rm(join(fixture.directory, ".tools", "framework", "css", "3.4.3", "plugins.css"));
  const missingAsset = fixture.run("Full");
  assert.equal(missingAsset.status, 1, missingAsset.stdout + missingAsset.stderr);
  assert.match(missingAsset.stdout, /Missing pinned TRMNL framework asset.*setup-display/);
  assert.ok(!(await fixture.calls()).some(call => ["test", "--test"].includes(call.arguments[0])));
});

test("Bicep version lookup and downstream delivery checks stay offline", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", { AZURE_BICEP_CHECK_VERSION: "true" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = await fixture.calls();
  for (const call of calls.filter(call => call.tool === "az" || call.arguments[0] === "--test"))
    assert.equal(call.bicepCheck, "false");
});
