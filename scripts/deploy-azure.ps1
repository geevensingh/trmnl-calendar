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
$PSNativeCommandUseErrorActionPreference = $false
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
    'budgetName', 'budgetAlertEmail', 'budgetStartDate'
)
$allowed = $required + @(
    'sourceSecretName', 'cacheContainerName', 'deploymentContainerName', 'retainHostDiagnostics',
    'releaseControlContainerName', 'releaseArtifactContainerName', 'releaseControllerPrincipalId'
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
    if ($parameters.ContainsKey('releaseControllerPrincipalId') -and
        $parameters.releaseControllerPrincipalId.value -ne '') {
        $controllerPrincipalId = [guid]::Empty
        if (![guid]::TryParse($parameters.releaseControllerPrincipalId.value, [ref]$controllerPrincipalId)) {
            throw 'releaseControllerPrincipalId must be the owner-verified OIDC service-principal object ID.'
        }
    }
}
if ($parameters.location.value -ne 'westus2') {
    throw 'This resource plan is approved only for westus2; a region change requires renewed approval.'
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
    if ([string]::IsNullOrWhiteSpace($env:TRMNL_FUNCTION_KEY)) {
        throw 'A function-scoped TRMNL_FUNCTION_KEY is required for post-deployment verification.'
    }
    $functionKey = $env:TRMNL_FUNCTION_KEY
    Remove-Item Env:TRMNL_FUNCTION_KEY -ErrorAction SilentlyContinue
    if (!(Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js is required to run the existing redacted deployed-service smoke check.'
    }
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
    $expectedFunctions = @('Agenda', 'RefreshSource')
    $functions = @()
    $bindingsVerified = $false
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        $functions = @(Invoke-Azure -Stage 'Deployed function indexing verification' -Json -Arguments @(
            'functionapp', 'function', 'list', '--subscription', $SubscriptionId,
            '--resource-group', $parameters.resourceGroupName.value,
            '--name', $parameters.functionAppName.value, '--output', 'json'
        ))
        $names = @($functions | ForEach-Object { ([string]$_.name).Split('/')[-1] } | Sort-Object)
        if ($names.Count -eq 2 -and
            @($expectedFunctions | Where-Object { $_ -cnotin $names }).Count -eq 0) {
            $agenda = @($functions | Where-Object { ([string]$_.name).Split('/')[-1] -ceq 'Agenda' })
            $refresh = @($functions | Where-Object { ([string]$_.name).Split('/')[-1] -ceq 'RefreshSource' })
            $agendaBindings = @($agenda[0].config.bindings)
            $refreshBindings = @($refresh[0].config.bindings)
            $httpTrigger = @($agendaBindings | Where-Object type -CEQ 'httpTrigger')
            $httpOutput = @($agendaBindings | Where-Object type -CEQ 'http')
            $timerTrigger = @($refreshBindings | Where-Object type -CEQ 'timerTrigger')
            $methods = @(if ($httpTrigger.Count -eq 1) {
                $httpTrigger[0].methods | ForEach-Object { [string]$_ } | Sort-Object
            })
            if ($httpTrigger.Count -eq 1 -and $httpOutput.Count -eq 1 -and
                $agendaBindings.Count -eq 2 -and
                $httpTrigger[0].authLevel -CEQ 'function' -and
                $httpTrigger[0].route -CEQ 'agenda' -and
                $methods.Count -eq 1 -and $methods[0] -CEQ 'post' -and
                $timerTrigger.Count -eq 1 -and $refreshBindings.Count -eq 1 -and
                $timerTrigger[0].schedule -CEQ '0 */5 * * * *' -and
                $timerTrigger[0].useMonitor -eq $true -and
                $timerTrigger[0].runOnStartup -eq $false) {
                $bindingsVerified = $true
                break
            }
        }
        Start-Sleep -Seconds 5
    }
    if (!$bindingsVerified) {
        throw 'Deployed Azure function indexing or expected authenticated HTTP/timer bindings could not be verified.'
    }
    $hostName = [string]$site.properties.defaultHostName
    if ($hostName -notmatch '^[A-Za-z0-9.-]+$') {
        throw 'The deployed Azure HTTPS host could not be safely identified for the redacted smoke check.'
    }
    $env:TRMNL_FUNCTION_KEY = $functionKey
    try {
        $smokeOutput = & node (Join-Path $root 'scripts\smoke-delivery.mjs') `
            --endpoint "https://$hostName/api/agenda" --expected-state current 2>$null
    }
    finally {
        Remove-Item Env:TRMNL_FUNCTION_KEY -ErrorAction SilentlyContinue
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Azure deployed-service smoke verification failed; raw response and diagnostics were withheld.'
    }
    try {
        $smoke = ($smokeOutput -join "`n") | ConvertFrom-Json
    }
    catch {
        throw 'Azure deployed-service smoke verification returned unusable evidence.'
    }
    if ($smoke.checks_passed -ne $true -or $smoke.activation_complete -ne $false -or
        $smoke.evidence_scope -ne 'deployed_http_only' -or $smoke.poll.state -ne 'current' -or
        $smoke.poll.error_code -ne $null) {
        throw 'Azure deployed-service smoke verification did not establish the expected current agenda and authentication checks.'
    }
    Write-Output 'Azure package deployment, expected function bindings and redacted current-agenda/authentication smoke checks passed. TRMNL publication and physical-device refresh remain separate.'
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
