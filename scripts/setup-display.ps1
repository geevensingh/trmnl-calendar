$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$localRuby = Join-Path $root '.tools\ruby\bin\ruby.exe'
$ruby = if ($env:TRMNL_RUBY) { $env:TRMNL_RUBY }
    elseif (Test-Path $localRuby) { $localRuby }
    else { (Get-Command ruby -ErrorAction Stop).Source }
$env:PATH = (Split-Path $ruby) + [IO.Path]::PathSeparator + $env:PATH
$bundle = Join-Path (Split-Path $ruby) 'bundle'
& $ruby $bundle config set --local path vendor/bundle
if ($LASTEXITCODE -ne 0) { throw 'Bundler configuration failed.' }
& $ruby $bundle install --quiet
if ($LASTEXITCODE -ne 0) { throw 'TRMNL Liquid dependency restore failed.' }

$assets = Join-Path $root '.tools\framework'
foreach ($asset in @('css/3.4.3/plugins.css', 'js/3.4.3/plugins.js')) {
    $target = Join-Path $assets ($asset.Replace('/', [IO.Path]::DirectorySeparatorChar))
    New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
    if (!(Test-Path $target)) {
        Invoke-WebRequest "https://trmnl.com/$asset" -OutFile $target -TimeoutSec 90
    }
}
$fonts = Join-Path $assets 'fonts'
New-Item -ItemType Directory -Force $fonts | Out-Null
foreach ($family in @('trmnl', 'classic')) {
    $archive = Join-Path $root ".tools\$family-fonts.zip"
    if (!(Test-Path $archive)) {
        Invoke-WebRequest "https://trmnl.com/fonts/bundles/$family/trmnl-fonts-bundle--$family.zip" `
            -OutFile $archive -TimeoutSec 90
    }
    Expand-Archive $archive -DestinationPath $fonts -Force
}

dotnet restore .\src\CalendarAgenda\CalendarAgenda.csproj --nologo --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Functions restore failed.' }
dotnet build .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --nologo --verbosity quiet
if ($LASTEXITCODE -ne 0) { throw 'Display harness build failed.' }
& .\tests\CalendarAgenda.Tests\bin\Debug\net10.0\playwright.ps1 install chromium
if ($LASTEXITCODE -ne 0) { throw 'Browser restore failed.' }
