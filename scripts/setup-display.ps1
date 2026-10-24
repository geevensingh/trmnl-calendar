#Requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'display-toolchain.ps1')
$savedEnvironment = Save-DisplayEnvironment
$location = Get-Location
$stage = Join-Path $root ".tools\display-setup-$([Guid]::NewGuid().ToString('N'))"
try {
    Set-Location -LiteralPath $root
    $env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
    Set-DisplayEnvironment $root
    $toolchain = Get-DisplayToolchain $root
    $env:TRMNL_RUBY = $toolchain.Ruby
    Test-DisplayNativeTools $root $toolchain
    Assert-DisplaySdk

    $lockfile = Join-Path $root 'Gemfile.lock'
    $lockHash = (Get-FileHash -LiteralPath $lockfile -Algorithm SHA256).Hash
    # Config writes must retain earlier local settings; restores still ignore inherited config.
    Remove-Item Env:BUNDLE_IGNORE_CONFIG
    try {
        foreach ($setting in @(@('path', 'vendor/bundle'), @('frozen', 'true'), @('disable_shared_gems', 'true'))) {
            if ((Invoke-DisplayBundle $toolchain @('config', 'set', '--local', $setting[0], $setting[1])) -ne 0) {
                throw 'Worktree-local Bundler configuration failed. Check .bundle permissions and rerun .\scripts\setup-display.ps1.'
            }
        }
    }
    finally { $env:BUNDLE_IGNORE_CONFIG = 'true' }
    if ((Invoke-DisplayBundle $toolchain @('check')) -eq 0) {
        Write-Host 'Reusing locked worktree-local gems.'
    }
    elseif ((Invoke-DisplayBundle $toolchain @('install', '--quiet')) -ne 0) {
        throw 'Locked worktree-local gem restore failed. Check network access and the selected Ruby/Devkit, then rerun .\scripts\setup-display.ps1. Do not update Gemfile.lock.'
    }
    if ((Get-FileHash -LiteralPath $lockfile -Algorithm SHA256).Hash -ne $lockHash) {
        throw 'Gemfile.lock changed unexpectedly during frozen restore. Restore the tracked lockfile before retrying.'
    }
    Assert-DisplayGems $toolchain

    New-Item -ItemType Directory -Path $stage | Out-Null
    $assets = Join-Path $root '.tools\framework'
    foreach ($asset in @('css/3.4.3/plugins.css', 'js/3.4.3/plugins.js')) {
        $target = Join-Path $assets ($asset.Replace('/', [IO.Path]::DirectorySeparatorChar))
        if (Test-DisplayFile $target) {
            Write-Host "Reusing pinned framework asset $asset."
            continue
        }
        $download = Join-Path $stage ([IO.Path]::GetFileName($target))
        try {
            Invoke-WebRequest "https://trmnl.com/$asset" -OutFile $download -TimeoutSec 90
            if (!(Test-DisplayFile $download)) { throw 'Downloaded asset is empty.' }
            New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
            Move-Item -LiteralPath $download -Destination $target -Force
        }
        catch {
            throw "Pinned framework download failed for $asset. Check access to trmnl.com and rerun .\scripts\setup-display.ps1. $($_.Exception.Message)"
        }
    }
    $fonts = Join-Path $assets 'fonts'
    if (Test-DisplayFonts $assets $fonts) {
        Write-Host 'Reusing pinned framework fonts.'
    }
    else {
        $stagedFonts = Join-Path $stage 'fonts'
        New-Item -ItemType Directory -Path $stagedFonts | Out-Null
        try {
            foreach ($family in @('trmnl', 'classic')) {
                $archive = Join-Path $stage "$family-fonts.zip"
                Invoke-WebRequest "https://trmnl.com/fonts/bundles/$family/trmnl-fonts-bundle--$family.zip" `
                    -OutFile $archive -TimeoutSec 90
                Expand-Archive -LiteralPath $archive -DestinationPath $stagedFonts -Force
            }
            if (!(Test-DisplayFonts $assets $stagedFonts)) {
                throw 'Extracted font bundles do not contain every font referenced by the pinned CSS.'
            }
        }
        catch {
            throw "Pinned font download/extraction failed. Check access to trmnl.com and rerun .\scripts\setup-display.ps1. $($_.Exception.Message)"
        }
        $previousFonts = Join-Path $stage 'previous-fonts'
        if (Test-Path -LiteralPath $fonts) { Move-Item -LiteralPath $fonts -Destination $previousFonts }
        try { Move-Item -LiteralPath $stagedFonts -Destination $fonts }
        catch {
            if (Test-Path -LiteralPath $previousFonts) { Move-Item -LiteralPath $previousFonts -Destination $fonts }
            throw
        }
    }

    $project = Join-Path $root 'tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj'
    & dotnet restore $project --nologo --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw 'Display harness dependency restore failed. Rerun .\scripts\setup-display.ps1 after fixing the reported restore error.' }
    & dotnet build $project --no-restore --nologo --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw 'Display harness build failed. Fix the reported compiler error and rerun .\scripts\setup-display.ps1.' }
    if (!(Test-DisplayBrowser $root)) {
        try {
            & (Join-Path (Split-Path $project) 'bin\Debug\net10.0\playwright.ps1') install chromium
        }
        catch {
            throw "Pinned Chromium setup failed. Repair the local Playwright runtime and rerun .\scripts\setup-display.ps1. $($_.Exception.Message)"
        }
        if ($LASTEXITCODE -ne 0 -or !(Test-DisplayBrowser $root)) {
            throw 'Pinned Chromium setup failed. Check the selected PLAYWRIGHT_BROWSERS_PATH, browser dependencies and network access, then rerun .\scripts\setup-display.ps1.'
        }
    }
}
finally {
    try {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
    finally {
        Restore-DisplayEnvironment $savedEnvironment
        Set-Location -LiteralPath $location.Path
    }
}
Write-Host 'Display setup PASSED. Shared tools were not installed or upgraded.'
