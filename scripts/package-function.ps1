[CmdletBinding()]
param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path $root 'artifacts\packages'
}
$directory = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ([guid]::NewGuid().ToString('N'))
$publish = Join-Path $directory 'publish'
New-Item -ItemType Directory -Path $publish -Force | Out-Null
$buildLog = Join-Path $directory 'build.log'
$commit = (& git -C $root rev-parse HEAD) -join ''
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') {
    throw 'Cannot identify the source commit for the deployment package.'
}
$status = (& git -C $root status --porcelain --untracked-files=normal) -join ''
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot verify the source checkout status.'
}

& dotnet publish (Join-Path $root 'src\CalendarAgenda\CalendarAgenda.csproj') `
    -c Release --self-contained false -p:UseAppHost=false --nologo --verbosity quiet -o $publish *> $buildLog
if ($LASTEXITCODE -ne 0) {
    throw "Release publish failed. Inspect the local build log: $buildLog"
}
foreach ($name in @('host.json', 'worker.config.json', 'CalendarAgenda.runtimeconfig.json', 'CalendarAgenda.dll')) {
    if (!(Test-Path -LiteralPath (Join-Path $publish $name) -PathType Leaf)) {
        throw "Release publish is missing a required package file: $name."
    }
}
$worker = Get-Content -LiteralPath (Join-Path $publish 'worker.config.json') -Raw | ConvertFrom-Json
$runtime = Get-Content -LiteralPath (Join-Path $publish 'CalendarAgenda.runtimeconfig.json') -Raw | ConvertFrom-Json
if ($worker.description.language -ne 'dotnet-isolated' -or
    $worker.description.defaultExecutablePath -ne 'dotnet' -or
    $worker.description.defaultWorkerPath -ne 'CalendarAgenda.dll' -or
    $worker.description.workerIndexing -ne 'true' -or $runtime.runtimeOptions.tfm -ne 'net10.0') {
    throw 'The package must retain the .NET 10 isolated, worker-indexed application.'
}
if (Get-ChildItem -LiteralPath $publish -Force -Recurse -File |
    Where-Object { $_.Name -eq 'local.settings.json' -or $_.Name -like '.env*' }) {
    throw 'Runtime configuration files must not be included in the deployment package.'
}

$archive = Join-Path $directory "calendar-$commit.zip"
# Unlike Compress-Archive, this includes the required hidden .azurefunctions directory.
[IO.Compression.ZipFile]::CreateFromDirectory($publish, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
if ((Get-Item -LiteralPath $archive).Length -gt 100 * 1024 * 1024) {
    throw 'The package exceeds the 100 MiB storage safety bound; review it before deployment.'
}
$manifest = Join-Path $directory 'manifest.json'
[ordered]@{
    framework = 'net10.0'
    commit = $commit
    working_tree_clean = ($status.Length -eq 0)
    created_at = [DateTimeOffset]::UtcNow.ToString('O')
    archive_sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    archive_bytes = (Get-Item -LiteralPath $archive).Length
} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8NoBOM
[ordered]@{ archive = $archive; manifest = $manifest } | ConvertTo-Json
