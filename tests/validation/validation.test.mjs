import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function checkout(t, { owned = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agenda validation ")));
  if (!owned || !process.env.VALIDATION_RETAIN_FIXTURES)
    t.after(() => rm(directory, { recursive: true, force: true }));
  else t.diagnostic(`Retained owned external-tool fixture: ${directory}`);
  const ownedScripts = new Set(["scripts", "validate.ps1", "validation-report.ps1",
    "validation-scheduling.ps1", "display-toolchain.ps1", "validation-execution.mjs",
    "validation-partitions.mjs", "node-timing-reporter.mjs"]);
  await cp(join(root, "scripts"), join(directory, "scripts"), {
    recursive: true, filter: path => !owned || ownedScripts.has(path.split(/[\\/]/).at(-1))
  });
  for (const name of ["Gemfile", "Gemfile.lock"])
    await cp(join(root, name), join(directory, name));
  await mkdir(join(directory, "tests"), { recursive: true });
  await cp(join(root, "tests", "validation-partitions.runsettings"),
    join(directory, "tests", "validation-partitions.runsettings"));
  const workbench = join(root, "display", "workbench");
  await cp(workbench, join(directory, "display", "workbench"), {
    recursive: true, filter: path => !owned || path === workbench || path.split(/[\\/]/).at(-1) === "app.mjs"
  });
  for (const name of ["delivery", "validation"]) {
    if (owned) {
      await mkdir(join(directory, "tests", name));
      await writeFile(join(directory, "tests", name, "synthetic.test.mjs"), "// External tool fixture only.\n");
    } else await cp(join(root, "tests", name), join(directory, "tests", name), { recursive: true });
  }
  await writeFile(join(directory, "tests", "display-coverage.json"), JSON.stringify({
    version: 1, id: "og-first-v1", scenarios: ["reference"], secondary_scenarios: ["reference"],
    adaptive_families: { All_views: "all" }, title_variants: ["short/timed"],
    secondary_title_variants: ["short/timed"]
  }));
  for (const project of [["src", "CalendarAgenda"], ["tests", "CalendarAgenda.Tests"]]) {
    await mkdir(join(directory, ...project, "obj"), { recursive: true });
    await writeFile(join(directory, ...project, "obj", "project.assets.json"), "{}");
  }
  for (const asset of [
    ["css", "3.4.3", "plugins.css"], ["js", "3.4.3", "plugins.js"], ["fonts", "synthetic.woff2"]
  ]) {
    const path = join(directory, ".tools", "framework", ...asset);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset[0] === "css"
      ? '@font-face{src:url("/fonts/synthetic.woff2")}' : "synthetic local asset");
  }
  const browser = join(directory, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0", "playwright.ps1");
  await mkdir(dirname(browser), { recursive: true });
  await writeFile(browser, String.raw`
if (!$env:VALIDATION_CALLS) {
  $configuration = Get-Content -LiteralPath '.tools\fixture\configuration.json' -Raw | ConvertFrom-Json
  foreach ($property in $configuration.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
  }
}
@{ tool = 'playwright'; arguments = @($args) } | ConvertTo-Json -Compress |
  Add-Content -LiteralPath $env:VALIDATION_CALLS
if ($env:VALIDATION_BROWSER_FAIL) { exit 43 }
if ($env:VALIDATION_BROWSER_THROW) { throw 'Synthetic unusable Playwright driver' }
'synthetic screenshot' | Set-Content -LiteralPath $args[-1]
exit 0
`);
  const calls = join(directory, "calls.jsonl");
  if (owned) {
    const scenario = "Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views";
    const methods = {
      "CalendarAgenda.Tests.AdaptiveDisplayTests": {
        All_views: "d1", [scenario]: "d1", Second_views: "d2", Third_views: "d3", Fourth_views: "d4"
      }
    };
    const policyPath = join(directory, "tests", "display-coverage.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    Object.assign(policy.adaptive_families, { Second_views: "all", Third_views: "all", Fourth_views: "all" });
    await writeFile(policyPath, JSON.stringify(policy));
    const cases = Object.entries(methods).flatMap(([type, members]) =>
      Object.keys(members).map(method => `${type}.${method}`));
    const discovery = {
      schema_version: 2, xunit: "2.9.3.0", adapter: "3.1.4.0", scenarios: ["reference"],
      scenario_bridges: [], methods: cases,
      tests: cases.map((method, index) => ({
        test_id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
        name: `${method}(data: complete)`, method, scenario: null
      }))
    };
    await writeFile(join(directory, "tests", "validation-partitions.json"), JSON.stringify({
      schema_version: 1, id: "full-partitions-v1", partitions: ["d1", "d2", "d3", "d4"],
      execution_runners: 5, max_parallel_collections: 2, methods
    }));
    await mkdir(join(directory, ".tools", "fixture"), { recursive: true });
    await mkdir(join(directory, ".tools", "playwright"), { recursive: true });
    await writeFile(join(directory, ".tools", "fixture", "discovery.json"), JSON.stringify(discovery));
    await writeFile(join(directory, ".gitignore"), ".tools/\nartifacts/\ncalls.jsonl\nenvironment.json\n");
    for (const args of [
      ["init", "--quiet"], ["add", "."],
      ["-c", "user.name=Validation fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic public validator fixture"]
    ]) {
      const result = spawnSync("git", args, {
        cwd: directory, encoding: "utf8", timeout: 10_000,
        env: { ...isolatedGitEnvironment(), GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" }
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  }
  let reportDirectory;
  const run = (scope = "Fast", environment = {}, selection = {}) => {
    const result = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      function global:Get-Command {
        [CmdletBinding()]
        param([Parameter(Position = 0)][string]$Name, [string]$CommandType)
        if ($env:VALIDATION_OWNED -and $CommandType -eq 'Application' -and
            $Name -in @('dotnet','node','ruby','func','az')) {
          return [pscustomobject]@{ Source = Join-Path (Get-Location).Path ".tools\\fixture\\$Name.exe" }
        }
        if ($Name -eq $env:VALIDATION_MISSING) { return }
        if ($Name -eq 'ruby' -and $env:VALIDATION_SELECTED_RUBY) {
          return [pscustomobject]@{ Source = $env:VALIDATION_SELECTED_RUBY }
        }
        Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
      }
      function global:dotnet {
        @{ tool = 'dotnet'; arguments = @($args); certificate = $env:DOTNET_GENERATE_ASPNET_CERTIFICATE;
           ruby = $env:TRMNL_RUBY; bundlePath = $env:BUNDLE_PATH; coverage = $env:TRMNL_DISPLAY_COVERAGE } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        if ($env:VALIDATION_FAIL -eq 'dotnet:throw') { throw 'Synthetic unusable SDK executable' }
        if ($env:VALIDATION_CANCEL_TOOL -eq "dotnet:$($args[0])") {
          throw [OperationCanceledException]::new('Synthetic cancelled tool')
        }
        if ($args[0] -eq 'format' -and $env:VALIDATION_PAUSE) { Start-Sleep -Seconds 30 }
        if ($args[0] -eq 'build' -and $env:VALIDATION_MUTATE_INPUT) {
          'changed during validation' | Set-Content -LiteralPath 'content.txt'
        }
        if ($args[0] -eq 'test' -and $env:VALIDATION_RENDER_DELAY_MS) {
          Start-Sleep -Milliseconds ([int]$env:VALIDATION_RENDER_DELAY_MS)
        }
        if ($args[0] -eq '--version') {
          if ($env:VALIDATION_SDK_VERSION) { $env:VALIDATION_SDK_VERSION } else { '10.0.100' }
        }
        if ($args[0] -eq '--list-runtimes' -and !$env:VALIDATION_NO_RUNTIME) {
          'Microsoft.NETCore.App 10.0.0 [synthetic]'
          'Microsoft.AspNetCore.App 10.0.0 [synthetic]'
        }
        if ($args[0] -eq 'test' -and (!$env:VALIDATION_MISSING_EVIDENCE -or
            ($env:VALIDATION_OWNED -and $env:TRMNL_DISCOVERY_PATH))) {
          if ($env:TRMNL_DISCOVERY_PATH) {
            if ($env:VALIDATION_OWNED) {
              Copy-Item -LiteralPath '.tools\\fixture\\discovery.json' -Destination $env:TRMNL_DISCOVERY_PATH
              $global:LASTEXITCODE = 0
              return
            } else { 'synthetic discovered test inventory' | Set-Content -LiteralPath $env:TRMNL_DISCOVERY_PATH }
          }
          @'
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
<TestDefinitions><UnitTest id="one"><TestMethod className="Synthetic.Display" name="All_views"/></UnitTest>
<UnitTest id="two"><TestMethod className="Synthetic.Display" name="All_scenarios"/></UnitTest></TestDefinitions>
<Results><UnitTestResult testId="one" testName="All views" duration="00:00:00.125" outcome="Passed"/>
<UnitTestResult testId="two" testName="All scenarios" duration="00:00:00.075" outcome="Passed"/></Results>
<ResultSummary outcome="Completed"><Counters total="2" executed="2"/></ResultSummary>
</TestRun>
'@ | Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')
          if ($env:VALIDATION_OWNED) {
            $discovery = Get-Content -LiteralPath '.tools\\fixture\\discovery.json' -Raw | ConvertFrom-Json
            $selected = @($discovery.tests)
            $filterIndex = [Array]::IndexOf($args, '--filter')
            if ($filterIndex -ge 0) {
              $selectedMethods = @($args[$filterIndex + 1] -split '\\|' |
                ForEach-Object { $_.Substring('FullyQualifiedName='.Length) })
              $selected = @($selected | Where-Object method -CIn $selectedMethods)
            }
            $definitions = foreach ($case in $selected) {
              $separator = $case.method.LastIndexOf('.')
              '<UnitTest id="' + $case.test_id + '"><TestMethod className="' +
                $case.method.Substring(0,$separator) + '" name="' + $case.method.Substring($separator+1) +
                '"/></UnitTest>'
            }
            $results = foreach ($case in $selected) {
              '<UnitTestResult testId="' + $case.test_id + '" testName="' +
                [Security.SecurityElement]::Escape($case.name) +
                '" duration="00:00:00.001" outcome="Passed"/>'
            }
            ('<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><TestDefinitions>' +
              ($definitions -join '') + '</TestDefinitions><Results>' + ($results -join '') +
              '</Results><ResultSummary outcome="Completed"><Counters total="' + $selected.Count +
              '" executed="' + $selected.Count + '"/></ResultSummary></TestRun>') |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')
          }
          if ($env:VALIDATION_REPORTED_FAILURE -eq 'dotnet') {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')) -replace 'outcome="Passed"','outcome="Failed"' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')
          }
          if ($env:VALIDATION_ABORTED_DOTNET) {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')) -replace 'outcome="Completed"','outcome="Aborted"' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')
          }
          if ($env:VALIDATION_FAILED_TRX_SUMMARY) {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')) -replace 'outcome="Completed"','outcome="Failed"' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'dotnet.trx')
          }
          $phases = @('browser.create', 'browser.launch', 'ruby.startup', 'ruby.render', 'screenshot', 'png.decode', 'png.inspect')
          foreach ($phase in $phases) {
            @{ kind = 'start'; id = $phase; phase = $phase } | ConvertTo-Json -Compress |
              Add-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'phases-fixture.jsonl')
            if ($env:VALIDATION_UNFINISHED_PHASE -eq $phase) { continue }
            @{ kind = 'end'; id = $phase; phase = $phase; result = 'passed'; duration_ms = 5 } | ConvertTo-Json -Compress |
              Add-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'phases-fixture.jsonl')
          }
          if ($env:VALIDATION_OWNED) {
            foreach ($index in 1..20) {
              @(
                @{kind='start';id="fixture-output-$index";phase='fixture.output'}
                @{kind='end';id="fixture-output-$index";phase='fixture.output';result='passed';duration_ms=1}
              ) | ForEach-Object { $_ | ConvertTo-Json -Compress } |
                Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY "phases-output-$index.jsonl")
            }
          }
          foreach ($scenario in @('reference', 'matrix/og/full', 'matrix/og/half_horizontal', 'matrix/og/half_vertical',
            'matrix/v2/full', 'matrix/v2/half_horizontal', 'matrix/v2/half_vertical')) {
            $phase = if ($scenario -eq 'reference') { 'scenario.load' } else { 'render.view' }
            @{ kind='start';id=$scenario;phase=$phase;scenario=$scenario } | ConvertTo-Json -Compress |
              Add-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'phases-fixture.jsonl')
            @{ kind='end';id=$scenario;phase=$phase;scenario=$scenario;result='passed';duration_ms=1 } | ConvertTo-Json -Compress |
              Add-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'phases-fixture.jsonl')
          }
          if ($env:VALIDATION_EXPECTED_RENDER_FAILURE) {
            @(
              @{kind='start';id='expected-error';phase='ruby.render'}
              @{kind='end';id='expected-error';phase='ruby.render';result='failed';duration_ms=1}
              @{kind='start';id='superseded';phase='ruby.workbench_process'}
              @{kind='start';id='killed-child';phase='ruby.render';operation_id='superseded'}
              @{kind='end';id='superseded';phase='ruby.workbench_process';result='cancelled';duration_ms=1}
            ) | ForEach-Object { $_ | ConvertTo-Json -Compress } |
              Add-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'phases-fixture.jsonl')
          }
          $views = @('og/full', 'og/half_horizontal', 'og/half_vertical',
            'v2/full', 'v2/half_horizontal', 'v2/half_vertical')
          $identities = @(
            foreach ($view in $views) {
              [ordered]@{ policy = "og-first-v1/$env:TRMNL_DISPLAY_COVERAGE"
                method = 'CalendarAgenda.Tests.AdaptiveDisplayTests.Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views'
                scenario = 'reference'; view = $view; variant = 'default' }
              [ordered]@{ policy = "og-first-v1/$env:TRMNL_DISPLAY_COVERAGE"
                method = 'CalendarAgenda.Tests.AdaptiveDisplayTests.All_views'
                scenario = $null; view = $view; variant = 'default' }
              if ($env:VALIDATION_OWNED) {
                foreach ($family in @('Second_views','Third_views','Fourth_views')) {
                  [ordered]@{ policy = "og-first-v1/$env:TRMNL_DISPLAY_COVERAGE"
                    method = "CalendarAgenda.Tests.AdaptiveDisplayTests.$family"
                    scenario = $null; view = $view; variant = 'default' }
                }
              }
            }
          )
          $coverage = [ordered]@{
            profile = $env:TRMNL_DISPLAY_COVERAGE; policy_id = 'og-first-v1'
            policy_sha256 = (Get-FileHash -LiteralPath 'tests\\display-coverage.json' -Algorithm SHA256).Hash.ToLowerInvariant()
            expected = $identities; omitted = @()
          }
          [ordered]@{ scenarios = @('reference'); views = $views; coverage = $coverage } | ConvertTo-Json -Depth 10 |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'inventory-fixture.json')
          if (!$env:VALIDATION_MISSING_COVERAGE) {
            $completed = @($identities | ForEach-Object { [pscustomobject]$_ })
            if ($env:VALIDATION_OWNED) {
              $completed = @($completed | Where-Object method -CIn @($selected.method))
            }
            switch ($env:VALIDATION_COVERAGE_FAULT) {
              'missing-pair' { $completed = @($completed | Select-Object -Skip 1) }
              'duplicate' { $completed += $completed[0] }
              'unexpected' { $completed[0].scenario = 'not-selected' }
              'wrong-profile' { $completed[0].policy = 'og-first-v1/unknown' }
              'wrong-variant' { $completed[0].variant = 'not-selected' }
              'skipped' { $completed[0] | Add-Member result 'skipped' }
              'failed' { $completed[0] | Add-Member result 'failed' }
              'policy-changed' { Add-Content -LiteralPath 'tests\\display-coverage.json' -Value ' ' }
              'forged-manifest' {
                $completed = @($completed | Select-Object -Skip 1)
                $coverage.expected = $completed
                [ordered]@{ scenarios = @('reference'); views = $views; coverage = $coverage } |
                  ConvertTo-Json -Depth 10 |
                  Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'inventory-fixture.json')
              }
            }
            $completed | ForEach-Object { $_ | ConvertTo-Json -Compress } |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'coverage-fixture.jsonl')
          }
        }
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq "dotnet:$($args[0])") { 23 } else { 0 }
      }
      function global:node {
        if ($env:VALIDATION_OWNED -and $args[0] -like '*validation-execution.mjs') {
          & $env:VALIDATION_REAL_NODE @args
          return
        }
        @{ tool = 'node'; arguments = @($args); bicepCheck = $env:AZURE_BICEP_CHECK_VERSION;
           certificate = $env:DOTNET_GENERATE_ASPNET_CERTIFICATE } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        if ($args[0] -eq '--version') {
          if ($env:VALIDATION_NODE_VERSION) { $env:VALIDATION_NODE_VERSION } else { 'v24.0.0' }
        }
        if ($args[0] -eq '--test' -and !$env:VALIDATION_MISSING_EVIDENCE) {
          @(
            @{kind='test';name='matrix';type='test';nesting=0;duration_ms=100;result='passed'}
            @{kind='test';name='selector';type='test';nesting=1;duration_ms=60;result='passed'}
            @{kind='summary';tests=2;passed=2;failed=0;cancelled=0;skipped=0;todo=0;duration_ms=110;
              files=@($args | Where-Object { $_ -like '*.test.mjs' } | ForEach-Object { [IO.Path]::GetRelativePath((Get-Location).Path, $_) })}
          ) | ForEach-Object { $_ | ConvertTo-Json -Compress } |
            Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')
          if ($env:VALIDATION_OWNED) {
            $files = @($args | Where-Object { $_ -like '*.test.mjs' } |
              ForEach-Object { [IO.Path]::GetRelativePath((Get-Location).Path, $_) })
            @(
              foreach ($file in $files) {
                @{kind='test';file=$file;name='Complete synthetic case';type='test';nesting=0;duration_ms=1;result='passed'}
              }
              @{kind='summary';tests=$files.Count;passed=$files.Count;failed=0;cancelled=0;skipped=0;todo=0;
                duration_ms=2;files=$files}
            ) | ForEach-Object { $_ | ConvertTo-Json -Compress } |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')
          }
          if ($env:VALIDATION_CANCELLED_NODE) {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')) -replace '"cancelled":0','"cancelled":1' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')
          }
          if ($env:VALIDATION_REPORTED_FAILURE -eq 'node') {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')) -replace '"failed":0','"failed":1' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')
          }
          if ($env:VALIDATION_FAILED_NODE_EVENT) {
            (Get-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')) -replace '"result":"passed"','"result":"failed"' |
              Set-Content -LiteralPath (Join-Path $env:TRMNL_TIMING_DIRECTORY 'node.jsonl')
          }
        }
        $global:LASTEXITCODE = if ($env:VALIDATION_FAIL -eq "node:$($args[0])") { 29 } else { 0 }
      }
      function global:ruby {
        @{ tool = 'ruby'; arguments = @($args) } | ConvertTo-Json -Compress |
          Add-Content -LiteralPath $env:VALIDATION_CALLS
        $global:LASTEXITCODE = 0
        if (($args -join ' ') -match 'Bundler::VERSION') {
          if ($env:VALIDATION_FAIL -eq 'bundler') { $global:LASTEXITCODE = 31 } else { '4.0.20' }
        } elseif (($args -join ' ') -match 'trmnl/liquid') {
          if ($env:VALIDATION_FAIL -eq 'ruby') { $global:LASTEXITCODE = 31 } else { '4.0.0' }
        } else {
          if ($env:VALIDATION_RUBY_VERSION) { $env:VALIDATION_RUBY_VERSION } else { '4.0.0' }
        }
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
      if ($env:VALIDATION_SELECTED_RUBY) {
        Set-Alias -Name $env:VALIDATION_SELECTED_RUBY -Value ruby -Scope Global
      }
      function global:Move-Item {
        [CmdletBinding()]
        param($LiteralPath, $Destination, [switch]$Force)
        if ($env:VALIDATION_FINAL_STAGE_SAVE_FAIL -and !$global:failedStageSave -and
            $LiteralPath -like '*summary.tmp') {
          $report = Get-Content -LiteralPath $LiteralPath -Raw | ConvertFrom-Json
          if ($report.components[-1].outcome -eq 'success' -and
              $report.stages[-1].result -eq 'passed' -and $null -eq $report.finished_at) {
            $global:failedStageSave = $true
            throw 'Synthetic final-stage report write failure'
          }
        }
        Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters
      }
      $global:failedStageSave = $false
      function Get-CallerEnvironment {
        $snapshot = @{}
        Get-ChildItem Env: | Where-Object {
          $_.Name -like 'BUNDLE_*' -or $_.Name -in @('PATH', 'TRMNL_RUBY', 'DOTNET_GENERATE_ASPNET_CERTIFICATE',
            'TRMNL_TIMING_DIRECTORY', 'AZURE_BICEP_CHECK_VERSION', 'TRMNL_DISPLAY_COVERAGE', 'TRMNL_DISCOVERY_PATH')
        } | ForEach-Object { $snapshot[$_.Name] = $_.Value }
        return $snapshot
      }
      $before = Get-CallerEnvironment
      if ($env:VALIDATION_OWNED) {
        $tools = Join-Path (Get-Location).Path '.tools\\fixture'
        $functions = foreach ($tool in @('dotnet','node','ruby','func','az')) {
          $body = (Microsoft.PowerShell.Core\\Get-Command $tool -CommandType Function).ScriptBlock.ToString()
          "function global:$tool { " + $body + " }"
        }
        $prefix = @'
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadLine() | ConvertFrom-Json
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'configuration.json') -Raw | ConvertFrom-Json
foreach ($property in $configuration.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process')
}
'@
        $suffix = '$literalArguments = @($request.arguments); & $request.tool @literalArguments; exit $LASTEXITCODE'
        [IO.File]::WriteAllText((Join-Path $tools 'command.ps1'), ($prefix + "\n" + ($functions -join "\n") + "\n" + $suffix))
        $configuration = @{}
        Get-ChildItem Env: | Where-Object Name -Like 'VALIDATION_*' |
          ForEach-Object { $configuration[$_.Name] = $_.Value }
        $configuration | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tools 'configuration.json')
        (Join-Path $PSHOME 'pwsh.exe') | Set-Content -LiteralPath (Join-Path $tools 'pwsh.txt')
        $hostSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Web.Script.Serialization;
