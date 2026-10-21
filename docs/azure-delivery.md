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

### Approved scheduled refresh revision

The internal `RefreshSource` timer uses stable `Microsoft.Azure.Functions.Worker.Extensions.Timer` **4.3.1** in this same app. Real worker indexing must show exactly **Agenda** (function-authenticated POST `/api/agenda`) and **RefreshSource** (one timer), not an anonymous/admin/test HTTP function. Its NCRONTAB is **`0 */5 * * * *` in UTC**, `UseMonitor=true`, `RunOnStartup=false`. The gate evaluates the scheduled tick in pinned `America/Los_Angeles`: Monday-Friday **09:00 inclusive to 18:00 exclusive** acquires every five minutes; otherwise only local minutes **00/15/30/45**. DST is applied and weekday holidays are included. No `WEBSITE_TIME_ZONE`/`TZ`, fixed UTC offset, new native editor or extra runtime setting is needed. Eventual adjustability remains future work.

[Timer connections](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-timer#connections) use `AzureWebJobsStorage` blob coordination and require **Storage Blob Data Owner**, already assigned to the approved host user-assigned identity. The timer monitor persists scheduling state and serializes host timer executions. It does not require a queue role. Source/status persistence and its short blob lease use only the existing system-identity **cache-container Blob Data Contributor** grant. No resource, account, role, credential, queue, public route, scale increase or always-ready instance is added. If actual deployment reveals another requirement, stop for separate approval rather than widening this plan.

Source acquisition allows **30 seconds for headers plus body**, within **35 seconds overall** for coordination, supported parser interpretation and publication. HTTP only reads/reinterprets persisted raw source/outcome and retains its nine-second I/O cancellation budget; it never waits for Outlook or starts background refresh. TRMNL still polls every **15 minutes**, independently of the timer. `current` requires a matching latest completed successful check **younger than 15 minutes**, not five minutes. A failed/delayed/incomplete refresh is visibly stale only with good source **younger than one hour**; exactly one hour/no source/invalid rules is an error with null counts.

There are still only two bounded private application blobs: `last-good-source.json` (2 MiB source, 13 MiB escaped envelope) and `source-refresh-status.json` (4 KiB). Durable generations allocated before acquisition fence overlapping/equal-clock/old-source work. Required `CompletedGeneration` preserves the exact completed identity independently of newer pending allocations; current requires the full matching version-2 source identity, not a generation check disabled by pending work. Nested duplicate/unknown fields and contradictory completed/pending metadata fail closed. Pending work preserves the latest completed outcome and original timestamp; it cannot manufacture source success. At 35 seconds a pending attempt is delayed. Committing/partial or missing matching status cannot certify current. A successful supported check publishes raw source before its matching completed marker. A genuine four-field legacy source is at most stale below one hour until the new timer succeeds; a version-1 envelope carrying version-2 fields is invalid, and status missing the required completed generation is not trusted. See the [exact status schema and freshness contract](agenda-contract.md#states-and-errors).

The deployment operator needs resource-group creation, listed resource writes, budget writes, and role-assignment permission at the approved scopes, normally Contributor plus RBAC Administrator/User Access Administrator. The owner setting the secret separately needs authorized **Key Vault secret-write** access. Package retention separately needs an operator already authorized for Entra blob list/delete on the deployment container. Control-plane `*` or a successful what-if does **not** establish these data-plane rights. If absent, stop and obtain approval for the exact missing permission; these templates do not grant an operator extra roles or re-enable account keys.

## Local checks and package

Use the prerequisites and per-worktree display setup in the [README](../README.md#local-prerequisites). The delivery tooling additionally needs Azure CLI with Flex/.NET 10 support and Bicep. Node's built-in test runner needs no npm dependencies.

```powershell
.\scripts\deploy-azure.ps1
node --test .\tests\delivery\deployment.test.mjs .\tests\delivery\deploy-command.test.mjs .\tests\delivery\smoke.test.mjs
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal
```

The default deployment mode is **Build**, which only compiles Bicep into ignored `artifacts\infra\main.json`. Tooling tests compile the real template, publish the real app, and substitute only external Azure/Git commands for mutating-command checks. Refresh/HTTP tests use actual handlers, real parser/raw persistence and production client registration, including real acquisition above ten seconds with independent fast HTTP, controlled 30/35/9-second deadlines, LA cadence/DST/holidays, exact freshness/expiry, durable concurrency, partial publication and malformed status. Smoke tests retain strict serialized-size and first-red/retry behavior. Real Core Tools verifies exactly two indexed bindings and cache-only HTTP after restart; Liquid/Chromium covers all six native views. Local direct timer execution is not evidence of deployed host monitor/managed-identity coordination.

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

For this revision, deploy only the clean reviewed scheduled-refresh integration package; no IaC resource/role expansion is required. Verify both real bindings and the existing host storage identity. Wait for an **eligible natural scheduled tick**, not a startup/warming invocation. Confirm fixed refresh diagnostics, successful system-identity source/status persistence and original source-success time. Then run the original actual-source HTTP loop **untouched before restart/warmup/auth probes**, retaining its first result even if red. Verify latency/payload/rules and the next actual native poll separately. A source that still exceeds 30 seconds remains a truthful source failure, not permission to extend cache age or polling limits.

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

If the first authorized poll has the wrong state or error code, the CLI exits unsuccessfully with **`checks_passed: false`** and **`activation_complete: false`**, preserving its status, duration, attempts/retry, safe actual state/code, validated source-success timestamp, raw response bytes and complete serialized polling bytes. It does not run missing/wrong-key probes on that failure. Contract/timestamp validation precedes extraction; malformed or unknown contracts retain transport evidence with fixed unknown calendar fields and no serialized-shape byte claim. Only the current contract's allowlisted codes may be printed or supplied as `--expected-code`; other upstream codes become the fixed `unknown` marker, not echoed private text. No second response is substituted to make a failed calendar check look successful.

`--synthetic-local` allows only loopback HTTP and labels evidence `local_synthetic`. Production mode requires HTTPS and rejects loopback. All reports keep **`activation_complete: false`**; deployed HTTP checks cannot certify private TRMNL, device, cold-start status, or every owner gate.

Run separately after an observed on-demand idle/scale-to-zero interval, and on warm and configured upstream-failure paths. Record what established a cold candidate; `cold_start_confirmed: false` is not proof merely because a request was first. The independent timer has 30-second headers/body and 35-second overall refresh deadlines. The cache-only HTTP path has nine seconds for storage/interpretation, not source acquisition. Platform initialization, inbound TLS/authentication and delivery overhead remain outside that budget; neither the architecture nor local timings guarantee ten-second cold delivery. Resolve measured incompatibility before activation; do not enable paid warming or infer another synchronous source retry.

### Controlled source/cache evidence

The integration owner reported deployed controlled-source checks on **2026-10-19**: same-URL HTTP rejection, delay, malformed calendar and unsupported recurrence, process-restart cache read, and cached-rule edits passed. A result was visibly stale at source age **3,593.759 seconds** and an error at **3,602.664 seconds**, retaining the original source-success timestamp. This is synthetic-source evidence, not actual private-feed compatibility, confirmed cold-start latency, or private-device delivery. Final deployed production route absence remains an owner verification step.

The later native/actual-source failure is retained, not replaced by those successes: after the reviewed eight-second synchronous change, the **first untouched** authorized production poll returned HTTP 200 `error/source_unavailable` in **8,646 ms**, with the old source-success time, no retry and a **468-byte** response. A protected exact-source diagnostic then received **no headers in 15,023 ms**, capturing neither URL nor body. That exceeds the entire ten-second TRMNL attempt independently of adapter cold start and motivated the owner-approved scheduled revision. These historical failures remain red; a warm retry cannot erase them. Scheduled-refresh deployment/current-source/native acceptance is still pending.

Before testing, verify runtime **Production**, the Key Vault source reference, safe `Agenda__CacheServiceUri`, the private pre-existing `Agenda__CacheContainer`, and no development disk-cache override, storage credential or SAS. Current output requires a supported source **and successful persistence**, so a real production `current` poll is useful write evidence only after verifying that configuration.

For repeatable deployed stale/read/restart/expiry and timeout checks, an **already authorized, owner-controlled HTTPS synthetic source** must serve valid calendar then reject/stall **the same URL**. Use only the approved owner secret workflow. Let the timer seed good source, fail upstream, and wait for a completed failed check: even source younger than 15 minutes must then be visibly stale without changing success time. Restart and verify both source/outcome survive. Delaying checks reaches stale at exactly 15 minutes; at **one hour or greater**, require `error` with null counts/no occurrences. Restore the actual source securely and require a new supported timer check/current HTTP result before device activation.

Changing the configured URL alone cannot simulate an outage of its old cache: the cache is intentionally bound to the source URL. There is no production test-source endpoint, caller-selected feed, clock override or failure-injection switch. Future controlled-source checks require explicit owner approval of their source scope; do not add infrastructure, break private Outlook publication, weaken production cache identity, or present local substitutes as deployed proof.

Actual private-feed publication/compatibility is a separate owner gate. A technically current but availability-only publication does not establish the required information. Never save its returned bodies or use them with preview/screenshot tooling.

## Bounded storage and diagnostics

The source cache overwrites bounded `last-good-source.json` (2 MiB source, 13 MiB escaped envelope) and one `source-refresh-status.json` (4 KiB of safe outcome/pending metadata only). Versioning, blob/container soft delete, change feed and restore history remain disabled. The existing lifecycle rule targets **only raw source** after more than one day without modification; the single overwritten status object contains no calendar content and cannot grow as history. Lifecycle deletion is asynchronous, not an exact privacy timer; serving eligibility stays strictly less than one hour. No active code or unrelated host state is deleted.

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

`host.json` permits fixed Agenda warning codes, fixed RefreshSource outcome/failure codes and host aggregate metrics. The refresh's information-level `Agenda refresh finished with code source_checked.` means supported source processing finished, not that an obsolete attempt replaced newer state; `refresh_superseded` means older-dated work was rejected before acquisition. Matching completed persisted outcome plus HTTP are authoritative. It disables automatic **dependency URL** capture, HTTP extended collection, raw invocation/default categories, live metrics, performance counters, snapshots and file logging, and samples toward one telemetry item/second. Production HttpClient loggers and cache SDK URL/content/tracing diagnostics remain disabled. No worker Application Insights SDK/auto-instrumentation is added.

Verify actual Entra-authenticated ingestion with a deliberate synthetic invalid-rule poll: the fixed `configuration_invalid` warning must arrive. Check source, compatibility and storage categories using controlled failures, never raw exception text. In the workspace, inspect only aggregate counts first:

```kusto
union withsource=TableName AppDependencies, AppRequests, AppExceptions
| summarize Rows=count() by TableName
```

Those automatic categories should have no rows from this setup. Safe diagnostic codes can be counted without reading private fields:

```kusto
AppTraces
| where Message startswith "Agenda failed with code "
    or Message startswith "Agenda refresh failed with code "
    or Message == "Agenda refresh finished with code source_checked."
    or Message == "Agenda refresh finished with code refresh_superseded."
| summarize Checks=count() by Message
```

Unexpected automatic capture is a stop condition, not permission to dump URLs or raw exceptions into artifacts. Verify 30-day workspace retention and the 0.1 GB/day cap in Azure, and review ingestion volume. Filtering/sampling is the primary control; caps can overshoot, suppress useful diagnostics when reached, and are **not** hard spending limits. Leave host-managed diagnostic tables/state to the host's own rotation, not generic cleanup.

## Rotation, recovery and freshness

For normal function-key rotation, create a second named **Agenda** key, privately replace the native password field, verify new-header polling and the next actual device poll, then revoke the old function key. Verify the revoked header is rejected. Keep the old key only during that bounded cutover; an incident may require immediate revocation and a visible delivery outage. Do not rotate host/master keys to fix a plugin key.

For source rotation, the owner verifies publication permissions, sets a new version of the same vault secret through the protected workflow, refreshes the Key Vault reference, and checks compatibility/current output. A changed source URL cannot use the previous feed's cache. Disable obsolete secret versions and revoke obsolete published URLs as appropriate; Key Vault does not support deleting just one secret version. Never claim an enabled version's deletion or an old bearer URL's revocation without owner confirmation.

For a bad code release, recover a retained reviewed archive/manifest from its source commit and redeploy it through the same Flex package path after verifying approval. Use a separate clean linked checkout at that reviewed source commit, not a destructive reset of the current integration branch; `DeployCode` deliberately requires the checkout, manifest and reviewed commit to agree. A rollback package remains source-bound and cannot turn an expired cache current. For `cache_unavailable`, repair the system identity's container role/connectivity instead of enabling Development disk persistence or storage keys. For a lost cache, a fresh supported source can repopulate it; otherwise display a truthful error. Do not indiscriminately delete shared host containers or recreate identities (their role-assignment principals change).

The source-success timestamp means successful **fetch and supported interpretation**, not Outlook publication time, poll/render time, or device refresh. Stale polls retain it, and an expired retained source may still provide a known old timestamp with unknown counts. A 15-minute poll target also includes Outlook publication delay and device refresh; an offline device can retain the old e-ink image and its old warning indefinitely. Check the visible timestamp and actual subsequent polls rather than promising a new warning reaches an offline device.

## Cost and live evidence

The approved West US 2 retail-price check on 2026-10-19 used $0.000026/GB-second for Flex on-demand compute, $0.40/million executions, Hot LRS $0.0184/GB-month, and Log Analytics $2.30/GB ingestion. These are planning rates, not a bill or subscription-specific quote; recheck [regional pricing](https://azure.microsoft.com/en-us/pricing/details/functions/) and the [retail API](https://prices.azure.com/api/retail/prices) before apply.

For the approved nine-hour weekday window, a **31-day month with 23 weekdays** has up to **4,632 source checks**: 2,976 base quarter-hour checks plus 1,656 additional business-hours checks. Billing every check for the full **35 seconds at 2 GB** is approximately **$8.43 scheduled compute before credits** at that rate. The five-minute UTC trigger also runs lightweight skipped ticks outside the acquisition cadence (8,928 total ticks in 31 days); timer coordination/skips, HTTP polls and any permitted transport retries, storage/status transactions, Key Vault, telemetry and network charges are additional. Faster ordinary checks should cost less, not zero. Hitting the 0.1 GB/day telemetry backup cap all 31 days adds about $7.13. Credits/grant eligibility is not established. The unchanged **$20 alerts are not a spending cap**; this is a cautious illustration, not a bill or permission for paid warming.

Record only redacted facts, metrics and owner confirmations in the ticket:

| Required evidence | Current delivery-tooling status |
| --- | --- |
| Authorized infrastructure/code deployed from reviewed integration commit; actual runtime/scale/roles/retention/budget verified | **Not deployed by this worker**; local checks/what-if are not deployment |
| Fixed actual source stored only in Key Vault; owner publication permissions and parser compatibility | **Owner gated / not checked** |
| Missing/wrong/correct/revoked function-scoped header results in Azure | **Not run live** |
| Actual native POST/header/editor transport, malformed JSON, edited rules on subsequent polls | **Not run live** |
| Production system-identity cache write/read, persistence through restart, stale timestamp, expiry | **Owner-reported deployed synthetic checks passed, 2026-10-19**; actual-source compatibility/current output remains owner gated |
| Actual scheduled host timer, existing UAI coordination, system-identity raw/outcome publication, LA cadence and delayed refresh | **Pending scheduled-revision deployment/verification**; local handler/indexing tests are not live timer evidence |
| Real source response and actual native combined polling data strictly below 100,000 serialized UTF-8 bytes | **Not measured live**; local boundary checks do not substitute |
| Cold-sensitive, warm and source-failure latency, including the one retry's separate outcome | **Historical first actual-source poll red: 8,646 ms/source_unavailable**; cache-only scheduled revision not yet measured live |
| Entra telemetry ingestion and absence of automatic URL/private-field capture | **Not verified live** |
| Owner's physical OG/X, required placements, visible source timestamp and subsequent refresh/settings change | **Not observed**; no private screenshots |
| Actual operating cost/ingestion and budget notification configuration | **Not observed**; estimates are not bills |

For measured HTTP evidence, record UTC time, reviewed commit/deployment ID, expected/result state and safe code, per-attempt milliseconds, serialized byte count, and source-success time. Keep private bodies, calendar text, source URLs, keys and recipient/owner identifiers out of the record. Stop on any missing gate or measured incompatibility; do not close tickets based on local success.
