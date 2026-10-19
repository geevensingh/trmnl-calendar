[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][string]$ResourceGroupName,
    [Parameter(Mandatory)][string]$FunctionAppName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{3,24}$')][string]$StorageAccountName,
    [Parameter(Mandatory)][string]$DeploymentContainerName,
    [Parameter(Mandatory)][string]$ActivePackage,
    [string]$PreviousSuccessfulPackage,
    [switch]$Apply,
    [switch]$ConfirmedActiveAndPreviousFromAzure
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Apply -and !$ConfirmedActiveAndPreviousFromAzure) {
    throw 'Deletion requires -ConfirmedActiveAndPreviousFromAzure and an exclusive deployment window.'
}
. (Join-Path $PSScriptRoot 'azure-cli.ps1')
$siteUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Web/sites/$FunctionAppName`?api-version=2024-04-01"
$site = Invoke-Azure -Stage 'Deployment-container verification' -Json -Arguments @(
    'rest', '--method', 'get', '--url', $siteUrl, '--output', 'json'
)
$storage = $site.properties.functionAppConfig.deployment.storage
$expectedContainer = "https://$StorageAccountName.blob.core.windows.net/$DeploymentContainerName"
if ($storage.type -ne 'blobContainer' -or $storage.value.TrimEnd('/') -cne $expectedContainer) {
    throw 'The supplied container is not this Function app''s configured deployment container. Nothing was deleted.'
}
$scope = @(
    '--subscription', $SubscriptionId.ToString(), '--account-name', $StorageAccountName,
    '--container-name', $DeploymentContainerName, '--auth-mode', 'login'
)
$blobs = @(Invoke-Azure -Stage 'Deployment-package listing' -Json -Arguments (
    @('storage', 'blob', 'list') + $scope + @('--output', 'json')
))
$packages = @($blobs | Where-Object { $_.name -match '\.zip$' })
$names = @($packages | ForEach-Object { $_.name })
if ($ActivePackage -cnotin $names -or
    ($PreviousSuccessfulPackage -and $PreviousSuccessfulPackage -cnotin $names) -or
    ($PreviousSuccessfulPackage -and $PreviousSuccessfulPackage -ceq $ActivePackage)) {
    throw 'Azure-verified active/previous package names must exist and be distinct. Nothing was deleted.'
}
if ($packages.Count -gt 1 -and !$PreviousSuccessfulPackage) {
    throw 'Identify the previous successful package from Azure history before any multi-package cleanup.'
}
foreach ($name in $names) {
    if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*\.zip$' -or $name -match '(^|/)\.\.(/|$)') {
        throw 'Unrecognized package name. Review Azure deployment history; do not guess or use age-based deletion.'
    }
}
$keep = @($ActivePackage)
if ($PreviousSuccessfulPackage) { $keep += $PreviousSuccessfulPackage }
$candidates = @($packages | Where-Object { $_.name -cnotin $keep })
foreach ($blob in $candidates) {
    if (!$blob.properties.etag) {
        throw 'A package has no concurrency token. Nothing was deleted.'
    }
}
if ($Apply) {
    foreach ($blob in $candidates) {
        Invoke-Azure -Stage 'Verified obsolete-package deletion' -Arguments (
            @('storage', 'blob', 'delete') + $scope +
            @('--name', $blob.name, '--if-match', $blob.properties.etag, '--output', 'none')
        )
    }
    $remaining = @(Invoke-Azure -Stage 'Package-retention verification' -Json -Arguments (
        @('storage', 'blob', 'list') + $scope + @('--output', 'json')
    ) | Where-Object { $_.name -match '\.zip$' } | ForEach-Object { $_.name })
    if ($remaining.Count -ne $keep.Count -or @($keep | Where-Object { $_ -cnotin $remaining }).Count -ne 0) {
        throw 'Package retention is not verified. Stop deployments and inspect Azure history; no further deletion was attempted.'
    }
}
[ordered]@{
    applied = [bool]$Apply
    retained = $keep
    delete_candidates = @($candidates | ForEach-Object { $_.name })
    unrelated_blobs_untouched = $true
} | ConvertTo-Json -Depth 4