public class ExternalToolFixture {
    public static int Main(string[] args) {
        string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string tool = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
        var serializer = new JavaScriptSerializer();
        File.AppendAllText(Path.Combine(Environment.CurrentDirectory, "calls.jsonl"),
            serializer.Serialize(new { tool = tool, arguments = args }) + Environment.NewLine);
        if (args.Length > 0 && (args[0] == "format" || args[0] == "build" || args[0] == "--check")) {
            var configuration = serializer.Deserialize<System.Collections.Generic.Dictionary<string, string>>(
                File.ReadAllText(Path.Combine(directory, "configuration.json")));
            string failure;
            return configuration.TryGetValue("VALIDATION_FAIL", out failure) && failure == tool + ":" + args[0] ? 23 : 0;
        }
        var start = new ProcessStartInfo(File.ReadAllText(Path.Combine(directory, "pwsh.txt")).Trim(),
            "-NoLogo -NoProfile -NonInteractive -File \\"" + Path.Combine(directory, "command.ps1") + "\\"");
        start.UseShellExecute = false;
        start.RedirectStandardInput = true;
        var previousEncoding = Console.InputEncoding;
        try {
            // Framework Process.Start captures Console.InputEncoding for its redirected writer.
            Console.InputEncoding = new System.Text.UTF8Encoding(false);
            using (var process = Process.Start(start)) {
                process.StandardInput.WriteLine(serializer.Serialize(new { tool = tool, arguments = args }));
                process.StandardInput.Close();
                process.WaitForExit();
                return process.ExitCode;
            }
        } finally {
            Console.InputEncoding = previousEncoding;
        }
    }
}
'@
        if (!(Test-Path -LiteralPath (Join-Path $tools 'dotnet.exe'))) {
          [IO.File]::WriteAllText((Join-Path $tools 'host.cs'), $hostSource)
          $compiler = @'
param([string]$Directory)
Add-Type -Path (Join-Path $Directory 'host.cs') -OutputAssembly (Join-Path $Directory 'dotnet.exe') -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions
'@
          [IO.File]::WriteAllText((Join-Path $tools 'compile.ps1'), $compiler)
          & powershell.exe -NoProfile -NonInteractive -File (Join-Path $tools 'compile.ps1') -Directory $tools | Out-Host
          if ($LASTEXITCODE -ne 0) { throw 'Synthetic external executable compilation failed.' }
          foreach ($tool in @('node','ruby','func','az')) {
            Copy-Item -LiteralPath (Join-Path $tools 'dotnet.exe') -Destination (Join-Path $tools "$tool.exe")
          }
        }
      }
      $selection = $env:VALIDATION_SELECTION | ConvertFrom-Json -AsHashtable
      if ($env:VALIDATION_DISPLAY_PROFILE) { $selection.DisplayCoverage = $env:VALIDATION_DISPLAY_PROFILE }
      & $env:VALIDATION_SCRIPT -Scope $env:VALIDATION_SCOPE @selection
      $code = $LASTEXITCODE
      $after = Get-CallerEnvironment
      @{ before = $before; after = $after } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $env:VALIDATION_ENVIRONMENT
      exit $code
    `
  ], {
    cwd: directory, encoding: "utf8", timeout: Number(environment.VALIDATION_TIMEOUT_MS ?? 30_000),
    env: {
      ...process.env, VALIDATION_SCRIPT: join(directory, "scripts", "validate.ps1"),
      VALIDATION_SCOPE: scope, VALIDATION_CALLS: calls, TRMNL_RUBY: "ruby",
      VALIDATION_OWNED: owned ? "1" : "", VALIDATION_REAL_NODE: process.execPath,
      VALIDATION_SELECTION: JSON.stringify(selection),
      ...(owned ? { PLAYWRIGHT_BROWSERS_PATH: join(directory, ".tools", "playwright") } : {}),
      VALIDATION_ENVIRONMENT: join(directory, "environment.json"), ...environment
    }
    });
    if (owned) writeFileSync(join(directory, ".tools", "fixture", `result-${Date.now()}.json`),
      JSON.stringify(result));
    reportDirectory = result.stdout.match(/Timing report: (.+)/)?.[1].trim();
    return result;
  };
  return {
    directory, run,
    reportDirectory: () => reportDirectory,
    report: async () => JSON.parse(await readFile(join(reportDirectory, "summary.json"), "utf8")),
    environment: async () => JSON.parse(await readFile(join(directory, "environment.json"), "utf8")),
    calls: async () => (await readFile(calls, "utf8")).trim().split(/\r?\n/).map(JSON.parse)
  };
}

test("external tool fixture forwards literal UTF-8 JSON without a BOM under owned encoding", async t => {
  const fixture = await checkout(t, { owned: true });
  const initialized = fixture.run("Fast");
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  const tools = join(fixture.directory, ".tools", "fixture");
  const values = ["caf\u00e9 \u96ea \ud83d\ude80", 'quote " and backslash \\', "first\nsecond\r\nthird", ""];
  await writeFile(join(tools, "arguments.json"), JSON.stringify(values));
  await writeFile(join(tools, "command.ps1"), String.raw`
