#Requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Fast', 'Full')][string]$Scope = 'Fast')

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$project = Join-Path $root 'tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj'
$results = [Collections.Generic.List[object]]::new()

function Invoke-Tool([string]$Command, [string[]]$Arguments, [string]$Hint) {
    $previousBicepCheck = $env:AZURE_BICEP_CHECK_VERSION
    try {
        $env:AZURE_BICEP_CHECK_VERSION = 'false'
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Command exited with code $LASTEXITCODE. $Hint"
        }
    }
    finally {
        $env:AZURE_BICEP_CHECK_VERSION = $previousBicepCheck
    }
}

function Invoke-Check([string]$Name, [scriptblock]$Check, [bool]$Ready = $true) {
    if (!$Ready) {
        $results.Add([pscustomobject]@{ Check = $Name; Result = 'BLOCKED'; Seconds = 0 })
        return $false
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "`n== $Name =="
    $passed = $false
    try {
        & $Check | Out-Host
        $passed = $true
    }
    catch {
        Write-Host "[FAIL] ${Name}: $($_.Exception.Message)"
    }
    $results.Add([pscustomobject]@{
        Check = $Name
        Result = if ($passed) { 'PASSED' } else { 'FAILED' }
        Seconds = [Math]::Round($timer.Elapsed.TotalSeconds, 1)
    })
    return $passed
}

$ready = Invoke-Check 'Prerequisites' {
    if (!(Get-Command dotnet -ErrorAction SilentlyContinue)) {
        throw 'Install the .NET 10 SDK selected by global.json and add dotnet to PATH.'
    }
    $sdk = & dotnet --version
    if ($LASTEXITCODE -ne 0 -or "$sdk" -notmatch '^10\.') {
        throw 'The .NET 10 SDK selected by global.json is unavailable. Install it before validation.'
    }
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Install Node.js 22 or newer and add node to PATH. No npm install is needed.'
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0 -or "$nodeVersion" -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        throw 'Install Node.js 22 or newer. No npm install is needed.'
    }
    foreach ($directory in @('src\CalendarAgenda', 'tests\CalendarAgenda.Tests')) {
        if (!(Test-Path -LiteralPath (Join-Path $root "$directory\obj\project.assets.json") -PathType Leaf)) {
            throw "Missing restored .NET dependencies in $directory. Run dotnet restore .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj or .\scripts\setup-display.ps1."
        }
    }
    if ($Scope -eq 'Full') {
        $runtimes = (& dotnet --list-runtimes) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $runtimes -notmatch '(?m)^Microsoft\.NETCore\.App 10\.' -or
            $runtimes -notmatch '(?m)^Microsoft\.AspNetCore\.App 10\.') {
            throw 'Install the .NET 10 and ASP.NET Core 10 runtimes required by the production test host.'
        }
        foreach ($command in @('pwsh', 'git', 'func', 'az')) {
            if (!(Get-Command $command -ErrorAction SilentlyContinue)) {
                throw "Missing $command on PATH. Full validation needs PowerShell 7, Git, Azure Functions Core Tools v4, and Azure CLI with Bicep. See README.md#local-prerequisites."
            }
        }
        $functionsVersion = & func --version
        if ($LASTEXITCODE -ne 0 -or "$functionsVersion" -notmatch '^4\.') {
            throw 'Install Azure Functions Core Tools v4 with .NET 10 support and add func to PATH.'
        }
        Invoke-Tool az @('bicep', 'version') 'Install Bicep once with az bicep install before full validation. No Azure login is required.'
        $localRuby = Join-Path $root '.tools\ruby\bin\ruby.exe'
        $ruby = if ($env:TRMNL_RUBY) { $env:TRMNL_RUBY }
            elseif (Test-Path -LiteralPath $localRuby) { $localRuby }
            else { 'ruby' }
        if (!(Get-Command $ruby -ErrorAction SilentlyContinue)) {
            throw 'Install Ruby 4 with native-extension build tools (RubyInstaller with Devkit on Windows), or set TRMNL_RUBY. Then run .\scripts\setup-display.ps1.'
        }
        $rubyVersion = & $ruby '-rbundler/setup' '-rtrmnl/liquid' '-rchunky_png' '-e' 'puts RUBY_VERSION'
        if ($LASTEXITCODE -ne 0 -or "$rubyVersion" -notmatch '^4\.') {
            throw 'Ruby 4 and the locked Liquid/raster gems must be available. Run .\scripts\setup-display.ps1 with the selected Ruby and its native build tools.'
        }
        foreach ($asset in @('css\3.4.3\plugins.css', 'js\3.4.3\plugins.js')) {
            if (!(Test-Path -LiteralPath (Join-Path $root ".tools\framework\$asset") -PathType Leaf)) {
                throw "Missing pinned TRMNL framework asset $asset. Run .\scripts\setup-display.ps1."
            }
        }
        $fonts = Join-Path $root '.tools\framework\fonts'
        if (!(Test-Path -LiteralPath $fonts -PathType Container) -or
            @(Get-ChildItem -LiteralPath $fonts -Recurse -File |
                Where-Object Extension -In '.woff', '.woff2', '.ttf').Count -eq 0) {
            throw 'Missing TRMNL framework fonts. Run .\scripts\setup-display.ps1.'
        }
    }
}

