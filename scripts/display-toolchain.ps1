function Assert-DisplaySdk {
    $hint = 'Install the .NET 10 SDK selected by global.json and add dotnet to PATH.'
    if (!(Get-Command dotnet -ErrorAction SilentlyContinue)) { throw $hint }
    try {
        $sdk = & dotnet --version
        if ($LASTEXITCODE -ne 0 -or "$sdk" -notmatch '^10\.') {
            throw "Reported '$sdk' (exit $LASTEXITCODE)."
        }
    }
    catch {
        throw "The .NET 10 SDK selected by global.json is unavailable. $hint $($_.Exception.Message)"
    }
}

function Get-DisplayRuby([string]$Root) {
    $localRuby = Join-Path $Root '.tools\ruby\bin\ruby.exe'
    $source = 'PATH'
    $selection = 'ruby'
    if ($env:TRMNL_RUBY) {
        $source = 'TRMNL_RUBY'
        $selection = $env:TRMNL_RUBY
    }
    elseif (Test-Path -LiteralPath $localRuby -PathType Leaf) {
        $source = 'worktree-local'
        $selection = $localRuby
    }
    $command = Get-Command $selection -ErrorAction SilentlyContinue | Select-Object -First 1
    if (!$command) {
        throw "Selected $source Ruby executable '$selection' is unavailable. Install Ruby 4 with Devkit on Windows or set TRMNL_RUBY to an existing Ruby 4 executable, then run .\scripts\setup-display.ps1."
    }
    if ($command.Source) { $selection = $command.Source }
    $hint = 'Set TRMNL_RUBY to a working Ruby 4 executable; use RubyInstaller with Devkit on Windows. See README.md#local-prerequisites.'
    try {
        $version = (& $selection -e 'puts RUBY_VERSION') -join "`n"
        if ($LASTEXITCODE -ne 0) { throw "Exit code $LASTEXITCODE." }
    }
    catch {
        throw "Selected Ruby executable '$selection' is unusable. $hint $($_.Exception.Message)"
    }
    if ($version -notmatch '^4\.\d+\.\d+$') {
        throw "Ruby 4 is required; '$selection' reported '$version'. $hint"
    }
    Write-Host "Ruby $version : $selection"
    return $selection
}

function Get-DisplayToolchain([string]$Root) {
    $ruby = Get-DisplayRuby $Root
    $lockfile = Join-Path $Root 'Gemfile.lock'
    if (!(Test-Path -LiteralPath $lockfile -PathType Leaf) -or
        (Get-Content -LiteralPath $lockfile -Raw) -notmatch '(?m)^BUNDLED WITH\r?\n\s+(\d+\.\d+\.\d+)\s*$') {
        throw 'Gemfile.lock must contain BUNDLED WITH. Restore the tracked lockfile; do not regenerate it for setup.'
    }
    $bundlerVersion = $Matches[1]
    $quotedRuby = $ruby.Replace("'", "''")
    $hint = "Install Bundler $bundlerVersion explicitly (gem install bundler --version $bundlerVersion) using the selected Ruby: & '$quotedRuby' -rrubygems/gem_runner -e 'Gem::GemRunner.new.run(ARGV)' -- install bundler --version $bundlerVersion --no-document. Then run .\scripts\setup-display.ps1."
    try {
        $version = (& $ruby -e 'gem "bundler", ARGV.fetch(0); require "bundler"; puts Bundler::VERSION' $bundlerVersion) -join "`n"
        if ($LASTEXITCODE -ne 0 -or $version -ne $bundlerVersion) {
            throw "Required Bundler $bundlerVersion is unavailable (reported '$version', exit $LASTEXITCODE)."
        }
    }
    catch {
        throw "Bundler $bundlerVersion is required in '$ruby'. $hint $($_.Exception.Message)"
    }
    Write-Host "Bundler $version (Gemfile.lock)"
    return [pscustomobject]@{ Ruby = $ruby; BundlerVersion = $bundlerVersion }
}