$ErrorActionPreference = 'Stop'
$stream = [Console]::OpenStandardInput()
$bytes = [IO.MemoryStream]::new()
$stream.CopyTo($bytes)
$raw = $bytes.ToArray()
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'stdin.bin'), $raw)
$text = [Text.UTF8Encoding]::new($false, $true).GetString($raw)
$request = $text | ConvertFrom-Json
$request | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'received.json')
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'), "$PID")
if ($request.arguments[0] -eq 'exit7') { exit 7 }
if ($request.arguments[0] -eq 'error') { throw 'Strict fixture native error' }
exit 0
`);
  const execute = arguments_ => {
    writeFileSync(join(tools, "arguments.json"), JSON.stringify(arguments_));
    return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$beforeInput = [Console]::InputEncoding
$beforeOutput = [Console]::OutputEncoding
$beforePipeline = $OutputEncoding
try {
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $literalArguments = @(Get-Content -LiteralPath (Join-Path $env:FIXTURE_PROTOCOL 'arguments.json') -Raw | ConvertFrom-Json)
    & (Join-Path $env:FIXTURE_PROTOCOL 'ruby.exe') @literalArguments
    $code = $LASTEXITCODE
} finally {
    [Console]::InputEncoding = $beforeInput
    [Console]::OutputEncoding = $beforeOutput
    $OutputEncoding = $beforePipeline
}
exit $code
`], {
    cwd: fixture.directory, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, FIXTURE_PROTOCOL: tools }
  });
  };
  const result = execute(values);
  const raw = await readFile(join(tools, "stdin.bin"));
  await writeFile(join(tools, "stdin-valid.bin"), raw);
  assert.deepEqual([...raw.subarray(0, 3)], [0x7b, 0x22, 0x74], result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const received = JSON.parse(await readFile(join(tools, "received.json"), "utf8"));
  assert.equal(received.tool, "ruby");
  assert.deepEqual(received.arguments, values);
  assert.equal(execute(["exit7"]).status, 7);
  const failure = execute(["error"]);
  assert.equal(failure.status, 1, failure.stdout + failure.stderr);
  assert.match(failure.stderr, /Strict fixture native error/);
  for (const input of ['{"tool":', "\ufeff" + JSON.stringify({ tool: "ruby", arguments: values })]) {
    const invalid = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(tools, "command.ps1")], {
      cwd: fixture.directory, input, encoding: "utf8", timeout: 10_000
    });
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(invalid.stderr, /Conversion from JSON failed/);
  }
  const child = (await readFile(join(tools, "child.pid"), "utf8")).trim();
  const cleanup = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `if (Get-Process -Id ${Number(child)} -ErrorAction SilentlyContinue) { exit 1 }`], {
    encoding: "utf8", timeout: 10_000
  });
  assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
});

