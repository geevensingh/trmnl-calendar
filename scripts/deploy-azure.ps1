[CmdletBinding()]
param(
    [ValidateSet('Build', 'WhatIf', 'Apply', 'DeployCode')]
    [string]$Mode = 'Build',
    [string]$SubscriptionId,
    [string]$ParametersFile,
    [string]$PackageFile,
    [string]$ReviewedIntegrationCommit,
    [switch]$ApprovedResourcePlan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$template = Join-Path $root 'infra\main.bicep'

if ($Mode -in @('Apply', 'DeployCode') -and !$ApprovedResourcePlan) {
    throw 'Cloud changes require -ApprovedResourcePlan after owner approval and integration review.'
}

. (Join-Path $PSScriptRoot 'azure-cli.ps1')

if ($Mode -eq 'Build') {
    $directory = Join-Path $root 'artifacts\infra'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    Invoke-Azure -Stage 'Bicep compilation' -Arguments @(
        'bicep', 'build', '--file', $template, '--outfile', (Join-Path $directory 'main.json')
    )
    Write-Output 'Compiled artifacts\infra\main.json. No Azure resources were changed.'
    return
}

$parsedSubscription = [guid]::Empty
if (![guid]::TryParse($SubscriptionId, [ref]$parsedSubscription) -or !$ParametersFile) {
    throw 'Supply the owner-approved -SubscriptionId and local -ParametersFile as runtime inputs.'
}
$parameterPath = (Resolve-Path -LiteralPath $ParametersFile).Path
$document = [System.Text.Json.JsonDocument]::Parse((Get-Content -LiteralPath $parameterPath -Raw))
try {
    if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw 'Use an ARM deployment-parameters JSON document with a parameters object.'
    }
    $objects = @($document.RootElement.EnumerateObject() | Where-Object Name -CEQ 'parameters')
    if ($objects.Count -ne 1 -or $objects[0].Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) {
        throw 'Use an ARM deployment-parameters JSON document with a parameters object.'
    }
    $parameters = @{}
    foreach ($entry in $objects[0].Value.EnumerateObject()) {
        if ($entry.Value.ValueKind -ne [System.Text.Json.JsonValueKind]::Object -or $parameters.ContainsKey($entry.Name)) {
            throw 'Runtime parameters must be unique value objects.'
        }
        $fields = @($entry.Value.EnumerateObject())
        if ($fields.Count -ne 1 -or $fields[0].Name -cne 'value') {
            throw 'Runtime parameters must each contain exactly one value.'
        }
        # Preserve ISO strings; ConvertFrom-Json can silently turn budget dates into DateTime.
        $value = switch ($fields[0].Value.ValueKind) {
            String { $fields[0].Value.GetString() }
            True { $true }
            False { $false }
            default { throw 'Runtime parameter values must be strings or booleans.' }
        }
        $parameters[$entry.Name] = @{ value = $value }
    }
}
finally {
    $document.Dispose()
}
$required = @(
    'location', 'resourceGroupName', 'functionAppName', 'planName', 'storageAccountName',
    'hostIdentityName', 'keyVaultName', 'logAnalyticsName', 'applicationInsightsName',
    'budgetName', 'budgetAlertEmail', 'agendaOwnerAddress', 'budgetStartDate'
)
$allowed = $required + @(
    'sourceSecretName', 'cacheContainerName', 'deploymentContainerName', 'retainHostDiagnostics'
)
foreach ($name in $parameters.Keys) {
    if ($name -notin $allowed) {
        throw 'The runtime parameter file contains an unapproved parameter. Source URLs and keys are never deployment parameters.'
    }
}
foreach ($name in $required) {
    if (!$parameters.ContainsKey($name) -or !$parameters[$name].ContainsKey('value') -or
        $parameters[$name].value -isnot [string] -or [string]::IsNullOrWhiteSpace($parameters[$name].value)) {
        throw "Missing runtime parameter: $name."
    }
}
if ($parameters.location.value -ne 'westus2') {
    throw 'This resource plan is approved only for westus2; a region change requires renewed approval.'
}
$ownerUri = $null
$ownerMailbox = $null
$ownerAddress = $null
if (![System.Uri]::TryCreate($parameters.agendaOwnerAddress.value, [System.UriKind]::Absolute, [ref]$ownerUri) -or
    $ownerUri.Scheme -cne 'mailto' -or $ownerUri.Query -or $ownerUri.Fragment) {
    throw 'agendaOwnerAddress must be one exact mailto: address.'
}
$ownerAddress = $ownerUri.GetComponents([System.UriComponents]::Path, [System.UriFormat]::Unescaped)
if (![System.Net.Mail.MailAddress]::TryCreate($ownerAddress, [ref]$ownerMailbox) -or
    $ownerMailbox.Address -cne $ownerAddress -or $ownerAddress.Contains(',')) {
    throw 'agendaOwnerAddress must be one exact mailto: address.'
}
$budgetStart = [DateTimeOffset]::MinValue
if ($parameters.budgetStartDate.value -notmatch '^\d{4}-\d{2}-01T00:00:00Z$' -or
    ![DateTimeOffset]::TryParse($parameters.budgetStartDate.value, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$budgetStart)) {
    throw 'budgetStartDate must be the original creation month start as YYYY-MM-01T00:00:00Z; preserve it on redeployment.'
}
$recipient = $null
if (![System.Net.Mail.MailAddress]::TryCreate($parameters.budgetAlertEmail.value, [ref]$recipient) -or
    $recipient.Address -ne $parameters.budgetAlertEmail.value) {
    throw 'budgetAlertEmail must be the owner-approved runtime email address, without a display name.'
}