$null = Invoke-Check 'C# formatting (read-only)' {
    $arguments = @('format')
    if ($Scope -eq 'Fast') { $arguments += 'whitespace' }
    $arguments += @($project, '--no-restore', '--verify-no-changes', '--verbosity', 'quiet')
    Invoke-Tool dotnet $arguments `
        'Fix the reported formatting explicitly; validation never rewrites source.'
} $ready

$built = Invoke-Check '.NET build (warnings as errors)' {
    Invoke-Tool dotnet @('build', $project, '--no-restore', '--nologo', '--verbosity', 'quiet') `
        'Fix compiler errors/warnings; restore missing dependencies with .\scripts\setup-display.ps1.'
} $ready

$null = Invoke-Check 'PowerShell and Node syntax' {
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File) {
        $parseErrors = $null
        $null = [Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) {
            throw "$($file.Name): $($parseErrors.Message -join '; ')"
        }
    }
    foreach ($directory in @('scripts', 'tests\delivery', 'tests\validation')) {
        foreach ($file in Get-ChildItem -LiteralPath (Join-Path $root $directory) -Filter '*.mjs' -File) {
            Invoke-Tool node @('--check', $file.FullName) 'Fix the reported JavaScript syntax.'
        }
    }
} $ready

if ($Scope -eq 'Full') {
    $null = Invoke-Check '.NET tests (production rendering)' {
        Invoke-Tool dotnet @('test', $project, '--no-build', '--no-restore', '--nologo', '--verbosity', 'minimal') `
            'Fix the reported synthetic test failure. For missing Liquid/framework/fonts/Chromium, run .\scripts\setup-display.ps1. The real local host needs Core Tools v4.'
    } ($ready -and $built)

    $null = Invoke-Check 'Node delivery and guardrail tests' {
        $files = @(foreach ($directory in @('tests\delivery', 'tests\validation')) {
            $tests = @(Get-ChildItem -LiteralPath (Join-Path $root $directory) -Filter '*.test.mjs' -File |
                Sort-Object Name)
            if ($tests.Count -eq 0) { throw "No Node tests found in $directory; refusing an empty test run." }
            $tests.FullName
        })
        Invoke-Tool node (@('--test') + $files) 'Fix the reported local tooling test failures; no npm packages or Azure login are required.'
    } $ready
}

Write-Host ''
$results | Format-Table -AutoSize | Out-Host
$failed = @($results | Where-Object Result -NE 'PASSED').Count -gt 0
$outcome = if ($failed) { 'FAILED' } else { 'PASSED' }
Write-Host "$Scope validation $outcome."
if ($failed) { exit 1 }
exit 0