test("public owned workers preserve assignment through build and report missing results truthfully", async t => {
  const fixture = await checkout(t, { owned: true });
  const planned = fixture.run("Fast", { VALIDATION_TIMEOUT_MS: "180000" }, { Execution: "Plan" });
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = join(fixture.reportDirectory(), "execution-plan.json");
  for (const id of ["node", "d1"]) {
    const worker = fixture.run("Full", { VALIDATION_TIMEOUT_MS: "180000", VALIDATION_MISSING_EVIDENCE: "1" },
      { Execution: "Worker", Component: id, ExecutionPlan: plan });
    assert.match(worker.stdout, /Timing report:/, worker.stdout + worker.stderr);
    const report = await fixture.report();
    assert.equal(report.components.find(component => component.id === "build").outcome, "success",
      worker.stdout + worker.stderr);
    assert.equal(worker.status, 1, worker.stdout + worker.stderr);
    assert.equal(report.outcome, "failed");
    assert.doesNotMatch(worker.stdout, /Execution component is not assigned|evidence_outcome.*cannot be found/);
    assert.equal(report.execution.component, id);
    assert.equal(report.components.find(component => component.id === (id === "node" ? "node" : "evidence")).outcome,
      id === "node" ? "incomplete" : "failure");
    assert.equal(report.evidence.status, "incomplete");
    assert.deepEqual((await fixture.environment()).after, (await fixture.environment()).before);
  }
});

