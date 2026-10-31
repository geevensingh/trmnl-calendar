#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('Fast', 'Full')][string]$Scope = 'Fast',
    [ValidateSet('OgFirst', 'Exhaustive', IgnoreCase = $false)][string]$DisplayCoverage = 'OgFirst',
    [ValidateSet('Serial', 'Plan', 'Worker', 'Aggregate')][string]$Execution = 'Serial',
    [ValidateSet('d1', 'd2', 'd3', 'd4', 'node')][string]$Component,
    [string]$ExecutionPlan,
    [string]$ReportsDirectory,
    [string]$JobResults
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'display-toolchain.ps1')
. (Join-Path $PSScriptRoot 'validation-report.ps1')
. (Join-Path $PSScriptRoot 'validation-scheduling.ps1')
$modeInputs = @{
    Serial = @(); Plan = @()
    Worker = @('Component', 'ExecutionPlan')
    Aggregate = @('ExecutionPlan', 'ReportsDirectory', 'JobResults')
}
if (($Execution -eq 'Plan' -and $Scope -ne 'Fast') -or
    ($Execution -in @('Worker', 'Aggregate') -and $Scope -ne 'Full') -or
    ($Execution -eq 'Worker' -and (!$Component -or !$ExecutionPlan)) -or
    ($Execution -eq 'Aggregate' -and (!$ExecutionPlan -or !$ReportsDirectory -or !$JobResults)) -or
    @(@('Component', 'ExecutionPlan', 'ReportsDirectory', 'JobResults') | Where-Object {
        $PSBoundParameters.ContainsKey($_) -and $_ -notin $modeInputs[$Execution]
    }).Count) {
    throw 'Invalid execution mode: Plan requires Fast; Worker/Aggregate require Full and their explicit bound inputs.'
}
$providedPlan = $null
$localRun = $null
$workerExpected = $null
$workerEnvironment = $null
$cleanupFailed = $false
$savedToolExecutor = Get-Variable -Name DisplayToolExecutor -Scope Script -ErrorAction SilentlyContinue
if ($savedToolExecutor) { $savedToolExecutor = @{ Value = $savedToolExecutor.Value } }
if ($Execution -in @('Worker', 'Aggregate')) {
    if ((Get-Item -LiteralPath $ExecutionPlan).Length -gt 10MB) { throw 'Execution plan exceeds its size bound.' }
    $providedPlan = Get-Content -LiteralPath $ExecutionPlan -Raw | ConvertFrom-Json
    if ($providedPlan.coverage.profile -cne $DisplayCoverage) { throw 'Execution plan coverage profile mismatch.' }
    if ($providedPlan.context.run_id -clike 'local-*') {
        if ($env:GITHUB_RUN_ID) { throw 'A local execution plan cannot certify a hosted workflow run.' }
        $localRun = $providedPlan.context.run_id
    }
}
elseif ($Execution -eq 'Plan' -and !$env:GITHUB_RUN_ID) {
    $localRun = "local-$([Guid]::NewGuid().ToString('N'))"
}
$savedEnvironment = Save-DisplayEnvironment
$savedTimingDirectory = $env:TRMNL_TIMING_DIRECTORY
$savedCoverageProfile = $env:TRMNL_DISPLAY_COVERAGE
$location = Get-Location
$project = Join-Path $root 'tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj'
$results = [Collections.Generic.List[object]]::new()
$components = @(Get-ValidationComponents $Scope $(if ($Execution -eq 'Worker') { $Component } else { '' }))
if ($Execution -eq 'Plan') {
    $components += [ordered]@{ id = 'plan'; name = 'Complete execution inventory'; requires = @('prerequisites', 'format', 'build', 'syntax')
        outcome = 'incomplete'; evidence_outcome = $null; blocked_by = @() }
}
$reportScope = if ($Execution -eq 'Worker') { 'Component' } elseif ($Execution -eq 'Plan') { 'Plan' } else { $Scope }
if ($Execution -in @('Plan', 'Worker')) { Assert-ValidationWorkerWorkspace $root }
elseif ($Execution -eq 'Aggregate') {
    Assert-ValidationPhysicalDestination (Join-Path $root 'artifacts\validation')
}
New-ValidationReport $root $reportScope $components
if ($localRun) {
    $script:validationReport.provenance.run_id = $localRun
    $script:validationReport.provenance.run_attempt = '1'
    $script:validationReport.provenance.run_source = 'local'
    Save-ValidationReport
}
if ($Scope -eq 'Full') {
    $script:validationRoot = $root
    $script:coveragePlan = Get-DisplayCoverageInventory $root $DisplayCoverage
    $script:coveragePlan | ConvertTo-Json -Depth 10 |
        Set-Content -LiteralPath (Join-Path $script:validationDirectory 'coverage-plan.json') -Encoding utf8
    $script:validationReport.display_coverage = [ordered]@{
        profile = $DisplayCoverage
        policy_id = $script:coveragePlan.policy_id
        policy_sha256 = $script:coveragePlan.policy_sha256
        expected_assertions = $script:coveragePlan.expected.Count
        intentionally_omitted_assertions = $script:coveragePlan.omitted.Count
    }
    Save-ValidationReport
}

