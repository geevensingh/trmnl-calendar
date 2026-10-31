# Secure Azure-to-TRMNL delivery

This is the repeatable procedure for [ticket #8](https://github.com/geevensingh/trmnl-calendar/issues/8), not a receipt of live activation. Deploy only the reviewed integration commit. Synthetic tests and a successful ARM what-if do not prove Azure authentication, private-source compatibility, managed-identity access, native settings transport, or delivery to a device. Leave #8 and [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2) open until the evidence checklist is complete.

Git landing, publication, completion reporting, and ticket closure follow the [delivery contract](agents/delivery.md). The live activation evidence below is an additional gate, not proof of landing on the target branch.

The owner-confirmed [automated Azure/TRMNL delivery design](automated-delivery.md)
records the main-triggered release contract, including reviewed infrastructure
changes within `rg-trmnl-calendar`. The design record does not establish live
activation; this runbook documents the implementation and operator procedures.
Its fixed resource plan is the starting configuration, not the CD system's
permanent authorization limit.

## Approved scope and permissions

The owner's private resource plan supplies the subscription, exact resource names, and alert recipient. Do not commit those inputs or put them in issues. The approved location is **West US 2**, the monthly alert budget is **$20**, and always-ready capacity is **zero**. A different region, additional resource/role, increased scale, or paid warming requires renewed approval; a deployment error is not permission to change this plan.

`infra\main.bicep` creates the dedicated resource group and `resources.bicep` creates:

| Resource | Configuration |
| --- | --- |
| Functions plan/app | Linux Flex Consumption `FC1`, .NET **10.0 isolated**, 2048 MB, maximum **one** on-demand instance, no always-ready instances, default HTTP concurrency, HTTPS/TLS 1.2+ |
| Shared storage | One Hot StorageV2 Standard LRS account for host state, deployment packages, and a private source-cache container; no anonymous blobs or shared-key authentication |
| Release storage | A separate Hot StorageV2 Standard LRS account for the private release ledger and retained artifacts; no Function runtime grants |
| Host identity | User-assigned identity for host/deployment storage, not the application's cache credential |
| Source secret | Standard RBAC Key Vault; versionless Key Vault reference in `Agenda__SourceUrl`; the template never accepts the source URL |
| Participation owner identity | Adapter-only `Agenda__OwnerAddress`, an exact `mailto:` address; no HTTP or plugin input |
| Telemetry | Workspace-based Application Insights with Entra ingestion authentication; Log Analytics PerGB2018, 30-day retention, 0.1 GB/day backup ingestion cap |
| Budget | Resource-group monthly $20; actual-spend alerts at **$10/$16/$20** (50/80/100%), forecast warning at 100% |

No API Management, VNet/private endpoint, premium plan, queue role, or paid warming is created. The release account is separate because the host's required account-wide data role must not extend to release records. Its storage and transaction charges are additional; budget alerts are not a spending cap. Basic SCM/FTP publishing credentials are disabled; supported Azure CLI deployment uses the operator's Entra authorization.

| Principal | Approved role and scope |
| --- | --- |
| Host user-assigned identity | **Storage Blob Data Owner**, shared storage account: the documented host minimum, intrinsically broader than the app cache |
| Host identity, only when retaining startup diagnostics | **Storage Table Data Contributor**, same account; controlled by `retainHostDiagnostics` |
| Function system-assigned identity | **Storage Blob Data Contributor**, cache **container only** |
| Release controller identity | **Storage Blob Data Contributor**, separately scoped to each release container in the dedicated release account |
| Function system-assigned identity | **Key Vault Secrets User**, dedicated vault |
| Function system-assigned identity | **Monitoring Metrics Publisher**, Application Insights component |
| Separately owner-approved diagnostic operator | **Storage Blob Data Reader**, private cache **container only**; not provisioned automatically |

The parameter example explicitly retains host startup diagnostics and their Table role; setting that option to false forgoes that diagnostic storage. The application cache always uses an explicit **system-assigned** `ManagedIdentityCredential`, independent of the host's user-assigned client ID. No runtime identity receives control-plane Owner/Contributor.

### Approved scheduled refresh revision

The internal `RefreshSource` timer uses stable `Microsoft.Azure.Functions.Worker.Extensions.Timer` **4.3.1** in this same app. Real worker indexing must show exactly **Agenda** (function-authenticated POST `/api/agenda`) and **RefreshSource** (one timer), not an anonymous/admin/test HTTP function. Its NCRONTAB is **`0 */5 * * * *` in UTC**, `UseMonitor=true`, `RunOnStartup=false`. The gate evaluates the scheduled tick in pinned `America/Los_Angeles`: Monday-Friday **09:00 inclusive to 18:00 exclusive** acquires every five minutes; otherwise only local minutes **00/15/30/45**. DST is applied and weekday holidays are included. No `WEBSITE_TIME_ZONE`/`TZ`, fixed UTC offset, new native editor or extra runtime setting is needed. Eventual adjustability remains future work.

[Timer connections](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-timer#connections) use `AzureWebJobsStorage` blob coordination and require **Storage Blob Data Owner**, already assigned to the approved host user-assigned identity. The timer monitor persists scheduling state and serializes host timer executions. It does not require a queue role. Source/status persistence and its short blob lease use only the existing system-identity **cache-container Blob Data Contributor** grant. No resource, account, role, credential, queue, public route, scale increase or always-ready instance is added. If actual deployment reveals another requirement, stop for separate approval rather than widening this plan.

Source acquisition allows **30 seconds for headers plus body**, within **35 seconds overall** for coordination, supported parser interpretation and publication. HTTP only reads/reinterprets persisted raw source/outcome and retains its nine-second I/O cancellation budget; it never waits for Outlook or starts background refresh. TRMNL still polls every **15 minutes**, independently of the timer. `current` requires a matching latest completed successful check **younger than 15 minutes**, not five minutes. A failed/delayed/incomplete refresh is visibly stale only with good source **younger than one hour**; exactly one hour/no source/invalid rules is an error with null counts.

There are still only two bounded private application blobs: `last-good-source.json` (2 MiB source, 13 MiB escaped envelope) and `source-refresh-status.json` (4 KiB). Durable generations allocated before acquisition fence overlapping/equal-clock/old-source work. Required `CompletedGeneration` preserves the exact completed identity independently of newer pending allocations; current requires the full matching version-2 source identity, not a generation check disabled by pending work. Nested duplicate/unknown fields and contradictory completed/pending metadata fail closed. Pending work preserves the latest completed outcome and original timestamp; it cannot manufacture source success. At 35 seconds a pending attempt is delayed. Committing/partial or missing matching status cannot certify current. A successful supported check publishes raw source before its matching completed marker. A genuine four-field legacy source is at most stale below one hour until the new timer succeeds; a version-1 envelope carrying version-2 fields is invalid, and status missing the required completed generation is not trusted. See the [exact status schema and freshness contract](agenda-contract.md#states-and-errors).

The deployment operator needs resource-group creation, listed resource writes, budget writes, and role-assignment permission at the approved scopes, normally Contributor plus RBAC Administrator/User Access Administrator. The owner setting the secret separately needs authorized **Key Vault secret-write** access. Package retention separately needs an operator already authorized for Entra blob list/delete on the deployment container. Control-plane `*` or a successful what-if does **not** establish these data-plane rights. If absent, stop and obtain approval for the exact missing permission; these templates do not grant an operator extra roles or re-enable account keys.

## Local checks and package

Use the prerequisites, per-worktree setup, and authoritative [local validation procedure](../README.md#local-validation). Full validation is available manually and runs in PR CI; it includes delivery checks and production rendering without Azure login or private inputs. Automatic repository-managed Git hooks are retired; [explicitly migrate existing installations](../README.md#migrate-previously-installed-git-hooks). Required-check enforcement remains a separately verified GitHub setting.

```powershell
.\scripts\validate.ps1 -Scope Full
```

Full automatically includes the completion-tool tests; it does not replace the delivery contract's live Git proof.

The default deployment mode is **Build**, which only compiles Bicep into ignored `artifacts\infra\main.json`. Tooling tests compile the real template, publish the real app, and substitute only external Azure/Git commands for mutating-command checks. Refresh/HTTP tests use actual handlers, real parser/raw persistence and production client registration, including real acquisition above ten seconds with independent fast HTTP, controlled 30/35/9-second deadlines, LA cadence/DST/holidays, exact freshness/expiry, durable concurrency, partial publication and malformed status. Smoke tests retain strict serialized-size and first-red/retry behavior. Real Core Tools verifies exactly two indexed bindings and cache-only HTTP after restart; Liquid/Chromium covers all six native views. Local direct timer execution is not evidence of deployed host monitor/managed-identity coordination.

After integration review, from its clean checkout:

```powershell
$package = .\scripts\package-function.ps1 | ConvertFrom-Json
$reviewedCommit = (git rev-parse HEAD).Trim()
```

This publishes portable Release .NET 10 output with no Windows apphost, zips **contents**, including hidden `.azurefunctions`, and records the commit, checkout cleanliness, SHA-256 and archive size beside the ZIP. This SDK uses **worker indexing**, not a fabricated legacy `functions.metadata` file. `host.json` and `worker.config.json` remain at the archive root. Local settings and `.env` files are rejected, and archives over 100 MiB are rejected. A dirty package can be inspected locally but cannot be deployed with `DeployCode`.

## Protected source preflight before design approval

Run this [#11](https://github.com/geevensingh/trmnl-calendar/issues/11) preflight **after the owner has authorized access to the actual source and before accepting its acquisition strategy**. For the already approved scheduled-refresh revision, use it to check the actual source against that allowance, not to reopen permission or resource decisions. It is an owner/operator command, not a public diagnostic function or an HTTP caller-selected source feature.

Use a protected owner terminal with transcripts, shell tracing, keystroke capture and external HTTP diagnostic capture disabled. Privately obtain the **currently configured value** through the approved owner secret workflow, not an old secret version, and enter it at `source_input_required`. The command never reads the clipboard, a secret history, app settings or an owner-specific subscription/resource plan. It does not establish which value a deployed Key Vault reference currently has cached; that remains the owner's separate effective-configuration check.

From the repository root, build without fetching any calendar:

```powershell
dotnet build .\src\CalendarAgenda\CalendarAgenda.csproj --nologo --verbosity minimal
New-Item -ItemType Directory -Force .\artifacts | Out-Null
$sourceReport = Join-Path $PWD ("artifacts\source-preflight-" + [Guid]::NewGuid().ToString('N') + ".json")
```

Only when access is explicitly authorized:

```powershell
dotnet .\src\CalendarAgenda\bin\Debug\net10.0\CalendarAgenda.dll --source-preflight `
  --authorize-source-access --compare-reference --report-file $sourceReport
```

`source_input_required` and optional `reference_input_required` are fixed stderr prompt codes. Input is hidden, including when pasted; Enter submits, Backspace edits, and Escape cancels. Enter the effective source and independently known working reference exactly, without adding quotes or trimming spaces. These are single-line entries: a stored multi-line value is invalid configuration, not permission to paste separate records, silently trim it, or replace the secret. Never put either value in arguments, chat, a shell pipeline, an environment variable, a ticket or a screenshot. Omit `--compare-reference` when no protected reference is available; the report then explicitly marks comparison unperformed.

Comparison is ordinal exact equality. `same_after_trimming`, `same_uri_representation`, and the source/reference structural booleans distinguish surrounding whitespace, controls, quotes, credentials/fragments and URI representation changes without printing either value. Normalized comparisons are **diagnostic only**: a mismatch stops source acquisition, even when normalized forms match. No token is guessed, no HTML/publication link is converted into an ICS URL, and no stored secret is changed. URL validation rejects whitespace/controls, embedded credentials, fragments and non-HTTPS live inputs. Production's own fixed-source policy and no-redirect HTTP client still perform the real acquisition.

Each attempt reads at most the production **2 MiB** source limit with strict UTF-8. It uses the production **30-second combined headers/body** deadline and the same actual `Interpret` path, installed Ical.Net and maintained timezone resolver, with a **35-second overall source-check** deadline. It does not create another parser, change recurrence/timezone semantics, accept partial agendas, apply rule fallbacks, or persist a last-good source. `calendar_media_type`/`html_media_type` are booleans only; content type is not substituted for actual production interpretation.

Participation-capability evidence is a fixed, boolean-only `participation_capabilities` object on each successfully interpreted attempt. It contains no identities, event counts, response values, or calendar text:

| Observation | Meaning |
| --- | --- |
| `owner_address_configured` | An approved adapter-side identity is present as one valid `mailto:` mailbox, without whitespace/controls, query, fragment, or display name. |
| `owner_organizer_observed` / `owner_attendee_observed` | An organizer / attendee matches that exact mailbox, case-insensitively. Names, other attendees, source URLs and guessed aliases never establish identity. |
| `owner_participation_status_observed` | A matching attendee explicitly supplies a `PARTSTAT` parameter, even if its value is unsupported or the owner match is ambiguous. This is **not** the usable-response flag. |
| `owner_response_usable_observed` | At least one event has exactly one matching owner attendee supplying exactly one supported response: accepted, declined, tentative, or needs-action. A parser's default response is not supplied evidence. |
| `owner_response_missing_observed` | A matching owner attendee has no supplied `PARTSTAT`. This does not establish an unanswered invitation. |
| `owner_response_unsupported_observed` | A matching owner attendee supplies response evidence outside that supported single-value set, including delegated or extension values. |
| `owner_attendee_ambiguous_observed` | An event has multiple matching owner attendees. None of those matches establishes a usable response, even if their response values agree. |
| `free_availability_observed` / `followed_title_marker_observed` | Explicit `TRANSP:TRANSPARENT` / a `Following: ` title prefix was observed. These are candidate markers, not verification of the publication's owner-specific Free/followed semantics. |

These are independent aggregate observations: usable evidence on one event does not repair ambiguous, missing or unsupported evidence on another. With no valid owner identity, all owner-specific flags are false; with no owner match, no personal response is inferred. Overall event `STATUS`, missing metadata and another attendee's response are never personal response evidence. A false observation means only “not observed in this checked sample,” not that the publication never supplies it.

The operator supplies `Agenda__OwnerAddress` to the protected process through approved adapter configuration; the value is never prompted for, logged, or written into the report. Do not inspect secrets/settings automatically or include the identity in arguments, chat, tickets or screenshots. Failed/unsupported interpretation and acquisition failures have `participation_capabilities: null`, with their explicit phase failure/unperformed codes; partial parser observations are discarded. Authorization/input failures have no attempts. None is a successful capability check.

`measurement_scope.participation_semantics` remains `not_verified`, including on a successful acquisition/interpretation check. Production remains **Unknown-only** pending owner-authorized actual-publication evidence and its acceptance. Downstream classification must not use these synthetic observations, structural support, or `checks_passed` as that acceptance. Record only safe conclusions and limitations on [#60](https://github.com/geevensingh/trmnl-calendar/issues/60); actual-source access is currently unperformed and remains an owner gate. Do not close the ticket or clear its implementation blockers from synthetic evidence alone.

The JSON report separates acquisition (`received`, `redirect_refused`, `http_rejected`, `transport_failed`, `headers_timeout`, `body_timeout`, `source_too_large`, `invalid_utf8`) from actual interpretation (`supported`, production invalid/unsupported codes, or an interpretation timeout). HTTP status, bounded phase durations and aggregate body size are safe metadata. A received HTML page is not a supported calendar. Absent headers, unread bodies, unperformed interpretation and unrequested polling are explicit null/unperformed evidence, never assumed successes.

There is **one attempt by default**, no preliminary warmup and no automatic source retry. `--attempts 2` explicitly requests one additional measurement, retaining both in order; any failed attempt keeps the command unsuccessful. Design-budget assessments always identify **attempt 1**, so a warm second success cannot rescue its failure. A saved report is created exclusively and never overwrites an existing file; use a new report name for every later invocation and preserve the original red evidence.

| Assessment | Meaning |
| --- | --- |
| `synchronous_polling` | Observed source acquisition and interpretation must fit the existing **nine-second application budget**, inside the separate **ten-second delivery attempt**. Exceeding it cannot qualify a proposed synchronous source-fetch design. |
| `scheduled_refresh` | Observed acquisition must fit **30 seconds** and the source check must fit **35 seconds**. A source above the synchronous limit can still fit this background allowance. |
| `cache_only_poll` | Unperformed unless separately requested; assessed by the existing HTTP smoke, not inferred from source speed. |

`checks_passed` means only that every requested source check fits the background allowance and any requested polling smoke passed. It does **not** mean a delivery design was approved or activation completed; both corresponding flags remain false. Secret entry, process initialization, Azure initialization, refresh coordination/storage/publication and platform overhead are outside the measured source phases. A local source check below 35 seconds leaves persistence unmeasured, not automatically within the deployed overall refresh budget.

To assess the **independent cache-only HTTP path**, supply the nonsecret deployed endpoint obtained by the procedure below:

```powershell
$combinedReport = Join-Path $PWD ("artifacts\source-and-poll-" + [Guid]::NewGuid().ToString('N') + ".json")
dotnet .\src\CalendarAgenda\bin\Debug\net10.0\CalendarAgenda.dll --source-preflight `
  --authorize-source-access --compare-reference --agenda-endpoint $agendaEndpoint `
  --report-file $combinedReport
```

The additional `function_key_input_required` prompt reads the function-scoped key without echo. The command invokes unchanged `scripts\smoke-delivery.mjs` once, using its protected child-process environment for the key, default per-request `[]` rules, first authorized poll before auth probes, ten-second attempts, one permitted transport retry, and complete serialized polling-size check. This does not change the native rule editor or stored configuration. Only allowlisted smoke status/state/code, aggregate sizes, attempt timings and auth flags enter the combined report; response bodies, source/event dates, titles, IDs, locations, participants, rules, keys, endpoints and raw exceptions do not. The source's first failure remains red even if independent cached polling succeeds. Preflight also remains unsuccessful after any failed first polling attempt, including a transport failure or retryable HTTP rejection rescued by a later 200; both attempts remain in its report.

All source measurements are explicitly **operator-machine** evidence. They are not proof of Azure cold-start latency, host authentication, managed-identity access, actual timer coordination/persistence, native TRMNL polling or physical-device delivery. The optional deployed HTTP smoke has only its existing HTTP scope, not those remaining owner gates. No secret, app setting, cache snapshot, refresh outcome, publication permission, resource, role, polling interface or freshness threshold is changed by preflight. The current-source, deployed schedule/cache/authentication and native/device evidence below remain required.

Only synthetic tests use `--synthetic-local`, bounded redirected JSON and loopback HTTP; that mode rejects nonlocal source access. It is not a private-source input workaround. Run the synthetic command coverage through the existing test project:

```powershell
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal --filter FullyQualifiedName~SourcePreflightTests
```

## Runtime inputs and read-only preflight

Copy `infra\parameters.example.json` into ignored runtime storage, fill its empty values from the approved private plan, and protect that file. Keep `budgetAlertEmail` and `agendaOwnerAddress` runtime-only; both are secure ARM parameters at subscription and resource-module boundaries, without defaults or identity outputs. Secure ARM treatment does not encrypt this local parameter file. Missing, invalid or multi-address owner input fails before any Azure call, without printing its value. Valid `mailto:` input is validated using its complete decoded mailbox, not the empty .NET `UriComponents.Path`. Only the parameter-file reference enters Azure CLI arguments; neither owner identity nor recipient values do. The subscription is a command parameter, never a committed default.

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

Once source access and the effective configured value are confirmed, run the [protected source preflight](#protected-source-preflight-before-design-approval) before accepting an acquisition strategy or interpreting a later warm request as acceptance. Preflight is read-only; it does not authorize a secret/reference refresh or broaden Outlook publication.

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

## Coordinated Azure/TRMNL releases

`.github/workflows/coordinated-release.yml` is a separate production release controller, not a CI workflow. It scans first-parent `main` history on pushes and every 15 minutes, admits qualifying commits in order, and drains the durable queue under an Azure Blob lease. The scheduled scan recovers missed push events. Azure deploys and passes its redacted live smoke before TRMNL is updated; deployment records are created per target. Retries use the original immutable artifacts, failed releases block successors, and a skip requires an attributed manual operation. The controller never creates or deletes the resource group.

Unfamiliar paths, including unfamiliar files under `scripts/`, conservatively select both targets. Only explicitly known Azure deployment inputs are Azure-only; known local-only inputs do not select a production target.

Before enabling this workflow, the owner must complete and record the initial Azure bootstrap, TRMNL existing-plugin configuration, and private backups with explicit manual-recovery approval below. Before activation, bootstrap the release OIDC identity and a **dedicated release storage account** inside the approved group, with **both** private containers (`release-control` and `release-artifacts`) and a separate container-scoped Blob Data Contributor grant on each. Set `releaseStorageAccountName` to that account, distinct from the existing runtime `storageAccountName`; deployment scripts reject a shared account. Activation uploads retained artifacts before infrastructure reconciliation, so neither the account, artifact container nor its grant can wait for that reconciliation. Configure federation with issuer `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`, and the exact subject emitted in the workflow's Azure login diagnostics. This repository's observed `main` subject includes numeric owner/repository IDs: `repo:geevensingh@11344767/trmnl-calendar@1424811469:ref:refs/heads/main`; do not assume the shorter legacy subject matches. Grant the identity only the resource-group deployment permissions required to reconcile the already-existing approved group, including its required role-assignment permissions; Bicep maintains its separate ledger-container and release-artifact-container grants. The function deployment-package container is not the retained-release-artifact container. Do not grant subscription-wide Contributor for routine releases.

The owner has accepted retaining resource-group-scoped Contributor for this setup. That role can delete the resource group: the controller's refusal to create/delete the group is an application boundary, not an effective RBAC denial. Keep the separately constrained role-assignment delegation and container-only data grants; this exception does not authorize subscription-wide permissions or grant either runtime identity release-storage access.

The host identity keeps its required account-wide Blob Data Owner role only on the runtime account. Neither Function identity is granted data or control-plane access to the release account. During bootstrap, inspect effective/inherited permissions and verify both runtime identities cannot read or mutate either release container; remove conflicting inherited grants under owner authorization before activation. Keep shared-key/public access disabled and do not attach the release identity to the Function. Existing activated installations need an owner-reviewed ledger/artifact migration before changing accounts; never point an active controller at an empty account or reactivate to bypass its history. No live migration or account provisioning was performed during implementation.

Routine releases compare live capacity against the `reviewedFunctionCapacity` value used by the exact commit's Bicep and returned as `reviewedCapacity` by its reconciled deployment stack. This supports reviewed maximum-instance, memory and always-ready changes without a second approval or changing resource-group, runtime, artifact, authentication, and commit checks. The standalone operator command above retains its initial max-one/2 GiB/zero-always-ready defaults unless supplied with a commit-matching `-ReviewedCapacityJson` result from reconciliation.

Before any TRMNL push, the publisher pulls the existing non-secret definition and compares custom-field identifiers and types. Removing, renaming or changing a deployed field type fails with `trmnl_field_migration_required` before mutation. There is no implicit migration or configured-value reset: retain the existing schema until an explicit owner-reviewed value-preserving migration has been implemented. Post-push verification pulls into an empty source directory and compares templates and parsed settings, ignoring mapping-key order but preserving array order.

Before approving TRMNL publication, export the existing production plugin and accept manual recovery if publication resets its settings. Keep the export private and separately save the currently configured endpoint, function key, and exact exclusion-rule text: do not assume the export includes password-style values. This is a recovery plan, not proof of preservation or an automatic rollback. Only after saving those backups, set `TRMNL_BACKUP_RECOVERY_ACCEPTED_PLUGIN_ID` to the same existing production plugin ID and describe the acceptance in the attributed activation reason. Both activation and routine publication require this plugin-specific approval. Definition/template verification does not verify configured-value preservation.

Ruby settings parsers receive only allowlisted non-secret tool environment settings, not Azure configuration, GitHub tokens, Function keys or the TRMNL publishing key. Only the isolated `trmnlp` calls receive that publishing key.

Retained TRMNL archives are restored using a destination-local temporary input, removed before publication. This avoids GNU tar unquoting Windows directory arguments or treating drive-qualified archive names as remote.

Set these GitHub repository variables:

| Variable | Value |
|---|---|
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Federated release identity client ID, tenant ID, and approved subscription ID. |
| `AZURE_RESOURCE_GROUP_NAME` | The owner-approved, pre-existing application resource group. |
| `AZURE_STORAGE_ACCOUNT`, `AZURE_RELEASE_CONTAINER`, `AZURE_ARTIFACT_CONTAINER` | The **dedicated release** account matching `releaseStorageAccountName`, private `release-control` ledger container, and private `release-artifacts` retained artifact container. Never use the runtime `storageAccountName`. The release identity has separate container-scoped Blob Data Contributor roles. |
| `AZURE_BOOTSTRAP_VERIFIED` | Set to `true` only after the owner verifies the separate Azure bootstrap and required live evidence. |
| `TRMNL_PLUGIN_ID` | The existing production plugin ID; never leave this blank or allow `trmnlp` to create a plugin. |
| `TRMNL_BACKUP_RECOVERY_ACCEPTED_PLUGIN_ID` | The same existing plugin ID only after the owner privately saves the export and configured values and accepts manual recovery. This is not a verified-preservation claim. |

Set these GitHub Actions secrets:

| Secret | Value |
|---|---|
| `AZURE_PARAMETERS_JSON` | The complete owner-reviewed deployment parameter document based on `infra/parameters.example.json`, including the exact resource group and release identity **service-principal object ID**. Keep the document private; the runner writes it to a mode-restricted temporary file and removes it after use. |
| `TRMNL_API_KEY` | The TRMNL publishing key. It is passed only to the isolated `trmnlp` process. |
| `TRMNL_FUNCTION_KEY` | The dedicated function-scoped key for the existing `/api/agenda` trigger, never a host/master key. |

The first manual `activate` operation on `main` publishes and verifies both targets at the selected reviewed main commit before recording target baselines. It requires verified Azure bootstrap, matching plugin-specific backup approval, and an attributed reason. It does not create the private backups or establish missing live evidence on the owner's behalf. Activation records `trmnl_backup_recovery_accepted: true` alongside the actor/reason; status exposes that acceptance without private configuration. Legacy activation records without recorded acceptance report null, not inferred approval.

If activation fails, rerun `activate` on `main` with a new attributed reason. Recovery resumes the ledger's original activation commit and retained artifacts, even if `main` has advanced; verified targets are not redeployed. The current-main restriction applies only to a new activation. An interrupted activation is first recorded as uncertain and blocked before a later explicit recovery can resume it. Its original `first_failure` remains in the durable record after successful recovery. An invalid retained TRMNL description instead needs the explicit [description-repair operation](#correcting-a-failed-initial-trmnl-description) below; changing source alone cannot fix that archive.

Use **Actions > Coordinated production release > Run workflow** on `main` for `status`, `activate`, `retry`, or `skip`. Supply a concise reason for activation/retry/skip. A retry reuses the original commit and artifacts and preserves durably verified target outcomes, including interruptions immediately after a target-success save. A skip records the actor and reason without advancing either target baseline. `main` is the normal automatic operation. Never manually edit the Blob ledger or delete retained release artifacts to clear a barrier. Keep GitHub deployment permissions enabled for the workflow; do not add CI checks or rerun unrelated CI as part of release recovery.

For a TRMNL failure, run `inspect-trmnl` on the same manual workflow before retrying publication. It pulls the existing production plugin once, compares its non-secret definition/templates with the blocked activation/release commit (or the dispatch commit when nothing is blocked), and reports boolean readability, field-schema compatibility and content equality plus the bounded comparison below. A pinned activation repair, including an older queued release whose TRMNL target it covers, compares against the corrected source instead. It never pushes, creates a deployment record, writes the ledger, clears a recovery barrier, or implies that configured values were preserved. Inspection needs the existing publishing key but not backup approval because it makes no plugin changes.

Inspection adds `content_comparison` without changing the existing result fields.
It reports `file_set_matches` and one fixed result for each of `settings.yml`,
`shared.liquid`, `full.liquid`, `half_horizontal.liquid`, and `half_vertical.liquid`.
Results are `match`, `different`, `source_missing`, `deployed_missing`, or
`not_compared`. Templates remain byte-exact; settings retain the existing parsed
comparison (mapping order and the top-level plugin ID are ignored, arrays remain
ordered). No new normalization or ignored remote field is introduced.

When file sets match, `definition.fields` lists only differing **allowlisted
top-level definition fields** with `source_missing`, `deployed_missing`,
`type_mismatch`, or `value_mismatch`. Custom-field differences are reported only
as `custom_fields`, never as configured field identifiers or nested paths.
Each differing field also has `source_type` and `deployed_type`: exactly
`missing`, `null`, `string`, `object`, `array`, `boolean`, or `number`.
`source_empty` and `deployed_empty` are booleans only for strings/arrays/objects
(zero characters/elements/keys); they are null for the other types. Whitespace
strings are nonempty. These are structural signals, not values or lengths:
null/missing polling configuration is distinct from an empty object, and neither
is presumed equivalent to the intended string.
The comparison-only name allowlist additionally recognizes `static_data`,
`serverless_language` and the OAuth setting identifiers in the cited schema
below. Identifying a name does **not** make it ignored, harmless metadata, or
an accepted default; its presence, type and content remain compared exactly.
Unknown definition fields and files remain part of exact verification, but only
their source/deployed counts and aggregate equality booleans are exposed.
When file sets differ, definition comparison is explicitly unevaluated:
`definition.compared` is false and `definition.unknown_fields` is null, not an
invented match. The output contains no remote values, templates, configured-field
names, arbitrary filenames/keys, credential-derived hashes, URLs or response
bodies. A publishing verification mismatch emits the same bounded structure as
`trmnl_content_comparison` at `stage: verify` before returning its unchanged
file-set/content-mismatch failure code.

A mismatch signal identifies **where**, not why, content differs. It does not
establish harmless service normalization, unchanged plugin bytes, rollback,
configured-value preservation or a verified target. Read the bounded evidence
before choosing a fix; do not strip unknown remote fields or retry blindly.
Read-only inspection does not retarget a pinned repair source/archive or clear
its mutation-confirmation barrier.

#### Definition representation evidence (2026-10-31)

The pinned publisher is [`trmnl_preview` 0.32.3 / tag v0.32.3](https://github.com/usetrmnl/trmnlp/tree/a7a813bc46358adf5b53e06004d6ab337e51d5a3).
The following distinguishes documented/source behavior from observed cloud
behavior; none permits coercing missing data into a verified target.

| Claim | Status and primary evidence | Remaining limitation |
|---|---|---|
| Pinned CLI pull converts archive setting types | **Unsupported**: [`Pull#call`](https://github.com/usetrmnl/trmnlp/blob/a7a813bc46358adf5b53e06004d6ab337e51d5a3/lib/trmnlp/commands/pull.rb) extracts ZIP entries unchanged. | The hosted archive serializer is a separate component. |
| Polling headers/body are intended as strings | **Supported** by the pinned [`Plugin` readers](https://github.com/usetrmnl/trmnlp/blob/a7a813bc46358adf5b53e06004d6ab337e51d5a3/lib/trmnlp/config/plugin.rb), [header tests](https://github.com/usetrmnl/trmnlp/blob/a7a813bc46358adf5b53e06004d6ab337e51d5a3/spec/lib/trmnlp/config/plugin_spec.rb) and [scaffold](https://github.com/usetrmnl/trmnlp/blob/a7a813bc46358adf5b53e06004d6ab337e51d5a3/templates/init/src/settings.yml). JSON-object header syntax there is still a **string**, parsed after Liquid rendering. | This does not show what types the failed cloud export contains. |
| Additional static/serverless/OAuth setting names exist | **Supported** by the first-party [`Terminus` import schema at df71a84](https://github.com/usetrmnl/terminus/blob/df71a84e1a59e428b5f72ff4dd310265e1950469/app/aspects/extensions/importers/remote/schema.rb), plus pinned `Plugin` readers for static/serverless. These names are diagnostic identifiers only. | Terminus is another server, not proof of cloud exporter defaults or inert metadata. |
| Cloud non-string polling values and five extra fields are equivalent to this source | **Unknown**. The first-party [API index](https://github.com/usetrmnl/api-docs/blob/70480dc83430adcf36e868d6fdde7cde94a8d97a/private-api/more-endpoints.md) points to the hosted OpenAPI, which was inaccessible from this investigation environment. | Run read-only inspection against the same pinned source to obtain the fixed type/emptiness/known-name evidence. Any remaining arbitrary names stay hidden and unverified, not silently stripped. |

Synthetic pinned-CLI loopback execution can establish unchanged archive
round-tripping and correct diagnostic signals for deliberately injected
representations. It cannot establish the production export's types or prove
that a cloud import preserved the required polling headers/body. In particular,
null headers/body may indicate lost configuration rather than serialization
noise; a mismatch remains a blocking failure.

Publisher failures identify `source_settings`, `preflight_pull`, `preflight_settings`, `push`, `verify_pull`, or `verify_settings` rather than collapsing every tool error into `trmnl_publish_or_verify_failed`. Archive API failures include only an allowlisted HTTP status, such as `trmnl_preflight_pull_http_403`; absent tools, cancellation, timeouts and output limits have fixed codes. Tool output is captured in bounded memory only, never printed or retained as an artifact. Private settings, archive contents, credentials and response bodies stay out of logs. A push or post-push failure still requires stopped-mutation verification before recovery; a diagnostic code is not proof of rollback.

For HTTP 422, the runner also emits a `trmnl_archive_validation` event containing only allowlisted definition-field names and fixed reason codes, such as `description` / `too_long`. It recognizes bounded structured validation errors, not arbitrary response text. Reasons match only normalized validation prefixes, never words inside echoed values. Ambiguous comma-, semicolon- or newline-joined messages are left unclassified instead of inferring additional errors. Unknown fields, echoed values, limits, URLs and messages are never printed; unrecognized responses explicitly report `classified: false`. This event comes from the upload response, not an assumed TRMNL dashboard log location. It does not change publication, verification or recovery behavior.

Status also exposes per-target `pending_reconciliation`. A target is marked before mutation and cleared only after verification. Skipping a failed release preserves this marker: the next qualifying commit must redeploy that target even if its contents match the last successful baseline, because the skipped attempt might have changed what is live.

Lease-renewal failure cancels active local commands and prevents subsequent deployment stages or ledger writes by that controller. Cancellation is not proof that descendants or an already accepted Azure/TRMNL request have stopped. Before every external mutation, the ledger records `recovery_confirmation_required`; an unverified failure or interruption leaves that barrier in place. To retry, skip, or resume activation after a mutation failure, first verify that the previous runner processes (including descendants) have ended and that all Azure deployment-stack/code deployments or TRMNL publishing requests have completed or been stopped. Do not merely break the lease or cancel a GitHub run and assume remote work stopped.

Only after that verification, select **I verified all previous release processes and remote mutations have stopped** in the manual workflow and provide the evidence/context in the attributed reason. The controller records this confirmation with the actor and time before allowing recovery. The equivalent CLI switch is `--previous-mutation-stopped`. Status exposes the barrier; automatic scans cannot clear it. Selection/preparation failures before any mutation can be retried without this confirmation.

### Correcting a failed initial TRMNL description

`repair-activation-trmnl` is a narrow exception for an **inactive initial activation**
whose Azure target is already verified and whose TRMNL push failed with HTTP 422.
It is not a queue retry, rollback, general artifact replacement, or a new Azure
deployment. Ordinary `activate` and queue retries still use their original
archives; once repair is pinned, only the explicit repair operation can resume it.

The confirmed production failure for [#41](https://github.com/geevensingh/trmnl-calendar/issues/41#issuecomment-6533367465)
identified `description` / `too_long`. The source description is now
`Private calendar agenda.` No numerical service limit is assumed or enforced;
successful local checks do not prove the service will accept a future upload.

After human review/merge and required CI, use **Coordinated production release**
on `main` with:

| Input | Required evidence |
|---|---|
| `operation` | `repair-activation-trmnl` |
| `activation_commit` | Full original failed activation SHA, matching the ledger. For #41 this is `8c3e5702f7b657f363c82acd124dd973cb7545bb`. |
| `corrected_commit` | Full reviewed, human-landed current-main SHA on the **first** repair. Reuse this exact SHA on subsequent repair attempts, even if main advances. |
| `reason` | Attributed non-secret correction rationale and evidence that earlier processes/remote mutations stopped. |
| `previous_mutation_stopped` | `true`, only after the stopped-mutation checks above. This is required on every repair invocation. |

Azure bootstrap evidence and the existing plugin-specific private-backup/manual
recovery approval remain required. Do not supply private values in the reason.
This operation does not establish configured-value preservation or remove the
accepted settings-reset/manual-recovery risk.

The corrected source must be on the original activation's first-parent main
history. Its settings, compared with the **retained original archive**, may change
only the single top-level description, which must be nonblank and shorter.
Changes to the shared agenda contract documents/parser are rejected. The archive
contains the corrected commit's complete `display/src`, including any intervening
reviewed template/style changes; review their compatibility with the still-old
Azure target before landing. Field-schema preflight and post-push definition/
template verification remain mandatory.

Under the existing lease and conditional ledger writes, repair verifies the
original artifacts and retains them unchanged. It creates a separate immutable,
digest-addressed **TRMNL-only** archive bound to the corrected source SHA, persists
that identity before publishing, and records each repair's actor, reason,
stopped-mutation confirmation and outcome. Original `first_failure` and the
pre-repair failure remain available. Status shows both source/artifact identities
and safe attempt outcomes, not freeform reasons or archive contents. Mismatched
activation/source/artifact identities, missing evidence, initialized queues and
unverified Azure targets fail closed.

An interruption is first recorded as `interrupted_uncertain` and blocks the
invocation. Inspect status and re-establish stopped-mutation evidence before
resuming the **same operation and SHAs**. Once persisted, the corrected artifact
is reused, never silently rebuilt from newer main; durably verified Azure/TRMNL
outcomes are not repeated. A preparation interrupted before its artifact identity
was persisted may prepare that same pinned source again.
If the final initialization write fails, the failure record keeps activation
inactive with checkpoint/baselines unset and retains all durably verified target
outcomes. Resuming the same operation completes initialization without repeating
those target mutations.

Successful repair sets Azure's baseline to the original activation and TRMNL's to
the corrected source. The admission checkpoint stays at the **original activation**:
it does not declare the newer whole commit deployed. Subsequent normal `main`
scans retain every qualifying successor in FIFO order and reconcile outstanding
Azure changes. Older TRMNL targets already represented by the repaired archive
are recorded as `covered_targets` with its source and artifact identity, not as
independently verified uploads; they must not republish the invalid older
description. Releases after the corrected source use normal target selection.
Repair does not automatically drain this Azure backlog.

### Azure release operator

When direct Azure access is unavailable, use **Actions > Azure release operator** on `main`, or `gh workflow run release-azure-operator.yml --ref main -f operation=inspect`. This manual-only workflow uses the existing release OIDC identity and the same concurrency group as production releases. It needs no new identity, secret, or permission grant. Inspection makes no Azure writes and reports the deployment-stack state, whether group deployments have stopped, a boolean budget-email check, and the two release containers' relevant assignment IDs. It never prints parameters, email addresses, principal IDs, keys, or raw Azure diagnostics. A failed command reports its stage and an allowlisted Azure error code instead of an unhelpful generic error.

Portal-created bootstrap grants can have different IDs from the exact assignment resources requested by Bicep, causing `RoleAssignmentExists` even when the principal/role/scope are correct. After inspecting current state and obtaining explicit owner approval, `repair-bootstrap-roles` accepts the old and requested GUIDs for **each** release container, an attributed `reason`, and `previous_mutation_stopped=true`. These inputs identify the two approved replacements; they do not permit arbitrary scopes, roles, or principals. Both grants must pass preflight before any write, and requested IDs must match the latest failed deployment's role-assignment operations, including individually succeeded operations after partial repair. The script checks subscription and protected target bindings, exact container scopes, release principal, Blob Data Contributor role, unconditional grants, and stopped deployments. A missing stack is reported as absent rather than treated as a failed `show` command; unknown or running work blocks repair.

Repair replaces only those two assignment IDs at unchanged permission scopes. An already-aligned grant is left alone. There is a brief per-container access gap; a failed delete/create is reconciled against actual grants, and the original assignment is restored when necessary. Post-mutation reads get one bounded retry; if reconciliation stays unavailable, the original exact grant is still attempted before verifying which approved ID exists. Restoration is read back, not presumed; any unverified post-mutation result reports `operator_repair_state_uncertain` and blocks the next container. Recheck with `inspect` after a repair. Neither operation deploys application code, publishes TRMNL, modifies storage contents or the release ledger, clears a failure barrier, or authorizes activation recovery. Keep the private backups and original activation/artifacts; recovery remains the separate attributed `activate` operation described above.

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

The CLI measures the **whole parsed/re-serialized native single-URL polling object in UTF-8**, not event counts, selected fields, `Content-Length`, or a webhook envelope. Exactly **100,000 bytes fails**, 99,999 passes; the adapter's 95,000-byte bound leaves margin. The adapter reserves metadata and emphasized occurrences before ordinary rows, retaining complete eligible totals and chronological output so omission counts remain truthful. It never shortens titles to fit; only an unrepresentable required metadata envelope returns `agenda_too_large`. Current consumers accept ordinary schema 1 and schema 2 (including emphasis); old strict schema-1 readers must be upgraded with the schema-2 producer.

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

### Operator cache read access

An owner may authorize the signed-in operator to read the private source cache for diagnosis, including through a Copilot session. This is an explicit exception to keeping meeting titles/locations out of agent context, not permission to expose credentials, retrieve the Key Vault source secret, save raw calendar bodies, use private preview tooling, or publish calendar data in GitHub artifacts. The grant belongs to the Azure principal, not exclusively to Copilot; other processes authenticated as that user also gain this read access. Existing control-plane Contributor/Owner does not by itself establish Blob data-plane permission.

After explicit approval of the principal, role, and container scope, use the approved resource-plan values for `$subscriptionId`, `$approvedResourceGroup`, `$approvedStorageAccount`, and `$approvedCacheContainer` (normally `source-cache`). Do not substitute account/resource-group/subscription-wide scope:

```powershell
$operatorObjectId = az ad signed-in-user show --query id --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$operatorObjectId) { throw 'The signed-in operator could not be identified.' }
$storageAccountId = az storage account show --subscription $subscriptionId `
  --resource-group $approvedResourceGroup --name $approvedStorageAccount `
  --query id --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$storageAccountId) { throw 'The approved storage account could not be identified.' }
$cacheScope = "$storageAccountId/blobServices/default/containers/$approvedCacheContainer"
az role assignment create --subscription $subscriptionId `
  --assignee-object-id $operatorObjectId --assignee-principal-type User `
  --role 2a2b9908-6ea1-4ae2-8e65-a410df84e7d1 --scope $cacheScope `
  --query '{principalType:principalType,roleDefinitionId:roleDefinitionId,scope:scope}' `
  --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'The approved cache-reader assignment failed.' }
```

The role is **Storage Blob Data Reader**, with no calendar writes, account keys, container creation, or access to other containers. Allow RBAC propagation, then verify using metadata without displaying/saving source contents:

```powershell
az storage blob show --subscription $subscriptionId --account-name $approvedStorageAccount `
  --container-name $approvedCacheContainer --name last-good-source.json --auth-mode login `
  --query '{lastModified:properties.lastModified,sizeBytes:properties.contentLength}' `
  --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Cache read access is not yet verified.' }
```

Do not follow account-key fallback suggestions on a denied read. A different signed-in principal needs its own owner-approved grant. The existing application managed identities and roles are unchanged.

### Package retention

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

### Calendar-aware Azure telemetry

Meeting titles and locations are authorized in private, RBAC-controlled Azure logs and owner-approved Copilot investigations. Reading these fields in Copilot brings them into the conversation, so storage inside the Azure subscription is not a promise that queried data never leaves Azure. Keep source URLs, keys, raw ICS, raw source IDs, rule text, excluded/ended meetings, descriptions, attendees, request/response bodies, and upstream exception text out of telemetry and GitHub artifacts. Private calendar content remains prohibited in local preview/screenshot tooling.

`host.json` permits information-level Agenda poll/occurrence records, fixed Agenda warning codes, fixed RefreshSource outcome/failure codes, and host aggregate metrics. The refresh's `Agenda refresh finished with code source_checked.` means supported source processing finished, not that an obsolete attempt replaced newer state; `refresh_superseded` means older-dated work was rejected before acquisition. Matching completed persisted outcome plus HTTP are authoritative. Automatic **dependency URL** capture, HTTP extended collection, raw invocation/default categories, live metrics, performance counters, snapshots, and file logging remain disabled. Adaptive sampling retains its one-item/second target for other telemetry but explicitly excludes **Trace**, so meeting records emitted together are not sampled away. Production HttpClient loggers and cache SDK URL/content/tracing diagnostics remain disabled. No worker Application Insights SDK/auto-instrumentation is added.

Each current/stale poll logs `Agenda poll ` plus a JSON summary and `Agenda occurrence ` plus JSON for each returned day/occurrence after response bounding. A fresh opaque `poll_id` correlates them. The [exact diagnostic fields](agenda-contract.md#private-diagnostics) include original source freshness, timing, opaque occurrence IDs, title, nullable location, and explicit truncation flags. Titles/locations are capped at 1,024 UTF-16 code units without splitting a surrogate pair; diagnostic truncation does not shorten HTTP fields. JSON escaping keeps records single-line and below 14 KiB per occurrence even at maximum escaping. Summary eligible totals remain complete; occurrences omitted by the response budget have no meeting records. Errors log only fixed codes. Responses with no supplied occurrences log a summary only, including bounded agendas with nonzero eligible totals.

These are **eligible agenda** diagnostics, not rendered-device capture: locations may still be omitted by adaptive fitting, and an offline device may retain an older image. A selected poll's eligible totals and record counts distinguish a missing location in the API data from presentation fitting. Use the visible source timestamp, approximate observation time/timezone, and device/layout to select the relevant poll.

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

The host can omit structured logger properties, so query the JSON in **Message**, not assumed custom dimensions. First select a recent poll:

```kusto
AppTraces
| where TimeGenerated >= ago(1d)
| where Message startswith "Agenda poll "
| extend Poll = parse_json(substring(Message, strlen("Agenda poll ")))
| project TimeGenerated, PollId=tostring(Poll.poll_id), State=tostring(Poll.state),
    GeneratedAt=todatetime(Poll.generated_at), SourceSucceededAt=todatetime(Poll.source_succeeded_at),
    PrimaryDate=tostring(Poll.primary_date), PrimaryTotal=toint(Poll.primary_eligible_total),
    SecondaryDate=tostring(Poll.secondary_date), SecondaryTotal=toint(Poll.secondary_eligible_total)
| order by TimeGenerated desc
| take 20
```

Then inspect only that poll's meeting fields:

```kusto
AppTraces
| where TimeGenerated >= ago(1d)
| where Message startswith "Agenda occurrence "
| extend Meeting = parse_json(substring(Message, strlen("Agenda occurrence ")))
| where tostring(Meeting.poll_id) == "<selected-poll-id>"
| project Date=tostring(Meeting.date), OccurrenceId=tostring(Meeting.occurrence_id),
    TimeKind=tostring(Meeting.time_kind), Start=tostring(Meeting.start),
    EndExclusive=tostring(Meeting.end_exclusive), Title=tostring(Meeting.title),
    Location=tostring(Meeting.location), HasLocation=isnotempty(tostring(Meeting.location)),
    TitleTruncated=tobool(Meeting.title_truncated), LocationTruncated=tobool(Meeting.location_truncated)
| order by Date asc, Start asc, OccurrenceId asc
```

Unexpected automatic capture is a stop condition, not permission to dump URLs or raw exceptions into artifacts. Verify 30-day workspace retention and the 0.1 GB/day cap in Azure, and review ingestion volume after enabling meeting traces. Allowed categories, bounded records, and retention are the primary controls for unsampled traces; ingestion caps can overshoot, suppress useful diagnostics when reached, and are **not** hard spending limits. Count per-day records against the selected poll's eligible totals before treating a missing record as evidence that a meeting was absent. Live ingestion is best-effort; do not infer a healthy/empty agenda from missing telemetry. Leave host-managed diagnostic tables/state to the host's own rotation, not generic cleanup.

The reader grant can take effect independently, but calendar-aware logging requires a reviewed code deployment. Verify a natural current/stale poll emits a parseable summary and matching occurrence counts in Azure, including one nullable location, without unexpected automatic categories. Local handler/host-configuration checks do not prove deployed ingestion; keep this gate pending until the approved code is landed and deployed.

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
| Entra telemetry ingestion, correlated title/location records, and absence of automatic URL/credential/body capture | **Calendar-aware logging requires reviewed deployment and live verification** |
| Owner's physical OG/X, required placements, visible source timestamp and subsequent refresh/settings change | **Not observed**; no private screenshots |
| Actual operating cost/ingestion and budget notification configuration | **Not observed**; estimates are not bills |

For measured HTTP evidence, record UTC time, reviewed commit/deployment ID, expected/result state and safe code, per-attempt milliseconds, serialized byte count, and source-success time. Keep private bodies, calendar text, source URLs, keys and recipient/owner identifiers out of the record. Stop on any missing gate or measured incompatibility; do not close tickets based on local success.