test("public owned modes complete each assigned worker and preserve truthful aggregate failure", async t => {
  const fixture = await checkout(t, { owned: true });
  const environment = { VALIDATION_TIMEOUT_MS: "180000" };
  const planned = fixture.run("Fast", environment, { Execution: "Plan" });
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal((await fixture.report()).scope, "Plan");
  const planPath = join(fixture.reportDirectory(), "execution-plan.json");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  assert.deepEqual(plan.components.map(component => component.id), ["d1", "d2", "d3", "d4", "node"]);
  const incoming = join(fixture.directory, "artifacts", "components");
  await mkdir(incoming);
  const componentDirectories = {};
  for (const id of ["d1", "d2", "d3", "d4", "node"]) {
    await t.test(id, async () => {
      const workerFixture = id === "d1" ? fixture : await checkout(t, { owned: true });
      const worker = workerFixture.run("Full", environment, {
        Execution: "Worker", Component: id, ExecutionPlan: planPath
      });
      assert.equal(worker.status, 0, worker.stdout + worker.stderr);
      const report = await workerFixture.report();
      assert.equal(report.scope, "Component");
      assert.equal(report.outcome, "passed");
      assert.equal(report.execution.component, id);
      assert.ok(report.components.every(component => component.outcome === "success"));
      assert.equal(report.evidence.status, "complete");
      assert.equal(report.evidence.dotnet?.count ?? 0, id === "d1" ? 2 : id === "node" ? 0 : 1);
      assert.equal(report.evidence.node?.summary.tests ?? 0, id === "node" ? 2 : 0);
      assert.deepEqual((await workerFixture.environment()).after, (await workerFixture.environment()).before);
      const reportDirectory = workerFixture.reportDirectory();
      await mkdir(join(incoming, id));
      componentDirectories[id] = reportDirectory.split(/[\\/]/).at(-1);
      await cp(reportDirectory, join(incoming, id, componentDirectories[id]), { recursive: true });
    });
  }
  const jobResults = JSON.stringify({ d1: "success", d2: "success", d3: "success", d4: "success", node: "success" });
  const aggregated = fixture.run("Full", environment, {
    Execution: "Aggregate", ExecutionPlan: planPath, ReportsDirectory: incoming, JobResults: jobResults
  });
  assert.equal(aggregated.status, 0, aggregated.stdout + aggregated.stderr);
  const combined = await fixture.report();
  assert.equal(combined.outcome, "passed");
  assert.equal(combined.evidence.status, "complete");
  assert.equal(combined.evidence.dotnet.count, 5);
  assert.equal(combined.evidence.node.summary.tests, 2);
  const originalSeal = await readFile(join(incoming, "d1", componentDirectories.d1, "raw-manifest.json"), "utf8");
  for (const fault of ["after-seal", "missing", "extra", "hash", "provenance", "failed-job"]) {
    const altered = join(fixture.directory, "artifacts", `aggregate-negative-${fault}`);
    await cp(incoming, altered, { recursive: true });
    const component = join(altered, "d1", componentDirectories.d1);
    const phase = join(component, "phases-output-1.jsonl");
    if (fault === "after-seal") await writeFile(phase, await readFile(phase, "utf8") + "\n");
    if (fault === "missing") await rm(phase);
    if (fault === "extra") await writeFile(join(component, "unexpected.json"), "{}");
    if (fault === "hash") {
      const manifest = JSON.parse(originalSeal);
      manifest.files[0].sha256 = "0".repeat(64);
      await writeFile(join(component, "raw-manifest.json"), JSON.stringify(manifest));
    }
    const rejected = fixture.run("Full", {
      ...environment, ...(fault === "provenance" ? { GITHUB_RUN_ID: "999" } : {})
    }, {
      Execution: "Aggregate", ExecutionPlan: planPath, ReportsDirectory: altered,
      JobResults: fault === "failed-job" ? JSON.stringify({
        d1: "failure", d2: "success", d3: "success", d4: "success", node: "success"
      }) : jobResults
    });
    assert.equal(rejected.status, 1, fault + rejected.stdout + rejected.stderr);
    if (fault === "provenance") assert.match(rejected.stderr, /local execution plan cannot certify a hosted workflow run/);
    else {
      assert.equal((await fixture.report()).outcome, "failed", fault);
      if (["after-seal", "missing", "extra", "hash"].includes(fault))
        assert.match(rejected.stdout, /Component raw artifact|Component raw file/);
    }
    assert.equal(await readFile(join(incoming, "d1", componentDirectories.d1, "raw-manifest.json"), "utf8"),
      originalSeal);
  }
  const serial = fixture.run("Full", environment);
  assert.equal(serial.status, 0, serial.stdout + serial.stderr);
  const serialReport = await fixture.report();
  assert.equal(serialReport.scope, "Full");
  assert.equal(serialReport.evidence.dotnet.count, 5);
  assert.equal(serialReport.evidence.node.summary.tests, 2);
  assert.equal(serialReport.evidence.status, "complete");
  const missing = join(fixture.directory, "artifacts", "missing-components");
  await mkdir(missing);
  const aggregate = fixture.run("Full", environment, {
    Execution: "Aggregate", ExecutionPlan: planPath, ReportsDirectory: missing,
    JobResults: JSON.stringify({ d1: "success", d2: "success", d3: "success", d4: "success", node: "success" })
  });
  assert.equal(aggregate.status, 1, aggregate.stdout + aggregate.stderr);
  assert.equal((await fixture.report()).outcome, "failed");
  assert.doesNotMatch(aggregate.stdout, /evidence_outcome.*cannot be found/);
});

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