if ($Mode -eq 'DeployCode') {
    if (!$PackageFile -or $ReviewedIntegrationCommit -notmatch '^[a-f0-9]{40}$') {
        throw 'Supply -PackageFile and the full -ReviewedIntegrationCommit after reviewing the integration branch.'
    }
    $archive = (Resolve-Path -LiteralPath $PackageFile).Path
    $manifest = Get-Content -LiteralPath (Join-Path (Split-Path $archive -Parent) 'manifest.json') -Raw |
        ConvertFrom-Json -AsHashtable
    if ($manifest.working_tree_clean -isnot [bool] -or !$manifest.working_tree_clean -or
        $manifest.commit -cne $ReviewedIntegrationCommit -or $manifest.framework -ne 'net10.0') {
        throw 'Deploy only a clean, reviewed .NET 10 integration package; rebuild it after the integration review.'
    }
    $head = (& git -C $root rev-parse HEAD) -join ''
    if ($LASTEXITCODE -ne 0 -or $head -cne $ReviewedIntegrationCommit) {
        throw 'This checkout must be at the reviewed integration commit.'
    }
    $status = (& git -C $root status --porcelain --untracked-files=normal) -join ''
    if ($LASTEXITCODE -ne 0 -or $status.Length -ne 0) {
        throw 'Deploy from the clean, reviewed integration checkout, not a dirty worker branch.'
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.archive_sha256 -or
        (Get-Item -LiteralPath $archive).Length -gt 100 * 1024 * 1024) {
        throw 'The deployment archive hash or size does not match the reviewed package.'
    }
    $siteUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$($parameters.resourceGroupName.value)/providers/Microsoft.Web/sites/$($parameters.functionAppName.value)?api-version=2024-04-01"
    $site = Invoke-Azure -Stage 'Code-deployment target verification' -Json -Arguments @(
        'rest', '--method', 'get', '--url', $siteUrl, '--output', 'json'
    )
    $config = $site.properties.functionAppConfig
    $scale = $config.scaleAndConcurrency
    $approvedPlanId = "/subscriptions/$SubscriptionId/resourceGroups/$($parameters.resourceGroupName.value)/providers/Microsoft.Web/serverfarms/$($parameters.planName.value)"
    if ($site.kind -notmatch 'functionapp' -or $site.kind -notmatch 'linux' -or !$site.properties.httpsOnly -or
        $site.properties.serverFarmId -ine $approvedPlanId -or
        $config.runtime.name -ne 'dotnet-isolated' -or $config.runtime.version -ne '10.0' -or
        $scale.maximumInstanceCount -ne 1 -or $scale.instanceMemoryMB -ne 2048 -or
        @($scale['alwaysReady'] | Where-Object { $_.instanceCount -ne 0 }).Count -ne 0) {
        throw 'The live target differs from the approved HTTPS Linux .NET 10, 2 GiB/max-one, zero-always-ready plan.'
    }
    $plan = Invoke-Azure -Stage 'Flex plan verification' -Json -Arguments @(
        'rest', '--method', 'get', '--url', "https://management.azure.com$approvedPlanId`?api-version=2024-04-01",
        '--output', 'json'
    )
    if ($plan.sku.name -ne 'FC1' -or !$plan.properties.reserved) {
        throw 'Code deployment requires the approved Linux Flex Consumption plan, not classic Consumption.'
    }
    Invoke-Azure -Stage 'Reviewed Flex package deployment' -Arguments @(
        'functionapp', 'deployment', 'source', 'config-zip', '--subscription', $SubscriptionId,
        '--resource-group', $parameters.resourceGroupName.value, '--name', $parameters.functionAppName.value,
        '--src', $archive, '--build-remote', 'false', '--timeout', '600', '--output', 'none'
    )
    Write-Output 'Azure accepted the reviewed package. Retention, authentication, cache, source and TRMNL/device evidence still require the live checks.'
    return
}

$arguments = @(
    'deployment', 'sub', $(if ($Mode -eq 'WhatIf') { 'what-if' } else { 'create' }),
    '--subscription', $SubscriptionId, '--location', $parameters.location.value,
    '--name', 'trmnl-calendar', '--template-file', $template, '--parameters', "@$parameterPath"
)
if ($Mode -eq 'WhatIf') {
    $result = Invoke-Azure -Stage 'Infrastructure what-if' -Json -Arguments (
        $arguments + @('--result-format', 'ResourceIdOnly', '--no-pretty-print', '--output', 'json')
    )
    if ($result.status -ne 'Succeeded') {
        throw 'Infrastructure what-if did not succeed. No deployment was attempted.'
    }
    [ordered]@{
        mode = 'WhatIf'
        azure_resources_changed = $false
        changes = @($result.changes | ForEach-Object {
            @{ resource_id = $_.resourceId; change_type = $_.changeType }
        })
    } | ConvertTo-Json -Depth 5
}
else {
    Invoke-Azure -Stage 'Approved infrastructure deployment' -Arguments ($arguments + @('--output', 'none'))
    Write-Output 'Azure accepted the infrastructure deployment. Source, function key, live polling, and device gates remain unverified.'
}
