# Secure Azure-to-TRMNL delivery

This is the repeatable procedure for [ticket #8](https://github.com/geevensingh/trmnl-calendar/issues/8), not a receipt of live activation. Deploy only the reviewed integration commit. Synthetic tests and a successful ARM what-if do not prove Azure authentication, private-source compatibility, managed-identity access, native settings transport, or delivery to a device. Leave #8 and [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2) open until the evidence checklist is complete.

## Approved scope and permissions

The owner's private resource plan supplies the subscription, exact resource names, and alert recipient. Do not commit those inputs or put them in issues. The approved location is **West US 2**, the monthly alert budget is **$20**, and always-ready capacity is **zero**. A different region, additional resource/role, increased scale, or paid warming requires renewed approval; a deployment error is not permission to change this plan.

`infra\main.bicep` creates the dedicated resource group and `resources.bicep` creates:

| Resource | Configuration |
| --- | --- |
| Functions plan/app | Linux Flex Consumption `FC1`, .NET **10.0 isolated**, 2048 MB, maximum **one** on-demand instance, no always-ready instances, default HTTP concurrency, HTTPS/TLS 1.2+ |
| Shared storage | One Hot StorageV2 Standard LRS account for host state, deployment packages, and a private source-cache container; no anonymous blobs or shared-key authentication |
| Host identity | User-assigned identity for host/deployment storage, not the application's cache credential |
| Source secret | Standard RBAC Key Vault; versionless Key Vault reference in `Agenda__SourceUrl`; the template never accepts the source URL |
| Telemetry | Workspace-based Application Insights with Entra ingestion authentication; Log Analytics PerGB2018, 30-day retention, 0.1 GB/day backup ingestion cap |
| Budget | Resource-group monthly $20; actual-spend alerts at **$10/$16/$20** (50/80/100%), forecast warning at 100% |

No API Management, VNet/private endpoint, premium plan, extra storage account, queue role, or paid warming is created. Basic SCM/FTP publishing credentials are disabled; supported Azure CLI deployment uses the operator's Entra authorization.

| Principal | Approved role and scope |
| --- | --- |
| Host user-assigned identity | **Storage Blob Data Owner**, shared storage account: the documented host minimum, intrinsically broader than the app cache |
| Host identity, only when retaining startup diagnostics | **Storage Table Data Contributor**, same account; controlled by `retainHostDiagnostics` |
| Function system-assigned identity | **Storage Blob Data Contributor**, cache **container only** |
| Function system-assigned identity | **Key Vault Secrets User**, dedicated vault |
| Function system-assigned identity | **Monitoring Metrics Publisher**, Application Insights component |

The parameter example explicitly retains host startup diagnostics and their Table role; setting that option to false forgoes that diagnostic storage. The application cache always uses an explicit **system-assigned** `ManagedIdentityCredential`, independent of the host's user-assigned client ID. No runtime identity receives control-plane Owner/Contributor.

The deployment operator needs resource-group creation, listed resource writes, budget writes, and role-assignment permission at the approved scopes, normally Contributor plus RBAC Administrator/User Access Administrator. The owner setting the secret separately needs authorized **Key Vault secret-write** access. Package retention separately needs an operator already authorized for Entra blob list/delete on the deployment container. Control-plane `*` or a successful what-if does **not** establish these data-plane rights. If absent, stop and obtain approval for the exact missing permission; these templates do not grant an operator extra roles or re-enable account keys.

## Local checks and package

Use the prerequisites and per-worktree display setup in the [README](../README.md#local-prerequisites). The delivery tooling additionally needs Azure CLI with Flex/.NET 10 support and Bicep. Node's built-in test runner needs no npm dependencies.

```powershell
.\scripts\deploy-azure.ps1
node --test .\tests\delivery\deployment.test.mjs .\tests\delivery\deploy-command.test.mjs .\tests\delivery\smoke.test.mjs
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal
```

The default deployment mode is **Build**, which only compiles Bicep into ignored `artifacts\infra\main.json`. Tooling tests compile the real template, publish the real app, and substitute only external Azure/Git commands for mutating-command checks. HTTP tests run the production handler/parser/cache and the smoke CLI across loopback HTTP. They measure a genuinely stalled six-second source, a large Unicode agenda, and the oversize error. Existing tests exercise the real Functions host and all six native rendered views.

After integration review, from its clean checkout:

```powershell
$package = .\scripts\package-function.ps1 | ConvertFrom-Json
$reviewedCommit = (git rev-parse HEAD).Trim()
```

This publishes portable Release .NET 10 output with no Windows apphost, zips **contents**, including hidden `.azurefunctions`, and records the commit, checkout cleanliness, SHA-256 and archive size beside the ZIP. This SDK uses **worker indexing**, not a fabricated legacy `functions.metadata` file. `host.json` and `worker.config.json` remain at the archive root. Local settings and `.env` files are rejected, and archives over 100 MiB are rejected. A dirty package can be inspected locally but cannot be deployed with `DeployCode`.

## Runtime inputs and read-only preflight

Copy `infra\parameters.example.json` into ignored runtime storage, fill its empty values from the approved private plan, and protect that file. Keep `budgetAlertEmail` a runtime input; it is also a secure ARM parameter. The subscription is a command parameter, never a committed default.

```powershell
New-Item -ItemType Directory -Force .\artifacts\infra | Out-Null
Copy-Item .\infra\parameters.example.json .\artifacts\infra\owner.parameters.json
$parametersFile = (Resolve-Path .\artifacts\infra\owner.parameters.json).Path
$subscriptionId = Read-Host 'Approved subscription ID'
.\scripts\deploy-azure.ps1 -Mode WhatIf -SubscriptionId $subscriptionId -ParametersFile $parametersFile
```

Do not supply source URLs, function keys, or arbitrary settings in this document. Unknown parameters are rejected. Non-owner defaults are `calendar-source-url`, `source-cache`, and `app-packages` for the secret and two private containers. `budgetStartDate` is required: enter the original creation month's first day as `YYYY-MM-01T00:00:00Z` and preserve that value in the runtime file for repeat deployments. It deliberately does not drift to each redeployment's month.

What-if uses resource-ID-only output, not resource payloads or recipient values. It makes no resource changes. Recheck current regional .NET 10 Flex availability and the maximum-instance minimum before applying. If the service rejects the approved maximum of one, stop rather than silently raising it to an older example's 40-instance minimum. Ensure the resource providers required by the manifest are registered; do not register or create unrelated infrastructure as a workaround.

## Integration-owner deployment

Only after the required integration review and approval of this exact resource plan:

```powershell
.\scripts\deploy-azure.ps1 -Mode Apply -ApprovedResourcePlan `
  -SubscriptionId $subscriptionId -ParametersFile $parametersFile
```

Record the deployment ID/commit and nonsecret settings/role scopes. Verify the budget is actually $20, its notification currency and thresholds, forecast support, and the owner's receipt configuration privately. If forecast notifications are unsupported, record that service limitation and obtain any necessary plan revision; do not silently remove all alerts. Alerts neither stop resources nor enforce a $20 bill.

### Owner-only source configuration

Use the coordinator-provided, verified **`configure-owner-source.sh` runtime artifact**. Its path is supplied privately as `SOURCE_WIZARD`, not embedded in this repository. It checks the approved target, guides the owner through Outlook publication permissions, and submits hidden URL input through a protected temporary file to Key Vault. It does not fetch the private feed or configure TRMNL.

```powershell
$env:ENV_FILE = '.env.owner-source'
bash -n $env:SOURCE_WIZARD
bash $env:SOURCE_WIZARD
Remove-Item Env:\ENV_FILE
```

Only nonsecret target identifiers are saved to that ignored env file. The URL must never enter a shell argument/history, deployment parameter, ticket, screenshot, TRMNL field, or diagnostic output.

The repeatable manual alternative is owner-only: privately inspect **Outlook Settings > Calendar > Shared calendars > Publish a calendar**, confirm the existing publication is authorized and supplies titles/timing (availability-only is insufficient), then use the approved **Key Vault > Secrets > Generate/Import**, manual secret `calendar-source-url`, and paste the published HTTPS ICS URL into its secret-value field. Do not broaden publication permissions without approval. No agent needs to see the value.

Allow managed-identity role propagation. Verify the Function's Key Vault reference resolves using its system identity. Versionless references can cache a secret for up to 24 hours; use the documented [reference refresh API](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references#understand-rotation), not a plaintext app-setting replacement, when immediate refresh is needed.

For an authorized immediate refresh, without printing secret values:

```powershell
$p = (Get-Content -LiteralPath $parametersFile -Raw | ConvertFrom-Json).parameters
$appResourceId = "/subscriptions/$subscriptionId/resourceGroups/$($p.resourceGroupName.value)/providers/Microsoft.Web/sites/$($p.functionAppName.value)"
. .\scripts\azure-cli.ps1
Invoke-Azure -Stage 'Key Vault reference refresh' -Arguments @(
  'rest', '--method', 'post', '--subscription', $subscriptionId,
  '--url', "https://management.azure.com${appResourceId}/config/configreferences/appsettings/refresh?api-version=2022-03-01",
  '--output', 'none'
)
```

### Code deployment

From that same clean, reviewed integration checkout:

```powershell
.\scripts\deploy-azure.ps1 -Mode DeployCode -ApprovedResourcePlan `
  -SubscriptionId $subscriptionId -ParametersFile $parametersFile `
  -PackageFile $package.archive -ReviewedIntegrationCommit $reviewedCommit
```

The command verifies the package hash and clean reviewed commit, then reads the actual target to require HTTPS Linux .NET 10, the approved Flex plan, 2 GiB/max-one and zero always-ready capacity. It uses supported `az functionapp deployment source config-zip --build-remote false`, which selects **Flex package deployment**, not classic zip deployment. Do not set `WEBSITE_RUN_FROM_PACKAGE`, Azure Files credentials, .NET 8/9 runtime settings, or an anonymous trigger.

Azure CLI errors are fatal and bounded; raw diagnostics are withheld because deployment/configuration failures can contain private input. Inspect additional diagnostics only in the owner's protected workflow, never by pasting raw logs into an issue. Acceptance of infrastructure/code is not activation evidence.

### Owner-only native plugin and key

In the approved Function app, open **Functions > Agenda > Function keys** and create a dedicated named key. Use a **function-scoped** key, never host/master keys. Copy its value privately into the native password-style `function_key` field; do not use a `?code=` URL or print/list keys into terminal output.

Use production `display\src\settings.yml` and all four production template files. The private plugin must have **one** publicly reachable HTTPS URL ending `/api/agenda`, POST, `Content-Type: application/json`, `x-functions-key: {{ function_key }}`, 15-minute refresh, framework 3.4.3, and this body:

```liquid
{"rules_json": {{ rules_json | json }}}
```

Keep the editor text a **string**, including malformed JSON. Do not interpolate it as a JSON fragment, substitute defaults after an invalid edit, add the source URL, or wrap single-URL data in `IDX_0`/webhook `merge_variables`. TRMNL's documented single-URL polling exposes response fields at the top level; multiple polling URLs are outside this setup. Private Plugins access already exists and 15-minute polling does not require TRMNL+.

In the actual native editor, verify quotes/newlines survive, malformed/unsupported rules produce a visible `configuration_invalid` state, `[]` deliberately clears exclusions, and subsequent valid edits affect subsequent polls without deployment. Restore intended exclusions afterward. Select OG/X and the required full, half-horizontal and half-vertical arrangements, including intended mashup placement. Confirm private device rendering and the source timestamp without saving private screenshots or bodies. A website preview is not device delivery.

## Redacted HTTP smoke and live limits

Read the nonsecret endpoint output into memory after infrastructure deployment:

```powershell
$agendaEndpoint = az deployment sub show --subscription $subscriptionId --name trmnl-calendar `
  --query properties.outputs.agendaEndpoint.value --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$agendaEndpoint) { throw 'The deployed agenda endpoint is unavailable.' }
```

Set the header key without echo/history in a protected owner terminal, with transcripts and shell tracing disabled:

```powershell
$secureKey = Read-Host 'Agenda function-scoped key' -AsSecureString
$env:TRMNL_FUNCTION_KEY = [Net.NetworkCredential]::new('', $secureKey).Password
try {
  node .\scripts\smoke-delivery.mjs --endpoint $agendaEndpoint
  if ($LASTEXITCODE -ne 0) { throw 'The redacted HTTP smoke checks failed.' }
}
finally {
  Remove-Item Env:\TRMNL_FUNCTION_KEY -ErrorAction SilentlyContinue
  $secureKey.Dispose()
}
```

`$agendaEndpoint` is the nonsecret HTTPS endpoint from deployment output, with no query or fragment. The key is consumed from the environment, never a CLI argument. The CLI prints only statuses, safe codes, source-success time, byte counts and per-attempt duration; it does not save or print response bodies, occurrences, rule text, URLs, keys or raw exceptions.

The **first** request is the authorized measured poll, before missing/wrong-key probes can warm the host. Missing and wrong keys must yield 401/403; the supplied header must yield a valid authorized result. A successful header cannot itself prove the key's scope: the owner must verify it was created under **Agenda**, not host keys.

The CLI measures the **whole parsed/re-serialized native single-URL polling object in UTF-8**, not event counts, selected fields, `Content-Length`, or a webhook envelope. Exactly **100,000 bytes fails**, 99,999 passes; the adapter's existing 95,000-byte bound leaves margin. An oversize agenda stays a renderable error with unknown counts and a known source timestamp, never silently truncated commitments.

Every HTTP/body attempt has a **10-second** deadline. Only one transport retry is allowed; both attempts remain in evidence. If the first attempt exceeds the budget and the retry succeeds, the smoke still **fails**. A 200 calendar error is not retried as a transport failure or called fresh. For a specific error/stale check, explicitly provide `--expected-state` and `--expected-code`. `--rules-file` reads bounded UTF-8 editor text without printing it and transports it as `rules_json`; use an ignored synthetic file for configuration-failure checks.

`--synthetic-local` allows only loopback HTTP and labels evidence `local_synthetic`. Production mode requires HTTPS and rejects loopback. All reports keep **`activation_complete: false`**; deployed HTTP checks cannot certify private TRMNL, device, cold-start status, or every owner gate.

Run separately after an observed on-demand idle/scale-to-zero interval, and on warm and configured upstream-failure paths. Record what established a cold candidate; `cold_start_confirmed: false` must not be relabeled proof merely because it was the first local request. The handler's six-second source bound and shared nine-second I/O cancellation budget exclude platform initialization, TLS/authentication and delivery overhead. Local measurements are not Azure cold-path measurements. Resolve measured incompatibility before activation; do not enable paid warming without new approval.

### Controlled source/cache evidence

The owner approved a temporary synthetic-source revision in the **existing** Function app, with a maximum 90-minute window and explicit teardown. This is approval of the narrow revision below, not evidence that it is deployed, enabled, or that any live check passed. No additional resource, role, instance, paid warming, or private-publication change is authorized.

Before testing, verify runtime **Production**, the Key Vault source reference, safe `Agenda__CacheServiceUri`, the private pre-existing `Agenda__CacheContainer`, and no development disk-cache override, storage credential or SAS. Current output requires a supported source **and successful persistence**, so a real production `current` poll is useful write evidence only after verifying that configuration.

For repeatable deployed stale/read/restart/expiry and timeout checks, an **already authorized, owner-controlled HTTPS synthetic source** must be able to serve a valid calendar and then reject/stall **the same URL**. Configure it only through the owner secret workflow for that smoke window, seed a last-good source, fail the upstream, restart the Function, and observe `stale` with the unchanged source-success time. At age **one hour or greater**, require `error` with null counts/no occurrences. Restore the actual owner source securely and obtain a new current result before device activation.

Changing the configured URL alone cannot simulate an outage of its old cache: the cache is intentionally bound to the source URL. The production agenda/parser/cache/time policy is unchanged and has no caller-selected feed, clock override, or test bypass. Use only the approved temporary source below; do not present local substitutes as deployed proof.

Actual private-feed publication/compatibility is a separate owner gate. A technically current but availability-only publication does not establish the required information. Never save its returned bodies or use them with preview/screenshot tooling.

### Temporary same-app synthetic source: remove after the approved smoke

Package and deploy the clean reviewed temporary integration commit through the **same** `package-function.ps1` / `deploy-azure.ps1 -Mode DeployCode` procedure above. Keep max-one/default HTTP concurrency and zero always-ready capacity unchanged. Only the integration owner deploys, changes the source secret, creates/revokes the key, and performs Azure checks.

`GET /api/smoke-source` is anonymous, `no-store`, and synthetic-only. It reads only `temporary-smoke-source-mode.json` in the existing private `Agenda__CacheContainer`, using the same explicit **system-assigned** identity and already-approved container Contributor scope. It never reads `last-good-source.json`, the configured source URL, or caller calendar/URL/path inputs. Its fixed synthetic all-day/timed appointments use current Los Angeles working dates. There is no new runtime setting; the existing Development-only cache directory substitutes local storage in tests and is ignored in Production.

`POST /api/smoke-source-control` has **Function** host authentication. Create a dedicated temporary key under **SmokeSourceControl**, not Agenda or host/master keys. Use only `x-functions-key` in a protected owner terminal, with the hidden-input/cleanup pattern above; never print the key, put it in a query string, or send it to TRMNL. Local Core Tools disables normal auth enforcement: verify missing/wrong/revoked keys and the correct dedicated header in Azure.

The control body is a JSON object, at most **1,024 UTF-8 bytes**, with exactly `mode` and `expires_at`, or exactly `mode` for disable. Names/modes are case-sensitive; unknown/duplicate properties, query parameters, non-JSON bodies, supplied URLs/calendars/scripts/paths, and invalid expiry data return `400 smoke_configuration_invalid`. `expires_at` is an absolute, offset-zero UTC ISO timestamp after the current time and no more than 90 minutes ahead. Save the **accepted original expiry** and reuse it for every mode change:

```powershell
# $temporaryControlHeaders contains only the privately obtained dedicated x-functions-key.
$controlEndpoint = $agendaEndpoint -replace '/api/agenda$', '/api/smoke-source-control'
$windowExpires = [DateTimeOffset]::UtcNow.AddMinutes(90).ToString('O')
$body = @{ mode = 'valid'; expires_at = $windowExpires } | ConvertTo-Json -Compress
$controlState = Invoke-RestMethod $controlEndpoint -Method Post `
  -Headers $temporaryControlHeaders -ContentType application/json -Body $body
$windowExpires = $controlState.expires_at
```

The successful response contains only version, fixed mode, original `opened_at`, and `expires_at`. Subsequent controls may preserve or shorten expiry, never extend it (`409 smoke_window_extension`). Expired state cannot be reopened by another mode write (`409 smoke_window_expired`); do not open another window without owner approval. Blob reads/writes/deletion use bounded I/O and conditional ETags; a competing mutation can return `409 smoke_conflict`. Storage/configuration/state failures are explicit fixed `smoke_*` codes, not raw Azure errors. Only the two temporary function warning categories are added to the existing bounded telemetry allowlist.

| `mode` | Same fixed GET URL | Expected fresh-check failure, if any |
| --- | --- | --- |
| `valid` | HTTP 200, fixed supported synthetic ICS | None; `current` still requires production cache persistence |
| `unavailable` | HTTP 503 | `source_unavailable` |
| `delay` | Asynchronous seven-second wait, then HTTP 503 | `source_unavailable` at the adapter's unchanged six-second source deadline |
| `malformed` | HTTP 200, fixed malformed synthetic data | `source_invalid` |
| `unsupported_range` | HTTP 200, fixed synthetic `RANGE=THISANDFUTURE` recurrence | `compatibility_unsupported` |
| `disabled` | Deletes only the mode blob; GET returns HTTP 503 `smoke_disabled` | `source_unavailable` |

For a mode change, repeat the POST with the chosen mode and **the saved `$windowExpires`**, not a new `UtcNow + 90 minutes`. Missing state defaults to disabled; at the exact expiry or later, GET returns HTTP 503 `smoke_expired` without healthy ICS. Expiry does not delete code, revoke the key, or remove retained synthetic agenda source.

Configure the nonsecret fixed HTTPS `/api/smoke-source` URL only through the approved source-secret workflow, and refresh its reference. Seed a supported source, switch modes at that same URL, and run the existing redacted smoke tool for stale/error categories, unchanged source-success time, restart-read, strict one-hour expiry, latency/retry and payload evidence. Same-app polling needs a second asynchronous HTTP invocation; stop if approved default concurrency cannot serve it, rather than increasing capacity. The public compute surface remains callable while code exists; budget alerts are not a spending cap.

When the authorized smoke is complete, stop mode changes and explicitly clean up through the protected control:

```powershell
$disabled = Invoke-RestMethod $controlEndpoint -Method Post `
  -Headers $temporaryControlHeaders -ContentType application/json -Body '{"mode":"disabled"}'
# Clear protected key/header variables and revoke the dedicated function key in the owner workflow.
```

Verify disabled state, revoke the temporary key, then signal teardown. Remove `TemporarySmokeSource.cs`, `TemporarySmokeSourceTests.cs`, the two temporary host/test logging entries, the temporary Functions-definition test adjustment, and this temporary runbook section from the reviewed final tree. Deploy a newly built clean production package without either function and verify **both** routes have no function match. Do not delete the private source snapshot or a container to clean up this mode blob.

Finally restore the actual source securely, refresh the reference, and obtain a new private-source `current` result to replace the synthetic snapshot before accepting native/private-device delivery. Synthetic success is not private-feed compatibility or activation proof. If interrupted, expiry only stops healthy synthetic publication: explicit key/blob/code teardown and actual-source restoration remain required.

## Bounded storage and diagnostics

The source cache overwrites one bounded `last-good-source.json` (2 MiB source, 13 MiB escaped envelope). Versioning, blob/container soft delete, change feed and restore history are disabled in this dedicated shared account. A lifecycle rule targets **only** that cache blob for deletion after more than one day without modification. Lifecycle deletion is asynchronous, not an exact one-day privacy timer; serving eligibility remains strictly less than one hour. It does not delete active code or unrelated host state.

After each successful code deployment, retain the **active package and one previous successful package**, not simply the two newest uploads. Keep their matching reviewed archives/manifests privately for recovery. Under an exclusive deployment window, use Azure's **Flex Consumption Deployment** diagnostic tool (Function app > Diagnose and solve problems) to identify actual active/previous package names and success status. Never infer the active pointer from blob age or last upload.

```powershell
$retentionTarget = @{
  SubscriptionId = $subscriptionId
  ResourceGroupName = $approvedResourceGroup
  FunctionAppName = $approvedFunctionApp
  StorageAccountName = $approvedStorageAccount
  DeploymentContainerName = 'app-packages'
  ActivePackage = $azureVerifiedActivePackage
  PreviousSuccessfulPackage = $azureVerifiedPreviousSuccessfulPackage
}
.\scripts\prune-deployment-packages.ps1 @retentionTarget
.\scripts\prune-deployment-packages.ps1 @retentionTarget -Apply -ConfirmedActiveAndPreviousFromAzure
```

Use the runtime container name instead if deliberately configured differently. For the first successful deployment with only one ZIP, omit `PreviousSuccessfulPackage`. If multiple packages exist without an identified previous success, stop for manual recovery rather than guessing. Do not deploy concurrently with cleanup.

Pruning defaults to read-only, verifies that Azure actually configures this deployment container, protects exact active/previous names regardless of age, deletes only other recognized ZIPs with ETag preconditions and Entra login, then verifies retention. It never enumerates/deletes another container or non-package host state. Unrecognized layouts, missing names/concurrency tokens, access failures or concurrent changes fail closed. If the operator lacks authorized data-plane access or cannot identify the real active package, stop further releases until retention is resolved; no broad lifecycle deletion or account-key fallback is acceptable.

`host.json` permits fixed application warning codes and host aggregate metrics, disables automatic **dependency URL** capture, HTTP extended collection, raw invocation/default categories, live metrics, performance counters, snapshots and file logging, and samples toward one telemetry item/second. Production HttpClient loggers and cache SDK URL/content/tracing diagnostics are also disabled. There is no direct worker Application Insights SDK or auto-instrumentation agent; adding one requires a fresh redaction check.

Verify actual Entra-authenticated ingestion with a deliberate synthetic invalid-rule poll: the fixed `configuration_invalid` warning must arrive. Check source, compatibility and storage categories using controlled failures, never raw exception text. In the workspace, inspect only aggregate counts first:

```kusto
union withsource=TableName AppDependencies, AppRequests, AppExceptions
| summarize Rows=count() by TableName
```

Those automatic categories should have no rows from this setup. Safe diagnostic codes can be counted without reading private fields:

```kusto
AppTraces
| where Message startswith "Agenda failed with code "
| summarize Polls=count() by Message
```

Unexpected automatic capture is a stop condition, not permission to dump URLs or raw exceptions into artifacts. Verify 30-day workspace retention and the 0.1 GB/day cap in Azure, and review ingestion volume. Filtering/sampling is the primary control; caps can overshoot, suppress useful diagnostics when reached, and are **not** hard spending limits. Leave host-managed diagnostic tables/state to the host's own rotation, not generic cleanup.

## Rotation, recovery and freshness

For normal function-key rotation, create a second named **Agenda** key, privately replace the native password field, verify new-header polling and the next actual device poll, then revoke the old function key. Verify the revoked header is rejected. Keep the old key only during that bounded cutover; an incident may require immediate revocation and a visible delivery outage. Do not rotate host/master keys to fix a plugin key.

For source rotation, the owner verifies publication permissions, sets a new version of the same vault secret through the protected workflow, refreshes the Key Vault reference, and checks compatibility/current output. A changed source URL cannot use the previous feed's cache. Disable obsolete secret versions and revoke obsolete published URLs as appropriate; Key Vault does not support deleting just one secret version. Never claim an enabled version's deletion or an old bearer URL's revocation without owner confirmation.

For a bad code release, recover a retained reviewed archive/manifest from its source commit and redeploy it through the same Flex package path after verifying approval. Use a separate clean linked checkout at that reviewed source commit, not a destructive reset of the current integration branch; `DeployCode` deliberately requires the checkout, manifest and reviewed commit to agree. A rollback package remains source-bound and cannot turn an expired cache current. For `cache_unavailable`, repair the system identity's container role/connectivity instead of enabling Development disk persistence or storage keys. For a lost cache, a fresh supported source can repopulate it; otherwise display a truthful error. Do not indiscriminately delete shared host containers or recreate identities (their role-assignment principals change).

The source-success timestamp means successful **fetch and supported interpretation**, not Outlook publication time, poll/render time, or device refresh. Stale polls retain it, and an expired retained source may still provide a known old timestamp with unknown counts. A 15-minute poll target also includes Outlook publication delay and device refresh; an offline device can retain the old e-ink image and its old warning indefinitely. Check the visible timestamp and actual subsequent polls rather than promising a new warning reaches an offline device.

## Cost and live evidence

The approved West US 2 retail-price check on 2026-10-19 used $0.000026/GB-second for Flex on-demand compute, $0.40/million executions, Hot LRS $0.0184/GB-month, and Log Analytics $2.30/GB ingestion. These are planning rates, not a bill or subscription-specific quote; recheck [regional pricing](https://azure.microsoft.com/en-us/pricing/details/functions/) and the [retail API](https://prices.azure.com/api/retail/prices) before apply.

Normal low-volume planning is roughly **$1-$3/month before credits**: two independent 15-minute polling configurations, about 1-5 billed seconds/request, no routine retries, and 20-200 MB/month telemetry. A deliberately pessimistic ten-second attempt plus one retry on every poll is about $6.19 compute/month; hitting the 0.1 GB/day telemetry backup cap all 31 days adds about $7.13. Storage, transactions, Key Vault and applicable network charges are additional. Eligibility/remaining Visual Studio credits and Flex grants have not been established; do not promise a zero bill. $20 notifications are alerts, not a target or hard cap.

Record only redacted facts, metrics and owner confirmations in the ticket:

| Required evidence | Current delivery-tooling status |
| --- | --- |
| Authorized infrastructure/code deployed from reviewed integration commit; actual runtime/scale/roles/retention/budget verified | **Not deployed by this worker**; local checks/what-if are not deployment |
| Fixed actual source stored only in Key Vault; owner publication permissions and parser compatibility | **Owner gated / not checked** |
| Missing/wrong/correct/revoked function-scoped header results in Azure | **Not run live** |
| Actual native POST/header/editor transport, malformed JSON, edited rules on subsequent polls | **Not run live** |
| Production system-identity cache write/read, persistence through restart, stale timestamp, expiry | **Not run live**; fault/restart/expiry checks **blocked** on the controlled-source gate |
| Real source response and actual native combined polling data strictly below 100,000 serialized UTF-8 bytes | **Not measured live**; local boundary checks do not substitute |
| Cold-sensitive, warm and source-failure latency, including the one retry's separate outcome | **Not measured live** |
| Entra telemetry ingestion and absence of automatic URL/private-field capture | **Not verified live** |
| Owner's physical OG/X, required placements, visible source timestamp and subsequent refresh/settings change | **Not observed**; no private screenshots |
| Actual operating cost/ingestion and budget notification configuration | **Not observed**; estimates are not bills |

For measured HTTP evidence, record UTC time, reviewed commit/deployment ID, expected/result state and safe code, per-attempt milliseconds, serialized byte count, and source-success time. Keep private bodies, calendar text, source URLs, keys and recipient/owner identifiers out of the record. Stop on any missing gate or measured incompatibility; do not close tickets based on local success.