function Test-DisplayNativeTools([string]$Root, $Toolchain) {
    $directory = Join-Path $Root ".tools\native-probe-$([Guid]::NewGuid().ToString('N'))"
    $probe = @'
require "rbconfig"
require "devkit" if Gem.win_platform?
require "mkmf"
File.write("trmnl_toolchain_probe.c", "#include <ruby.h>\nvoid Init_trmnl_toolchain_probe(void) {}\n")
create_makefile("trmnl_toolchain_probe")
abort "Configured make/compiler failed" unless system(ENV["MAKE"] || RbConfig::CONFIG["MAKE"] || "make")
require File.expand_path("trmnl_toolchain_probe", Dir.pwd)
puts "Native extension compiled and loaded with #{RbConfig::CONFIG["CC"]}"
'@
    $process = $null
    try {
        New-Item -ItemType Directory -Path $directory | Out-Null
        $script = Join-Path $directory 'probe.rb'
        [IO.File]::WriteAllText($script, $probe)
        $stdout = Join-Path $directory 'stdout.log'
        $stderr = Join-Path $directory 'stderr.log'
        $process = Start-Process -FilePath $Toolchain.Ruby -ArgumentList @("`"$script`"") `
            -WorkingDirectory $directory -PassThru -NoNewWindow `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (!$process.WaitForExit(45000)) {
            $process.Kill($true)
            if (!$process.WaitForExit(5000)) { throw 'Native build process did not exit after termination.' }
            throw 'Native build probe exceeded 45 seconds; its compiler process tree was terminated.'
        }
        Get-Content -LiteralPath $stdout, $stderr | Out-Host
        if ($process.ExitCode -ne 0) { throw "Probe exit code $($process.ExitCode)." }
    }
    catch {
        throw "Selected Ruby native-extension compiler/linker/make tools are unusable. Install or repair the compatible Devkit explicitly (RubyInstaller with Devkit on Windows), then run .\scripts\setup-display.ps1. $($_.Exception.Message)"
    }
    finally {
        if ($process) { $process.Dispose() }
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    }
}

function Save-DisplayEnvironment {
    $saved = @{}
    foreach ($name in @('PATH', 'TRMNL_RUBY', 'DOTNET_GENERATE_ASPNET_CERTIFICATE') +
        @(Get-ChildItem Env: | Where-Object Name -Like 'BUNDLE_*' | ForEach-Object Name)) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    return $saved
}

function Restore-DisplayEnvironment([hashtable]$Saved) {
    foreach ($variable in Get-ChildItem Env: | Where-Object Name -Like 'BUNDLE_*') {
        Remove-Item -LiteralPath "Env:$($variable.Name)"
    }
    foreach ($name in $Saved.Keys) {
        if ($null -eq $Saved[$name]) {
            if (Test-Path -LiteralPath "Env:$name") { Remove-Item -LiteralPath "Env:$name" }
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process')
        }
    }
}

function Set-DisplayEnvironment([string]$Root) {
    foreach ($variable in Get-ChildItem Env: | Where-Object {
        $_.Name -like 'BUNDLE_*' -and $_.Name -notin @('BUNDLE_USER_HOME', 'BUNDLE_USER_CACHE')
    }) {
        Remove-Item -LiteralPath "Env:$($variable.Name)"
    }
    $env:BUNDLE_IGNORE_CONFIG = 'true'
    $env:BUNDLE_APP_CONFIG = Join-Path $Root '.bundle'
    $env:BUNDLE_GEMFILE = Join-Path $Root 'Gemfile'
    $env:BUNDLE_PATH = Join-Path $Root 'vendor\bundle'
    $env:BUNDLE_BIN = Join-Path $Root 'vendor\bin'
    $env:BUNDLE_CACHE_PATH = Join-Path $Root 'vendor\cache'
    $env:BUNDLE_FROZEN = 'true'
    $env:BUNDLE_DISABLE_SHARED_GEMS = 'true'
}

function Invoke-DisplayBundle($Toolchain, [string[]]$Arguments) {
    & $Toolchain.Ruby -e 'require "devkit" if Gem.win_platform?; gem "bundler", ARGV.shift; load Gem.bin_path("bundler", "bundle")' `
        $Toolchain.BundlerVersion @Arguments | Out-Host
    return $LASTEXITCODE
}

function Assert-DisplayGems($Toolchain) {
    & $Toolchain.Ruby -e 'gem "bundler", ARGV.fetch(0); require "bundler/setup"; require "trmnl/liquid"; require "chunky_png"; require "redcarpet"; require "bigdecimal"; require "strscan"; puts "Locked Liquid/raster/native gems loaded"' `
        $Toolchain.BundlerVersion | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw 'The locked Liquid/raster gems or native extensions cannot load. Run .\scripts\setup-display.ps1 with the selected Ruby and compatible Devkit; repair worktree-local gems if necessary. Do not update Gemfile.lock.'
    }
}

function Test-DisplayFile([string]$Path) {
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and (Get-Item -LiteralPath $Path).Length -gt 0
}

function Get-DisplayFontNames([string]$Assets) {
    $css = Join-Path $Assets 'css\3.4.3\plugins.css'
    if (!(Test-DisplayFile $css)) { return @() }
    return @([regex]::Matches((Get-Content -LiteralPath $css -Raw),
        'url\(["'']?/fonts/([^)"''?#]+\.(?:woff2?|ttf))') |
        ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

function Test-DisplayFonts([string]$Assets, [string]$Fonts) {
    $names = @(Get-DisplayFontNames $Assets)
    if ($names.Count -eq 0) { return $false }
    foreach ($name in $names) {
        if (!(Test-DisplayFile (Join-Path $Fonts $name))) { return $false }
    }
    return $true
}

function Test-DisplayBrowser([string]$Root) {
    $script = Join-Path $Root 'tests\CalendarAgenda.Tests\bin\Debug\net10.0\playwright.ps1'
    if (!(Test-Path -LiteralPath $script -PathType Leaf)) {
        throw 'Missing Playwright runtime from the display harness build. Run .\scripts\setup-display.ps1.'
    }
    $image = Join-Path $Root ".tools\chromium-probe-$([Guid]::NewGuid().ToString('N')).png"
    try {
        New-Item -ItemType Directory -Force (Split-Path $image) | Out-Null
        try {
            $output = & $script screenshot --browser chromium --timeout 15000 about:blank $image 2>&1
        }
        catch {
            throw "Pinned Playwright Chromium probe failed. Run .\scripts\setup-display.ps1 to repair the local runtime/browser prerequisites. $($_.Exception.Message)"
        }
        if ($LASTEXITCODE -eq 0 -and (Test-DisplayFile $image)) {
            Write-Host 'Pinned Playwright Chromium launched successfully.'
            return $true
        }
        Write-Host ($output -join "`n")
        Write-Host 'Pinned Playwright Chromium is missing or unusable in the selected browser cache.'
        return $false
    }
    finally {
        if (Test-Path -LiteralPath $image) { Remove-Item -LiteralPath $image -Force }
    }
}