test("serial Full preserves an inherited discovery destination and restores its caller on success or failure", async t => {
  const fixture = await checkout(t);
  const discovery = join(fixture.directory, "previous-discovery.json");
  await writeFile(discovery, "previous-evidence-sentinel");
  for (const failure of ["", "dotnet:build"]) {
    const result = fixture.run("Full", { TRMNL_DISCOVERY_PATH: discovery, VALIDATION_FAIL: failure });
    assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
    assert.equal(await readFile(discovery, "utf8"), "previous-evidence-sentinel");
    const environment = await fixture.environment();
    assert.deepEqual(environment.after, environment.before);
  }
});

test("validation rejects Node releases without test summary events before dependent checks", async t => {
  for (const version of ["v22.0.0", "v22.1.0", "v21.7.3", "invalid"]) {
    const fixture = await checkout(t);
    const result = fixture.run("Full", { VALIDATION_NODE_VERSION: version });
    assert.equal(result.status, 1, version + result.stdout + result.stderr);
    assert.match(result.stdout, /Install Node\.js 22\.2\.0 or newer/);
    assert.ok(!(await fixture.calls()).some(call =>
      ["format", "build", "test", "--check", "--test"].includes(call.arguments[0])));
    assert.equal((await fixture.report()).components[0].outcome, "failure");
  }
  for (const version of ["v22.2.0", "v22.23.4", "v23.0.0", "v24.0.0"]) {
    const fixture = await checkout(t);
    const result = fixture.run("Full", { VALIDATION_NODE_VERSION: version });
    assert.equal(result.status, 0, version + result.stdout + result.stderr);
    assert.equal((await fixture.report()).provenance.tools.node, version);
  }
});

test("Fast emits bounded provenance and stage timings without claiming Full evidence", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Fast", { CONFIDENTIAL_INPUT: "must-not-appear-in-report" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = await fixture.report();
  assert.equal(report.scope, "Fast");
  assert.equal(report.outcome, "passed");
  assert.equal(report.evidence.status, "not-requested");
  assert.equal(report.provenance.evaluated_commit, null);
  assert.ok(report.unavailable.includes("git identity"));
  assert.equal(report.stages.length, 4);
  assert.ok(report.stages.every(stage => stage.result === "passed" && stage.duration_ms >= 0));
  assert.ok(report.duration_ms >= Math.max(...report.stages.map(stage => stage.duration_ms)));
  assert.ok(JSON.stringify(report).length < 100_000);
  assert.ok(!JSON.stringify(report).includes("must-not-appear-in-report"));
});

test("public reports bind exact event/evaluated identities and reject hidden working-tree identity", async t => {
  const fixture = await checkout(t);
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: fixture.directory, encoding: "utf8", timeout: 10_000,
      env: isolatedGitEnvironment({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(fixture.directory, "empty.gitconfig") })
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await writeFile(join(fixture.directory, ".gitignore"), "artifacts/\ncalls.jsonl\nenvironment.json\n");
  await writeFile(join(fixture.directory, "empty.gitconfig"), "");
  await writeFile(join(fixture.directory, "content.txt"), "synthetic evaluated input\n");
  git("init", "--quiet", "--template=");
  git("add", ".");
  git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic baseline");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const pins = { PR_HEAD_COMMIT: commit, PR_BASE_COMMIT: commit, GIT_DIR: join(fixture.directory, "foreign-git") };
  assert.equal(fixture.run("Fast", pins).status, 0);
  const report = await fixture.report();
  assert.equal(report.provenance.head_commit, commit);
  assert.equal(report.provenance.base_commit, commit);
  assert.equal(report.provenance.evaluated_commit, commit);
  assert.equal(report.provenance.evaluated_tree, tree);
  assert.equal(report.provenance.working_tree_clean, true);
  assert.match(report.content.started.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.content.unchanged, true);
  assert.deepEqual(report.content.finished, report.content.started);
  assert.match(report.component_contract_sha256, /^[a-f0-9]{64}$/);
  assert.ok(report.provenance.tools.git.startsWith("git version"));
  git("update-index", "--assume-unchanged", "content.txt");
  await writeFile(join(fixture.directory, "content.txt"), "hidden modification\n");
  assert.equal(fixture.run("Fast", pins).status, 0);
  const hidden = await fixture.report();
  assert.equal(hidden.provenance.working_tree_clean, null);
  assert.ok(hidden.unavailable.includes("clean evaluated content identity"));
  assert.notEqual(hidden.content.started.sha256, report.content.started.sha256);
  assert.equal(fixture.run("Fast", { ...pins, VALIDATION_MUTATE_INPUT: "1" }).status, 1);
  const changed = await fixture.report();
  assert.equal(changed.outcome, "failed");
  assert.equal(changed.content.unchanged, false);
});

test("Full fails closed when successful tools leave missing timing evidence", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", { VALIDATION_MISSING_EVIDENCE: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = await fixture.report();
  assert.equal(report.outcome, "failed");
  assert.equal(report.evidence.status, "incomplete");
  for (const name of ["complete .NET TRX results", "complete Node results", "complete rendering phase results"])
    assert.ok(report.unavailable.includes(name), name);
});

test("a Git checkout without resolvable evaluated identity cannot pass unbound validation", async t => {
  const fixture = await checkout(t);
  const initialized = spawnSync("git", ["init", "--quiet", "--template="], {
    cwd: fixture.directory, encoding: "utf8", timeout: 10_000,
    env: isolatedGitEnvironment({
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(fixture.directory, "empty.gitconfig")
    })
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = fixture.run("Fast");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = await fixture.report();
  assert.equal(report.outcome, "failed");
  assert.equal(report.content.error, "Git evaluated identity unavailable");
  assert.equal(report.components.find(component => component.id === "prerequisites").outcome, "failure");
  assert.equal(report.components.find(component => component.id === "build").outcome, "blocked");
});

test("Full reports a tooling failure before the rendering tail and records every unexecuted component", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", {
    VALIDATION_FAIL: "node:--test", VALIDATION_RENDER_DELAY_MS: "10000"
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const calls = await fixture.calls();
  assert.ok(calls.some(call => call.tool === "node" && call.arguments[0] === "--test"));
  assert.ok(!calls.some(call => call.tool === "dotnet" && call.arguments[0] === "test"),
    "An inexpensive tooling failure must not wait for production rendering");
  const report = await fixture.report();
  assert.deepEqual(report.components.map(component => component.id), [
    "prerequisites", "format", "build", "syntax", "browser", "node", "dotnet", "evidence"
  ]);
  assert.equal(report.components.find(component => component.id === "node").outcome, "failure");
  const rendering = report.components.find(component => component.id === "dotnet");
  assert.equal(rendering.outcome, "blocked");
  assert.deepEqual(rendering.blocked_by, ["node"]);
  assert.ok(report.first_failure_ms < report.duration_ms);
  assert.ok(report.first_failure_ms < 10000, "Useful failure feedback must precede the controlled rendering tail");
  assert.ok(report.components.every(component =>
    ["success", "failure", "blocked", "cancelled", "incomplete"].includes(component.outcome)));
});

test("Full reports per-test/class work and excludes nested Node costs from top-level work", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full");
  const report = await fixture.report();
  assert.equal(result.status, 0, result.stdout + result.stderr + JSON.stringify(report));
  assert.equal(report.evidence.status, "complete");
  assert.equal(report.evidence.dotnet.count, 2);
  assert.deepEqual(report.evidence.dotnet.classes, [
    { name: "Synthetic.Display", tests: 2, work_ms: 200 }
  ]);
  assert.equal(report.evidence.node.top_level_work_ms, 100);
  assert.equal(report.evidence.node.tests.length, 2);
  assert.deepEqual(report.evidence.dotnet.tests.map(test => [test.test_id, test.name]), [
    ["one", "All views"], ["two", "All scenarios"]
  ]);
  assert.match(report.evidence.inventory_sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.evidence.component_contract_sha256, report.component_contract_sha256);
  assert.equal(report.evidence.phases.display_coverage.length, 12);
  assert.deepEqual(report.evidence.phases.display_coverage.map(item => JSON.stringify(item)).sort(),
    report.evidence.phases.inventory.coverage.expected.map(item => JSON.stringify(item)).sort());
  assert.ok(report.components.every(component => component.outcome === "success"));
  const calls = await fixture.calls();
  assert.ok(calls.findIndex(call => call.tool === "node" && call.arguments[0] === "--test")
    < calls.findIndex(call => call.tool === "dotnet" && call.arguments[0] === "test"));
  assert.ok(report.duration_ms >= Math.max(...report.stages.map(stage => stage.duration_ms)));
});