function Invoke-Tool([string]$Command, [string[]]$Arguments, [string]$Hint) {
    $previousBicepCheck = $env:AZURE_BICEP_CHECK_VERSION
    try {
        $env:AZURE_BICEP_CHECK_VERSION = 'false'
        if ($Execution -ne 'Serial') {
            Invoke-ValidationOwnedTool $Command $Arguments $root
            return
        }
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            $error = [InvalidOperationException]::new("$Command exited with code $LASTEXITCODE. $Hint")
            $error.Data['tool_exit_code'] = $LASTEXITCODE
            throw $error
        }
    }
    finally {
        $env:AZURE_BICEP_CHECK_VERSION = $previousBicepCheck
    }
}

function Invoke-Check([string]$Id, [scriptblock]$Check) {
    $component = $script:validationReport.components | Where-Object id -EQ $Id
    $Name = $component.name
    $blocked = @($component.requires | Where-Object {
        ($script:validationReport.components | Where-Object id -EQ $_).outcome -ne 'success'
    })
    if ($blocked.Count) {
        $component.outcome = 'blocked'
        $component.blocked_by = $blocked
        $results.Add([pscustomobject]@{ Check = $Name; Result = 'BLOCKED'; Seconds = 0 })
        $stage = Start-ValidationStage $Name
        Stop-ValidationStage $stage 'blocked'
        return $false
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $stage = Start-ValidationStage $Name
    Write-Host "`n== $Name =="
    $passed = $false
    try {
        & $Check | Out-Host
        $passed = $true
        $component.outcome = 'success'
    }
    catch {
        $component.outcome = if ($component.evidence_outcome -eq 'cancelled' -or
            $_.Exception -is [OperationCanceledException] -or
            $_.Exception -is [Management.Automation.PipelineStoppedException]) { 'cancelled' }
        elseif ($_.Exception.Data.Contains('tool_exit_code')) { 'failure' }
        elseif ($component.evidence_outcome -and $component.evidence_outcome -ne 'success') {
            $component.evidence_outcome
        } else { 'failure' }
        Write-Host "[FAIL] ${Name}: $($_.Exception.Message)"
    }
    $stageResult = if ($passed) { 'passed' } elseif ($component.outcome -eq 'cancelled') { 'cancelled' } else { 'failed' }
    $results.Add([pscustomobject]@{
        Check = $Name
        Result = $stageResult.ToUpperInvariant()
        Seconds = [Math]::Round($timer.Elapsed.TotalSeconds, 1)
    })
    Stop-ValidationStage $stage $stageResult
    return $passed
}

try {
    Set-Location -LiteralPath $root
    if ($Execution -eq 'Aggregate') {
        $workerEnvironment = Enter-ValidationWorkerEnvironment $root $script:validationDirectory
        $script:validationReport.execution = [ordered]@{ isolation = $workerEnvironment.isolation }
        Save-ValidationReport
        Invoke-ValidationAggregation $root $providedPlan $ExecutionPlan $ReportsDirectory $JobResults
    } else {
        if ($Execution -in @('Plan', 'Worker')) {
            $workerEnvironment = Enter-ValidationWorkerEnvironment $root $script:validationDirectory
            $script:DisplayToolExecutor = {
                param([string]$Command, [string[]]$Arguments)
                if ([IO.Path]::GetExtension($Command) -ieq '.ps1') {
                    $Arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Command) + $Arguments
                    $Command = Join-Path $PSHOME 'pwsh.exe'
                }
                Invoke-ValidationOwnedTool $Command $Arguments $root -TimeoutSeconds 60
                $global:LASTEXITCODE = 0
            }
            if ($Execution -eq 'Worker') {
                $script:validationReport.execution = [ordered]@{
                    component = $Component; plan_sha256 = $providedPlan.sha256
                    isolation = $workerEnvironment.isolation
                }
                Save-ValidationReport
            } else {
                $script:validationReport.execution = [ordered]@{ isolation = $workerEnvironment.isolation }
                Save-ValidationReport
            }
            if ($env:GITHUB_OUTPUT) {
                "report_directory=$([IO.Path]::GetRelativePath($root, $script:validationDirectory))" >> $env:GITHUB_OUTPUT
            }
        }
        $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
        if ($Scope -eq 'Full') { Set-DisplayEnvironment $root }
        if ($Scope -eq 'Full') {
            $env:TRMNL_TIMING_DIRECTORY = $script:validationDirectory
            $env:TRMNL_DISPLAY_COVERAGE = $DisplayCoverage
            Write-Host "Display coverage: $DisplayCoverage (explicit selected policy; not necessarily exhaustive six-view coverage)."
        }

        $null = Invoke-Check 'prerequisites' {
            if ($script:validationReport.content.error) { throw 'Evaluated input fingerprint is unavailable; validation cannot bind this execution.' }
            Assert-DisplaySdk
            if (!(Get-Command node -ErrorAction SilentlyContinue)) {
                throw 'Install Node.js 22 or newer and add node to PATH. No npm install is needed.'
            }
            $nodeVersion = Invoke-DisplayCommand node @('--version')
            if ($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
                throw 'Install Node.js 22 or newer. No npm install is needed.'
            }
            $script:validationReport.provenance.tools.node = "$nodeVersion"
            $script:validationReport.provenance.tools.dotnet = $script:DisplaySdkVersion
            foreach ($directory in @('src\CalendarAgenda', 'tests\CalendarAgenda.Tests')) {
                if (!(Test-Path -LiteralPath (Join-Path $root "$directory\obj\project.assets.json") -PathType Leaf)) {
                    throw "Missing restored .NET dependencies in $directory. Run dotnet restore .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj or .\scripts\setup-display.ps1."
                }
            }
            if ($Scope -eq 'Full') {
                $runtimes = (Invoke-DisplayCommand dotnet @('--list-runtimes')) -join "`n"
                if ($LASTEXITCODE -ne 0 -or $runtimes -notmatch '(?m)^Microsoft\.NETCore\.App 10\.' -or
                    $runtimes -notmatch '(?m)^Microsoft\.AspNetCore\.App 10\.') {
                    throw 'Install the .NET 10 and ASP.NET Core 10 runtimes required by the production test host.'
                }
                $script:validationReport.provenance.tools.dotnet_runtimes = @(
                    $runtimes -split "`n" | ForEach-Object { ($_ -split ' \[', 2)[0] })
                foreach ($command in @('pwsh', 'git', 'func', 'az')) {
                    if (!(Get-Command $command -ErrorAction SilentlyContinue)) {
                        throw "Missing $command on PATH. Full validation needs PowerShell 7, Git, Azure Functions Core Tools v4, and Azure CLI with Bicep. See README.md#local-prerequisites."
                    }
                }
                $functionsVersion = Invoke-DisplayCommand func @('--version')
                if ($LASTEXITCODE -ne 0 -or "$functionsVersion" -notmatch '^4\.') {
                    throw 'Install Azure Functions Core Tools v4 with .NET 10 support and add func to PATH.'
                }
                $script:validationReport.provenance.tools.functions = "$functionsVersion"
                $bicepVersion = Invoke-Tool az @('bicep', 'version') 'Install Bicep once with az bicep install before full validation. No Azure login is required.'
                $bicepVersion | Out-Host
                $script:validationReport.provenance.tools.bicep = "$bicepVersion"
                $toolchain = Get-DisplayToolchain $root
                $script:validationReport.provenance.tools.ruby = $script:DisplayRubyVersion
                $script:validationReport.provenance.tools.bundler = $toolchain.BundlerVersion
                $env:TRMNL_RUBY = $toolchain.Ruby
                Assert-DisplayGems $toolchain
                foreach ($asset in @('css\3.4.3\plugins.css', 'js\3.4.3\plugins.js')) {
                    if (!(Test-DisplayFile (Join-Path $root ".tools\framework\$asset"))) {
                        throw "Missing pinned TRMNL framework asset $asset. Run .\scripts\setup-display.ps1."
                    }
                }
                $fonts = Join-Path $root '.tools\framework\fonts'
                if (!(Test-DisplayFonts (Join-Path $root '.tools\framework') $fonts)) {
                    throw 'Missing or empty TRMNL framework fonts referenced by the pinned CSS. Run .\scripts\setup-display.ps1.'
                }
            }
        }

        $null = Invoke-Check 'format' {
            $arguments = @('format')
            if ($Scope -eq 'Fast') { $arguments += 'whitespace' }
            $arguments += @($project, '--no-restore', '--verify-no-changes', '--verbosity', 'quiet')
            Invoke-Tool dotnet $arguments `
                'Fix the reported formatting explicitly; validation never rewrites source.'
        }

        $null = Invoke-Check 'build' {
            $arguments = @('build', $project, '--no-restore', '--nologo', '--verbosity', 'quiet')
            if ($Execution -in @('Plan', 'Worker')) { $arguments += '--disable-build-servers' }
            Invoke-Tool dotnet $arguments `
                'Fix compiler errors/warnings; restore missing dependencies with .\scripts\setup-display.ps1.'
            if ($Execution -eq 'Worker') {
                $freshPlan = New-ValidationExecutionPlan $root $DisplayCoverage
                if ($freshPlan.sha256 -cne $providedPlan.sha256 -or
                    (Get-ValidationDigest $freshPlan) -cne (Get-ValidationDigest $providedPlan)) {
                    throw 'Independent worker discovery/content/contract does not match the execution plan.'
                }
                $script:workerExpected = $freshPlan.components | Where-Object id -CEQ $Component
                if (!$script:workerExpected) { throw 'Execution component is not assigned.' }
                $script:coverageSubset = @($script:workerExpected.expected_coverage)
            }
        }

        $null = Invoke-Check 'syntax' {
            foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File) {
                $parseErrors = $null
                $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$parseErrors)
                if ($parseErrors.Count -gt 0) {
                    throw "$($file.Name): $($parseErrors.Message -join '; ')"
                }
            }
            foreach ($directory in @('scripts', 'display\workbench', 'tests\delivery', 'tests\validation')) {
                foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $directory) -Filter '*.mjs' -File) {
                    Invoke-Tool node @('--check', $file.FullName) 'Fix the reported JavaScript syntax.'
                }
            }
        }

        if ($Execution -eq 'Plan') {
            $null = Invoke-Check 'plan' { $null = New-ValidationExecutionPlan $root $DisplayCoverage }
        }
        if ($Scope -eq 'Full') {
            $null = Invoke-Check 'browser' {
                if (!(Test-DisplayBrowser $root)) {
                    throw 'Pinned Chromium is not ready. Run .\scripts\setup-display.ps1 with the selected browser cache before Full validation.'
                }
            }

            if ($Execution -ne 'Worker' -or $Component -eq 'node') { $null = Invoke-Check 'node' {
                $files = @(Get-ValidationNodeFiles $root)
                $script:validationReport.node_files = @($files | ForEach-Object { [IO.Path]::GetRelativePath($root, $_) })
                Save-ValidationReport
                try {
                    Invoke-Tool node (@('--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
                        "--test-reporter=$(([uri](Join-Path $PSScriptRoot 'node-timing-reporter.mjs')).AbsoluteUri)",
                        "--test-reporter-destination=$(Join-Path $script:validationDirectory 'node.jsonl')") + $files) `
                        'Fix the reported local tooling test failures; no npm packages or Azure login are required.'
                }
                finally { $nodeEvidenceReady = Read-ValidationEvidence -NodeOnly -Component:($Execution -eq 'Worker') }
                if (!$nodeEvidenceReady) {
                    throw 'Node result evidence is failed, cancelled or incomplete; production rendering is blocked.'
                }
            } }
            if ($Execution -ne 'Worker' -or $Component -ne 'node') { $null = Invoke-Check 'dotnet' {
                $arguments = @('test', $project, '--no-build', '--no-restore', '--nologo', '--verbosity', 'minimal',
                    '--logger', 'trx;LogFileName=dotnet.trx', '--results-directory', $script:validationDirectory)
                if ($Execution -eq 'Worker') {
                    $arguments += @('--settings', (Join-Path $root 'tests\validation-partitions.runsettings'),
                        '--filter', $script:workerExpected.filter)
                }
                Invoke-Tool dotnet $arguments `
                    'Fix the reported synthetic test failure. For missing Liquid/framework/fonts/Chromium, run .\scripts\setup-display.ps1. The real local host needs Core Tools v4.'
            } }
            $null = Invoke-Check 'evidence' {
                $ready = if ($Execution -eq 'Worker') {
                    if ($Component -eq 'node') { Read-ValidationEvidence -NodeOnly -Component }
                    else { Read-ValidationEvidence -DotnetOnly }
                } else { Read-ValidationEvidence }
                if (!$ready) {
                    throw "Timing evidence is incomplete. See $script:validationDirectory\summary.json; do not retry a profiling attempt without budget allocation."
                }
            }
        }
    }
}
catch {
    Write-Host "[FAIL] Validation interrupted: $($_.Exception.Message)"
}
finally {
    try {
        if ($workerEnvironment) { Exit-ValidationWorkerEnvironment $workerEnvironment }
    }
    catch {
        $cleanupFailed = $true
        Write-Host "[FAIL] Worker cleanup: $($_.Exception.Message)"
    }
    finally {
        if ($savedToolExecutor) { $script:DisplayToolExecutor = $savedToolExecutor.Value }
        else { Remove-Variable -Name DisplayToolExecutor -Scope Script -ErrorAction SilentlyContinue }
        Restore-DisplayEnvironment $savedEnvironment
        $env:TRMNL_TIMING_DIRECTORY = $savedTimingDirectory
        $env:TRMNL_DISPLAY_COVERAGE = $savedCoverageProfile
        Set-Location -LiteralPath $location.Path
    }
}

Write-Host ''
$results | Format-Table -AutoSize | Out-Host
$failed = $cleanupFailed -or @($script:validationReport.components | Where-Object outcome -NE 'success').Count -gt 0
if ($script:validationReport.content.started) {
    try {
        $script:validationReport.content.finished = Get-ValidationInputFingerprint $root
        $script:validationReport.content.unchanged = $null -ne $script:validationReport.content.finished -and
            $script:validationReport.content.started.sha256 -ceq $script:validationReport.content.finished.sha256
    }
    catch {
        $script:validationReport.content.unchanged = $false
        Write-Host "[FAIL] Evaluated input fingerprint: $($_.Exception.Message)"
    }
    if (!$script:validationReport.content.unchanged) {
        $failed = $true
        $script:validationReport.unavailable.Add('unchanged evaluated input fingerprint')
        Write-Host '[FAIL] Evaluated inputs changed during validation; this execution cannot certify the final content.'
    }
}
$outcome = if ($failed) { 'FAILED' } else { 'PASSED' }
Complete-ValidationReport (!$failed)
if ($Execution -eq 'Worker') { Write-ValidationRawManifest $script:validationDirectory }
Write-Host "$reportScope validation $outcome."
if ($failed) { exit 1 }
exit 0
