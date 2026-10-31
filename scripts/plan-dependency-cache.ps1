#Requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'display-toolchain.ps1')
$savedEnvironment = Save-DisplayEnvironment

function Get-CacheDigest($Identity) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Identity | ConvertTo-Json -Depth 10 -Compress))
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Test-CacheDestination([string]$RelativePath) {
    $path = Join-Path $root $RelativePath
    if (Test-Path -LiteralPath $path) { return $false }
    for ($parent = Split-Path $path; $parent -and $parent -ne $root; $parent = Split-Path $parent) {
        if ((Test-Path -LiteralPath $parent) -and
            ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            return $false
        }
    }
    return $true
}

try {
    Set-DisplayEnvironment $root
    $toolchain = Get-DisplayToolchain $root
    $nativeJson = & $toolchain.Ruby -e @'
require "json"
require "rbconfig"
keys = %w[ruby_version arch host target DLEXT RUBY_SO_NAME LIBRUBY_SO CC CFLAGS CPPFLAGS LDFLAGS configure_args]
puts JSON.generate({engine: RUBY_ENGINE, version: RUBY_VERSION, patchlevel: RUBY_PATCHLEVEL,
  revision: RUBY_REVISION, platform: RUBY_PLATFORM, config: keys.to_h { |key| [key, RbConfig::CONFIG.fetch(key, "")] }})
'@
    if ($LASTEXITCODE -ne 0) { throw 'Selected Ruby native cache identity is unavailable; no cache may be restored.' }
    $native = ($nativeJson -join "`n") | ConvertFrom-Json
    if (!$native.engine -or !$native.version -or !$native.platform -or !$native.config.arch -or
        !$native.config.ruby_version -or $native.config.DLEXT -notmatch '^[a-zA-Z0-9]+$') {
        throw 'Selected Ruby native cache identity is incomplete; no cache may be restored.'
    }
    $configuration = [ordered]@{}
    foreach ($property in $native.config.PSObject.Properties | Sort-Object Name) {
        $configuration[$property.Name] = $property.Value
    }
    $platform = [ordered]@{
        os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
        architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        image_os = $env:ImageOS
        image_version = $env:ImageVersion
    }
    $gemsIdentity = [ordered]@{
        platform = $platform
        ruby = [ordered]@{
            engine = $native.engine; version = $native.version; patchlevel = $native.patchlevel
            revision = $native.revision; platform = $native.platform; config = $configuration
        }
        bundler = $toolchain.BundlerVersion
        gemfile = (Get-FileHash -LiteralPath (Join-Path $root 'Gemfile') -Algorithm SHA256).Hash
        lock = (Get-FileHash -LiteralPath (Join-Path $root 'Gemfile.lock') -Algorithm SHA256).Hash
    }
    $frameworkIdentity = [ordered]@{
        platform = $platform
        setup = (Get-FileHash -LiteralPath (Join-Path $root 'scripts\setup-display.ps1') -Algorithm SHA256).Hash
        readiness = (Get-FileHash -LiteralPath (Join-Path $root 'scripts\display-toolchain.ps1') -Algorithm SHA256).Hash
    }
    [ordered]@{
        schema_version = 1
        namespace = 'trmnl-deps-v1'
        gems = [ordered]@{
            key = "trmnl-deps-v1-gems-$(Get-CacheDigest $gemsIdentity)"
            path = Join-Path $root 'vendor\bundle'
            paths = @(
                foreach ($name in @('lib', 'LICENSE*', 'COPYING*', 'BSDL', 'LEGAL')) {
                    Join-Path $root "vendor\bundle\*\*\gems\*\$name"
                }
                Join-Path $root 'vendor\bundle\*\*\specifications\*.gemspec'
                Join-Path $root "vendor\bundle\*\*\extensions\*\*\*\**\*.$($native.config.DLEXT)"
                Join-Path $root 'vendor\bundle\*\*\extensions\*\*\*\gem.build_complete'
            )
            restore = Test-CacheDestination 'vendor\bundle'
            identity = $gemsIdentity
        }
        framework = [ordered]@{
            key = "trmnl-deps-v1-framework-$(Get-CacheDigest $frameworkIdentity)"
            path = Join-Path $root '.tools\framework'
            paths = @(
                Join-Path $root '.tools\framework\css\3.4.3\plugins.css'
                Join-Path $root '.tools\framework\js\3.4.3\plugins.js'
                foreach ($extension in @('woff', 'woff2', 'ttf')) {
                    Join-Path $root ".tools\framework\fonts\**\*.$extension"
                }
            )
            restore = Test-CacheDestination '.tools\framework'
            identity = $frameworkIdentity
        }
    } | ConvertTo-Json -Depth 15
}
finally { Restore-DisplayEnvironment $savedEnvironment }