test("Full explicitly selects OG-first or exhaustive coverage and restores the inherited diagnostic profile", async t => {
  const fixture = await checkout(t);
  const inventories = [];
  for (const profile of ["", "OgFirst", "Exhaustive"]) {
    const result = fixture.run("Full", {
      VALIDATION_DISPLAY_PROFILE: profile, TRMNL_DISPLAY_COVERAGE: "Exhaustive"
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Full validation PASSED/, result.stderr);
    const report = await fixture.report();
    inventories.push(report.evidence.inventory_sha256);
    assert.equal(report.display_coverage.profile, profile || "OgFirst");
    assert.equal((await fixture.calls()).filter(call => call.tool === "dotnet" && call.arguments[0] === "test")
      .at(-1).coverage, profile || "OgFirst");
    const environment = await fixture.environment();
    assert.deepEqual(environment.after, environment.before);
  }
  assert.equal(inventories[0], inventories[1], "The explicit and default OG-first inventories must agree");
  assert.notEqual(inventories[1], inventories[2], "The inventory digest must bind the chosen coverage profile");
});

test("Full cannot certify successful tests whose selected assertion completions are missing", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", { VALIDATION_MISSING_COVERAGE: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal((await fixture.report()).outcome, "failed");
});

test("Full rejects missing duplicate unexpected skipped failed or forged selected coverage", async t => {
  const fixture = await checkout(t);
  for (const fault of [
    "missing-pair", "duplicate", "unexpected", "wrong-profile", "wrong-variant",
    "skipped", "failed", "policy-changed", "forged-manifest"
  ]) {
    await t.test(fault, async () => {
      const result = fixture.run("Full", { VALIDATION_COVERAGE_FAULT: fault });
      assert.equal(result.status, 1, `${fault}: ${result.stdout}${result.stderr}`);
      const report = await fixture.report();
      assert.equal(report.outcome, "failed");
      assert.ok(report.unavailable.includes("complete rendering phase results"));
    });
  }
});

test("cancelled Node evidence and unfinished rendering phases cannot certify complete Full", async t => {
  const fixture = await checkout(t);
  for (const environment of [
    { VALIDATION_CANCELLED_NODE: "1" },
    { VALIDATION_CANCELLED_NODE: "1", VALIDATION_FAIL: "node:--test" },
    { VALIDATION_ABORTED_DOTNET: "1", VALIDATION_FAIL: "dotnet:test" },
    { VALIDATION_UNFINISHED_PHASE: "png.inspect" }
  ]) {
    const result = fixture.run("Full", environment);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = await fixture.report();
    assert.equal(report.outcome, "failed");
    assert.equal(report.evidence.status, "incomplete");
    const component = report.components.find(component =>
      component.id === (environment.VALIDATION_CANCELLED_NODE ? "node" : "dotnet"));
    assert.equal(component.outcome,
      environment.VALIDATION_CANCELLED_NODE || environment.VALIDATION_ABORTED_DOTNET ? "cancelled" : "incomplete");
    if (environment.VALIDATION_CANCELLED_NODE)
      assert.equal(report.components.find(component => component.id === "dotnet").outcome, "blocked");
  }
});

test("reported test failures cannot become success even if a test tool exits zero", async t => {
  const fixture = await checkout(t);
  for (const tool of ["dotnet", "node"]) {
    const result = fixture.run("Full", { VALIDATION_REPORTED_FAILURE: tool });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = await fixture.report();
    assert.equal(report.outcome, "failed");
    assert.equal(report.evidence.status, "failed");
  }
});

test("failed run summaries and individual Node events cannot be overridden by passing peers", async t => {
  for (const [environment, component] of [
    [{ VALIDATION_FAILED_TRX_SUMMARY: "1" }, "dotnet"],
    [{ VALIDATION_FAILED_NODE_EVENT: "1" }, "node"]
  ]) {
    await t.test(component, async t => {
      const fixture = await checkout(t);
      const result = fixture.run("Full", environment);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = await fixture.report();
      assert.equal(report.outcome, "failed");
      assert.equal(report.components.find(item => item.id === component).outcome, "failure");
      assert.equal(report.evidence.status, "failed");
      if (component === "node") {
        assert.equal(report.components.find(item => item.id === "dotnet").outcome, "blocked");
        assert.ok(!(await fixture.calls()).some(call => call.arguments[0] === "test"));
      }
    });
  }
});

test("an interruption after successful evidence cannot become successful Full on a later report write", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", { VALIDATION_FINAL_STAGE_SAVE_FAIL: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Validation interrupted: Synthetic final-stage report write failure/);
  assert.equal((await fixture.report()).outcome, "failed");
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
});

test("expected rendering errors and owned supersession stay visible without failing passing tests", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", { VALIDATION_EXPECTED_RENDER_FAILURE: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = await fixture.report();
  assert.equal(report.evidence.status, "complete");
  assert.equal(report.evidence.phases.interrupted_child_phases, 1);
  assert.ok(report.evidence.phases.totals.some(phase => phase.failed === 1));
});

test("a terminated public validation leaves an incomplete report with its active stage", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Fast", { VALIDATION_PAUSE: "1", VALIDATION_TIMEOUT_MS: "5000" });
  assert.ok(result.error || result.status !== 0);
  const report = await fixture.report();
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.finished_at, null);
  assert.ok(report.stages.some(stage => stage.name === "C# formatting (read-only)" && stage.result === "running"));
  assert.equal(report.components.find(component => component.id === "format").outcome, "incomplete");
  assert.equal(report.components.find(component => component.id === "build").outcome, "incomplete");
});

