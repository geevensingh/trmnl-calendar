#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][string]$ApprovedResourceGroupName,
    [Parameter(Mandatory)][string]$ParametersFile,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ReviewedMainCommit
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'azure-cli.ps1')

$head = (& git -C $root rev-parse HEAD) -join ''
if ($LASTEXITCODE -ne 0 -or $head -cne $ReviewedMainCommit) {
    throw 'Infrastructure reconciliation must use the exact reviewed main commit.'
}
$status = (& git -C $root status --porcelain --untracked-files=normal) -join ''
if ($LASTEXITCODE -ne 0 -or $status.Length -ne 0) {
    throw 'Infrastructure reconciliation requires a clean reviewed-main checkout.'
}

$parameterPath = (Resolve-Path -LiteralPath $ParametersFile).Path
$document = [System.Text.Json.JsonDocument]::Parse((Get-Content -LiteralPath $parameterPath -Raw))
$scopedPath = [IO.Path]::GetTempFileName()
try {
    if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw 'Runtime parameters must be a JSON object.'
    }
    $objects = @($document.RootElement.EnumerateObject() | Where-Object Name -CEQ 'parameters')
    if ($objects.Count -ne 1 -or $objects[0].Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw 'Runtime parameters must contain a parameters object.'
    }
    $values = @{}
    foreach ($entry in $objects[0].Value.EnumerateObject()) {
        if ($entry.Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
            throw 'Runtime parameters must use ARM value objects.'
        }
        $fields = @($entry.Value.EnumerateObject())
        if ($fields.Count -ne 1 -or $fields[0].Name -cne 'value') {
            throw 'Runtime parameters must contain one value per name.'
        }
        $value = switch ($fields[0].Value.ValueKind) {
            String { $fields[0].Value.GetString() }
            True { $true }
            False { $false }
            default { throw 'Runtime parameter values must be strings or booleans.' }
        }
        $values[$entry.Name] = $value
    }
}
finally {
    $document.Dispose()
}

if ($values.resourceGroupName -cne $ApprovedResourceGroupName) {
    throw 'The infrastructure target does not match the owner-approved resource group.'
}
$names = @(
    'location', 'functionAppName', 'planName', 'storageAccountName', 'releaseStorageAccountName', 'hostIdentityName',
    'keyVaultName', 'logAnalyticsName', 'applicationInsightsName', 'budgetName',
    'budgetAlertEmail', 'agendaOwnerAddress', 'budgetStartDate', 'sourceSecretName', 'cacheContainerName',
    'deploymentContainerName', 'releaseControlContainerName', 'releaseArtifactContainerName',
    'releaseControllerPrincipalId', 'retainHostDiagnostics'
)
$allowed = $names + @('resourceGroupName')
foreach ($name in $values.Keys) {
    if ($name -notin $allowed) {
        throw 'The runtime parameter file contains an unapproved parameter.'
    }
}
$scopedParameters = @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = @{} }
foreach ($name in $names) {
    if ($values.ContainsKey($name)) {
        $scopedParameters.parameters[$name] = @{ value = $values[$name] }
    }
}
foreach ($name in @(
    'location', 'functionAppName', 'planName', 'storageAccountName', 'releaseStorageAccountName', 'hostIdentityName',
    'keyVaultName', 'logAnalyticsName', 'applicationInsightsName', 'budgetName',
    'budgetAlertEmail', 'agendaOwnerAddress', 'budgetStartDate', 'sourceSecretName', 'cacheContainerName',
    'deploymentContainerName', 'releaseControlContainerName', 'releaseArtifactContainerName'
)) {
    if (!$scopedParameters.parameters.ContainsKey($name) -or
        [string]::IsNullOrWhiteSpace([string]$scopedParameters.parameters[$name].value)) {
        throw "Missing infrastructure runtime parameter: $name."
    }
}
if ($values.releaseStorageAccountName -ieq $values.storageAccountName) {
    throw 'Release storage must use a separate account from Function runtime storage.'
}
Assert-AgendaOwnerAddress $scopedParameters.parameters.agendaOwnerAddress.value
if ($scopedParameters.parameters.ContainsKey('releaseControllerPrincipalId') -and
    $scopedParameters.parameters.releaseControllerPrincipalId.value -ne '') {
    $principal = [guid]::Empty
    if (![guid]::TryParse($scopedParameters.parameters.releaseControllerPrincipalId.value, [ref]$principal)) {
        throw 'releaseControllerPrincipalId must be the owner-verified OIDC service-principal object ID.'
    }
}
try {
    $scopedParameters | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $scopedPath -Encoding utf8NoBOM
    $group = (& az group show --subscription $SubscriptionId --name $ApprovedResourceGroupName `
        --query name --output tsv --only-show-errors 2>$null) -join ''
    if ($LASTEXITCODE -ne 0 -or $group -cne $ApprovedResourceGroupName) {
        throw 'The approved resource group must already exist. Routine releases never create or delete the group.'
    }
    $deploymentName = "calendar-$($ReviewedMainCommit.Substring(0, 12))"
    $reconciliation = Invoke-Azure -Stage 'Resource-group deployment-stack reconciliation' -Json -Arguments @(
        'stack', 'group', 'create',
        '--name', 'trmnl-calendar-managed',
        '--resource-group', $ApprovedResourceGroupName,
        '--subscription', $SubscriptionId.ToString(),
        '--template-file', (Join-Path $root 'infra\resources.bicep'),
        '--parameters', "@$scopedPath",
        '--action-on-unmanage', 'deleteResources',
        '--deny-settings-mode', 'denyDelete',
        '--description', "Reviewed main release $ReviewedMainCommit; deployment $deploymentName",
        '--yes',
        '--output', 'json'
    )
    if (!$reconciliation.outputs.reviewedCapacity.value) {
        throw 'The reviewed deployment stack did not return its expected function capacity.'
    }
    @{
        status = 'reconciled'
        commit = $ReviewedMainCommit
        scaleAndConcurrency = $reconciliation.outputs.reviewedCapacity.value
    } | ConvertTo-Json -Depth 20 -Compress
}
finally {
    Remove-Item -LiteralPath $scopedPath -Force -ErrorAction SilentlyContinue
}