test("a cooperatively cancelled component stays cancelled, blocks rendering and restores its caller environment", async t => {
  const fixture = await checkout(t);
  const result = fixture.run("Full", {
    VALIDATION_CANCEL_TOOL: "dotnet:build", TRMNL_TIMING_DIRECTORY: "caller-timing",
    AZURE_BICEP_CHECK_VERSION: "true"
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = await fixture.report();
  assert.equal(report.components.find(component => component.id === "build").outcome, "cancelled");
  assert.equal(report.components.find(component => component.id === "dotnet").outcome, "blocked");
  assert.equal(report.stages.find(stage => stage.name === ".NET build (warnings as errors)").result, "cancelled");
  const { before, after } = await fixture.environment();
  assert.deepEqual(after, before);
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
  const settings = tests.arguments.indexOf("--settings");
  assert.ok(settings >= 0, "Complete Serial Full must apply the same bounded xUnit settings as workers");
  assert.equal(tests.arguments[settings + 1], join(fixture.directory, "tests", "validation-partitions.runsettings"));
  const nodeTests = calls.find(call => call.tool === "node" && call.arguments[0] === "--test");
  assert.ok(nodeTests.arguments.includes("--test-concurrency=4"),
    "Complete Node execution must retain the measured top-level file concurrency bound");
  const expectedFiles = (await Promise.all(["delivery", "validation"].map(async directory =>
    (await readdir(join(fixture.directory, "tests", directory)))
      .filter(name => name.endsWith(".test.mjs"))
      .map(name => join(fixture.directory, "tests", directory, name))))).flat().sort();
  assert.deepEqual(nodeTests.arguments.filter(argument => argument.endsWith(".test.mjs")).sort(), expectedFiles);
  assert.ok(!nodeTests.arguments.some(argument => argument.startsWith("--test-name-pattern")));
  for (const name of [
    "deployment.test.mjs", "deploy-command.test.mjs", "smoke.test.mjs", "validation.test.mjs", "hooks.test.mjs",
    "setup-display.test.mjs"
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
    if (failure === "dotnet:build") {
      assert.match(result.stdout, /\.NET tests \(production rendering\)\s+BLOCKED/);
      assert.match(result.stdout, /Node delivery and guardrail tests\s+BLOCKED/);
      const report = await fixture.report();
      assert.deepEqual(report.components.find(component => component.id === "node").blocked_by, ["build", "browser"]);
    }
    if (failure === "dotnet:test")
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

test("Full diagnoses missing or unusable pinned Chromium before running production tests", async t => {
  const fixture = await checkout(t);
  for (const environment of [{ VALIDATION_BROWSER_FAIL: "1" }, { VALIDATION_BROWSER_THROW: "1" }]) {
    const result = fixture.run("Full", environment);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Chromium.*FAILED/s);
    assert.match(result.stdout, /Chromium.*setup-display/s);
    assert.match(result.stdout, /\.NET tests \(production rendering\)\s+BLOCKED/);
    const report = await fixture.report();
    assert.equal(report.components.find(component => component.id === "node").outcome, "blocked");
    assert.deepEqual(report.components.find(component => component.id === "node").blocked_by, ["browser"]);
  }
  const calls = await fixture.calls();
  assert.ok(!calls.some(call => call.tool === "dotnet" && call.arguments[0] === "test"));
  assert.ok(!calls.some(call => call.tool === "node" && call.arguments[0] === "--test"));
  assert.ok(!calls.some(call => call.arguments.includes("install") || call.arguments.includes("restore")));
});

test("Full requires the selected Ruby major and locked Bundler but never invokes native build tools", async t => {
  const fixture = await checkout(t);
  for (const [environment, guidance] of [
    [{ VALIDATION_FAIL: "bundler" }, /Bundler 4\.0\.20.*gem install bundler/s],
    [{ VALIDATION_RUBY_VERSION: "3.4.5" }, /Ruby 4 is required.*3\.4\.5/s]
  ]) {
    const result = fixture.run("Full", environment);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, guidance);
    assert.match(result.stdout, /\.NET tests \(production rendering\)\s+BLOCKED/);
  }
  const fast = fixture.run("Fast", { VALIDATION_MISSING: "ruby", VALIDATION_BROWSER_FAIL: "1" });
  assert.equal(fast.status, 0, fast.stdout + fast.stderr);
  const calls = await fixture.calls();
  assert.ok(!calls.some(call => call.tool === "dotnet" && call.arguments[0] === "test"));
  assert.ok(!calls.some(call => (call.arguments.join(" ")).includes("mkmf")));
});

test("validation scopes certificate and project environments and restores caller values on success or failure", async t => {
  const fixture = await checkout(t);
  const selected = join(fixture.directory, "shared Ruby with spaces", "ruby.exe");
  for (const scope of ["Fast", "Full"]) {
    for (const failure of ["", "dotnet:--version"]) {
      const result = fixture.run(scope, {
        DOTNET_GENERATE_ASPNET_CERTIFICATE: "true", VALIDATION_FAIL: failure,
        VALIDATION_SELECTED_RUBY: selected,
        BUNDLE_PATH: join(fixture.directory, "peer", "gems"),
        BUNDLE_APP_CONFIG: join(fixture.directory, "peer", "config"),
        BUNDLE_GEMFILE: join(fixture.directory, "peer", "Gemfile"),
        BUNDLE_WITHOUT: "display", BUNDLE_FROZEN: "false"
      });

      assert.equal(result.status, failure ? 1 : 0, result.stdout + result.stderr);
      const { before, after } = await fixture.environment();
      assert.deepEqual(after, before);
    }
  }
  const calls = await fixture.calls();
  for (const call of calls.filter(call => call.tool === "dotnet" || call.tool === "node"))
    assert.equal(call.certificate, "false", `Certificate generation enabled in ${call.tool} ${call.arguments[0]}`);
  const production = calls.find(call => call.tool === "dotnet" && call.arguments[0] === "test");
  assert.equal(production.ruby, selected);
  assert.equal(production.bundlePath, join(fixture.directory, "vendor", "bundle"));
});

test("Full rejects incomplete pinned assets even when an unrelated font is present", async t => {
  const fixture = await checkout(t);
  const css = join(fixture.directory, ".tools", "framework", "css", "3.4.3", "plugins.css");
  await writeFile(css, '@font-face{src:url("/fonts/synthetic.woff2")} @font-face{src:url("/fonts/missing.ttf")}');
  const missingFont = fixture.run("Full");
  assert.equal(missingFont.status, 1, missingFont.stdout + missingFont.stderr);
  assert.match(missingFont.stdout, /fonts.*setup-display/s);
  await writeFile(css, '@font-face{src:url("/fonts/synthetic.woff2")}');
  await writeFile(join(fixture.directory, ".tools", "framework", "js", "3.4.3", "plugins.js"), "");
  const emptyAsset = fixture.run("Full");
  assert.equal(emptyAsset.status, 1, emptyAsset.stdout + emptyAsset.stderr);
  assert.match(emptyAsset.stdout, /pinned TRMNL framework asset.*setup-display/s);
  assert.ok(!(await fixture.calls()).some(call => ["test", "--test"].includes(call.arguments[0])));
});

test("validation diagnoses missing, unsupported and unusable SDKs before dependent checks", async t => {
  const fixture = await checkout(t);
  for (const environment of [
    { VALIDATION_MISSING: "dotnet" }, { VALIDATION_SDK_VERSION: "9.0.100" },
    { VALIDATION_FAIL: "dotnet:--version" }, { VALIDATION_FAIL: "dotnet:throw" }
  ]) {
    const result = fixture.run("Fast", { DOTNET_GENERATE_ASPNET_CERTIFICATE: "true", ...environment });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Install.*\.NET 10 SDK|\.NET 10 SDK.*Install/s);
    assert.match(result.stdout, /BLOCKED/);
    assert.match(result.stdout, /Fast validation FAILED/);
    const { before, after } = await fixture.environment();
    assert.deepEqual(after, before);
  }
  assert.ok(!(await fixture.calls()).some(call => ["format", "build", "test", "--check", "--test"].includes(call.arguments[0])));
});
