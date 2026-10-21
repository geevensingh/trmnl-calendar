# TRMNL Calendar

The agenda slices for [#3](https://github.com/geevensingh/trmnl-calendar/issues/3) and [#4](https://github.com/geevensingh/trmnl-calendar/issues/4), native configurable title exclusions from [#5](https://github.com/geevensingh/trmnl-calendar/issues/5), adaptive production views from [#6](https://github.com/geevensingh/trmnl-calendar/issues/6), persistent stale-source fallback from [#7](https://github.com/geevensingh/trmnl-calendar/issues/7), and secure delivery tooling for [#8](https://github.com/geevensingh/trmnl-calendar/issues/8), under [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2). Delivery tooling is not a claim of live activation.

The production path is a .NET 10 isolated Azure Function app, stable Ical.Net **5.2.3**, and a private TRMNL plugin. One internal timer refreshes the fixed configured source. The function-authenticated HTTP poll only reads persisted source/outcome and reevaluates the current exclusions, clock, timed/all-day occurrences, and two-working-day agenda in `America/Los_Angeles`; it neither fetches Outlook nor starts background work. OG and X support full-screen, half-horizontal, and half-vertical placements through the actual `trmnl-liquid` environment and pinned TRMNL framework **3.4.3**.

Timezone rules are pinned to NodaTime **3.3.5**, including its embedded **TZDB 2026e**. Ical's default resolver remains first; previously unmapped Windows IDs use TimeZoneConverter **8.0.0**'s exact territory-`001` Windows-to-IANA mapping and the same NodaTime provider. The resolver is installed once per process, including direct HTTP hosting, without source-derived global mappings, runtime downloads, host Windows/ICU conversion, or fixed-offset aliases. Public 2026 IDs such as `British Columbia Standard Time`, `Alberta Standard Time`, and `Manitoba Standard Time` therefore use their maintained Vancouver/Edmonton/Winnipeg rules, not superseded seasonal Windows rules. Unknown/floating identifiers and unrecognized custom `VTIMEZONE` definitions remain explicit compatibility errors.

Recurring series use the installed stable library's `RRULE`, `RDATE`, and `EXDATE` evaluation before selection and counting. Timed and date-only occurrence streams are bounded separately before selection, so an out-of-window all-day occurrence cannot hide an eligible evening meeting. Both retain the complete calendar's override metadata for the library's replacement logic. Moved instances replace their originals; cancelled overrides, including those without their own start/end, suppress originals without appearing themselves. Cancelling a series also suppresses its overrides. All-day ranges retain date-only, exclusive ends and render as **All day**, not midnight meetings. Windows timezone aliases use the library's actual resolver, including Los Angeles daylight-saving changes.

An attached all-day change may use a known, nonfloating DATE-TIME `RECURRENCE-ID` at exact literal wall midnight when its series start and complete actual override are DATE-only. The override must supply an end or duration; a cancellation with no start, end, or duration is also supported on that known series. Its identifier and timezone metadata remain untouched for the library's wall-date replacement, not converted through UTC or coerced to DATE. Nonmidnight identifiers (even UTC-equivalent local midnight), unknown/floating zones, timed actual overrides, and changes with their own recurrence sets remain errors. Other date-kind mismatches and the detached requirements below are not relaxed.

Published snapshots can contain detached `RECURRENCE-ID` records without a series definition. These are supported only as individually supplied occurrences with an explicit start and end or duration, a matching identifier date kind, and no recurrence set or range of their own. Stable 5.2.3 evaluates their actual `DTSTART`, not the identifier's original time; the adapter neither invents a master nor expands unseen instances. Complete cancelled detached records are omitted, while duplicate occurrence identities remain whole-source errors, including equivalent UTC/Windows-zone identifiers. Active detached records sharing a UID and actual start are also rejected rather than collapsed or returned with duplicate display IDs. Incomplete detached records, including start-less cancellations, are not guessed; attached cancellation behavior above is unchanged.

The native code-style rule editor starts with whole-word OOF/OOO and starts-with working from/`Following: ` exclusions. An edit changes the next poll without adapter redeployment. A deliberate `[]` disables exclusions; missing, malformed, or unsupported configuration shows a visible error, never defaults, old rules, or an unfiltered fallback.

Parsed `RECURRENCE-ID;RANGE=THISANDFUTURE`, other recurrence ranges, deprecated `EXRULE`, detached records with their own recurrence sets or incomplete timing, floating times, unsupported timezones, and invalid sources fail the whole source check rather than producing partial success. The stable occurrence engine does not cascade ranged edits; serializer support does not establish evaluation support. Unproductive recurrence evaluation is bounded and returns a compatibility error. Such failures may use a recent, visibly stale last-good source, but never replace it or renew its timestamp. Private-feed compatibility and Azure/TRMNL activation remain [#8](https://github.com/geevensingh/trmnl-calendar/issues/8).

## Persistent source and freshness

`RefreshSource` uses the stable isolated Timer extension **4.3.1**, UTC NCRONTAB `0 */5 * * * *`, persisted schedule monitoring, and **no startup invocation**. Its internal gate uses the scheduled tick (or the injected clock for direct execution) and the pinned `America/Los_Angeles` timezone: Monday-Friday **09:00 inclusive to 18:00 exclusive** checks every five minutes, with checks only at minutes **00/15/30/45** otherwise. DST is honored and weekday holidays remain weekdays. Linux Flex does not support `WEBSITE_TIME_ZONE`/`TZ`; neither is used. Eventual window customization is a future preference, not a new plugin setting or runtime configuration in this revision.

The cache retains the last successfully fetched **and interpreted source within supported calendar semantics**, not filtered agenda rows or rendered output. Every HTTP poll runs that source through the same real calendar/rule logic with the current request's rules, current Los Angeles working dates, and current ended-event cutoff. Edited rules and Friday-to-Saturday rollover therefore take effect without fetching again, including during an outage. Missing or invalid rules return a configuration error before reading or using cached data.

`current` means the latest **completed** refresh succeeded, its outcome matches the retained source, and source-success age is **strictly less than 15 minutes**, even during the faster business-hours cadence. It no longer means this HTTP request fetched Outlook. A failed latest refresh or delayed refresh is visibly `stale` only while matching supported source is **strictly less than one hour old**, retaining its **original** source-success date/time. At exactly one hour or later, without good source, or with a future-dated snapshot, the result is an error with null counts/no events, never a healthy empty day. HTTP polls, reads, rule edits and renders cannot renew source success.

Production overwrites exactly two blobs in the **private, pre-existing container**: `last-good-source.json` (2 MiB source; 13 MiB escaped envelope) and `source-refresh-status.json` (at most 4 KiB). The raw envelope is source-URL-digest-bound and carries actual source-success time, refresh ID/start and generation. Status contains only the digest, IDs/generations, times, a fixed error category/numeric fixed-message detail, and nullable pending-attempt metadata; never source content, titles, rules, URLs, keys or upstream exception messages. Its required `CompletedGeneration` retains the completed identity while `Generation` tracks newer admissions. Current always requires a version-2 source matching the completed source key, refresh ID/start, success time and completed generation, even during pending work. Nested duplicate/unknown fields and contradictory pending/completed metadata are storage errors; legacy version 1 accepts only its original four source fields and can never certify current. A small status-blob lease serializes durable generation allocation and publication. Generations, not wall-clock ties, fence older work across source changes and worker recreation.

An in-flight attempt does not change the last completed outcome or original timestamp: an already-valid recent completed success can remain current. An uncompleted attempt at **35 seconds**, a committing/partially published pair, or missing matching outcome cannot certify current. Usable source remains visibly stale only below one hour; corrupt/unsafe storage envelopes are explicit errors. Publication marks the pair incomplete before replacing source and only certifies success after persistence. Failed source checks never replace raw source. Legacy source envelopes without scheduled outcome can only be stale below one hour, not current, until a supported scheduled check completes. A worker restart does not erase either blob.

Configure these **Azure runtime settings**, not TRMNL settings or HTTP inputs:

| Setting | Value |
|---|---|
| `Agenda__CacheServiceUri` | The HTTPS blob service URI of the reused Functions StorageV2 account, e.g. `https://<account>.blob.core.windows.net`. No credentials, SAS/query string, or container path. |
| `Agenda__CacheContainer` | The name of the private cache container created during activation. |

The cache explicitly uses the Function app's **system-assigned managed identity**. Grant that identity **Storage Blob Data Contributor at the cache container's scope only**, `/subscriptions/<subscription>/resourceGroups/<group>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>`. The adapter reads and conditionally overwrites its blob; it does not create containers, request account keys, or require account/resource-group/subscription-wide Contributor access. Do not enable anonymous container/blob access or configure storage credentials. The Functions host's separate user-assigned storage identity and its settings do not select the cache identity.

Missing/unsafe storage configuration, unavailable storage, or an unusable stored envelope produce bounded `cache_configuration`, `cache_unavailable`, or `cache_invalid` errors. Only known matching persisted source can supply a source-success timestamp to HTTP. SDK URL/content diagnostics and retries remain disabled, with the existing two-second SDK network timeout. Refresh acquisition has **30 seconds for headers and body together**, inside **35 seconds overall**, including coordination, supported interpretation and persistence; storage does not receive a reset budget. The cache-only HTTP path keeps its **nine-second I/O cancellation budget**, and delivery tooling keeps **ten seconds per attempt and at most one transport retry**. None guarantees ten-second cold end-to-end delivery: platform initialization and delivery overhead still need deployed measurement. Keep retained storage versions and telemetry growth bounded.

Native polling remains **15 minutes**, independently of internal source refresh. Neither cadence is an end-to-end freshness guarantee: Outlook publication, timer delays and device refresh add delay, and a source can still exceed 30 seconds. An unreachable adapter or offline TRMNL can retain the previous e-ink image, including its previous warning state. The always-visible source-success timestamp matters even when no new warning or error can be delivered.

## Local prerequisites

- .NET 10 SDK and Azure Functions Core Tools v4 with .NET 10 support.
- PowerShell 7 and Node.js (used only for the synthetic local feed/preview).
- Ruby 4 with Bundler and native-extension build tools. On Windows, use RubyInstaller **with Devkit**; `redcarpet`, a dependency of TRMNL's own Liquid environment, has a native extension.

`TRMNL_RUBY` can select a Ruby executable. Otherwise the scripts use `.tools\ruby\bin\ruby.exe` when present, then `ruby` on PATH. No private feed, Azure credentials, or TRMNL account is needed.

## Repeatable run

From the repository root:

```powershell
.\scripts\setup-display.ps1
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal
```

Setup restores the locked Ruby gems into ignored `vendor`, downloads the pinned native framework and its real fonts into ignored `.tools`, builds the .NET harness, and installs its Chromium browser. Application and test package references pin the verified parser version. Assets and tool installations are not committed.

Count labels use standard Liquid conditionals: the standalone `trmnl-liquid` environment does not provide the Rails helper required by its `pluralize` filter. The rendering harness drains stdout/stderr concurrently and bounds rendering time, so template exceptions are reported rather than hanging a test run.

The tests cross the two agreed outer interfaces:

- **Refresh plus HTTP results:** the actual timer handler/cadence gate and cache-only production HTTP handler, real Ical.Net parser/title matching, controlled external HTTP/time/storage and persistent local source/outcome recreation. A common fixture helper refreshes on fixture changes, never on repeated HTTP/rule polls. Tests include real registered-client acquisition above ten seconds, exact 15-minute/hour boundaries, overlapping/equal-clock generations, partial publication, and 30/35/9-second deadlines. No private parser/matcher/scheduling-helper tests.
- **Rendered output:** the production `display\src` Liquid templates rendered by `TRMNL::Liquid`, with the real framework, fonts, JavaScript, and all six native placements. Assertions check text ranges against clipping ancestors and physical view bounds, non-overlapping essential rows, physical PNG dimensions and actual raster ink at required-text positions, readable font sizes, truthful overflow, escaping, and fitting at the native capture-readiness signal itself. Raster inspection uses the already-locked ChunkyPNG gem; it does not render or fit the agenda.

Synthetic recurrence fixtures cover ongoing and ended instances, recurrence dates/exclusions, exclusive all-day ends, implicit single-day all-day occurrences, cross-date moves, start-less attached cancellations, cancelled series, UTC-equivalent override identifiers, and complete detached timed/all-day snapshots with multiple instances sharing a UID. Representative HTTP results are rendered through production Liquid to verify all-day labels, actual moved/detached times, complete per-day counts, both DST transitions with Outlook Pacific/Eastern aliases, and visible compatibility failures without a successful source timestamp. Detached-source checks also exercise edited rules, persisted fallback after adapter recreation, working-date rollover, and expiry without renewing source success.

Attached all-day midnight-identifier checks cover Windows/IANA wall dates across both DST changes, zones whose midnight falls on a different UTC date, moves and cancellations, and duplicates equivalent to DATE-only identifiers. Current rules and persisted fallback also cross production Liquid/Chromium with date-only output, truthful totals, and unchanged source success.

Maintained-timezone HTTP checks use public Windows IDs before/after 2026 transitions and through future winter/summer dates, including their permanent-DST rules. They also cover recurring moves/cancellations, canonical duplicate rejection, detached and all-day semantics, concurrent Windows/IANA/unknown sources, current rules, persisted stale-source reevaluation, exact expiry, and production native rendering.

Cache requests cover repeated failures, invalid UTF-8, malformed/unsupported replacements, a stale response one tick below an hour, expiry at exactly an hour, source replacement, feed isolation, edited/invalid rules, and working-date rollover. HTTP-produced current, empty, stale, stale-empty, expired compatibility, configuration, and no-cache source-error results are raster-checked inside all six native views, including truthful overflow, secondary counts, and source freshness.

## Adaptive production views

TRMNL prepends `shared.liquid` to each matching view template: `full.liquid`, `half_horizontal.liquid`, or `half_vertical.liquid`. All three use the same production markup and fitter under the platform's native view wrapper; `display\render.rb` adds only a local preview shell, not another layout algorithm.

The fitter measures the available view after fonts load and before the framework publishes capture readiness, and refits on dimension changes. It reserves both selected-day headings/counts, source-success information, and truthful primary overflow before admitting ordered primary occurrences. Only remaining room goes to secondary details, then optional locations. Titles use up to two readable 21px logical lines; locations may be elided or removed, not allowed to displace essential rows. Timed rows retain AM/PM start-end ranges and all-day rows say **All day**. No descriptions or attendees are rendered.

The native framework includes screen padding and the split-screen gap:

| Device | Physical canvas | Full view | Half-horizontal view | Half-vertical view |
|---|---|---|---|---|
| OG | 800 x 480 | 780 x 460 | 780 x 225 | 385 x 460 |
| X | 1872 x 1404 | 1836 x 1368 | 1836 x 675 | 909 x 1368 |

Framework 3.4.3 names X `screen--v2`: its 1040 x 780 logical canvas is transformed by the native **1.8** pixel ratio. Tests use a 1872 x 1404 browser viewport at device scale factor 1, preserving that transform rather than applying it twice or replacing native dimensions.

For just the adaptive matrix:

```powershell
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal --filter FullyQualifiedName~AdaptiveDisplayTests
```

Fixtures are synthetic agenda-contract data, including busy primary days, secondary overflow, long/escaped strings, optional-location removal, all-day entries, Friday/weekend labels, selected empty days, stale warnings, error categories, and absent source success. Bounded-row fixtures deliberately supply fewer occurrences than `eligible_total` to verify `+N more` includes undisplayed adapter-side commitments; the current adapter still returns `agenda_too_large` rather than truncating. Stale fixtures retain their original source-success time; neither `generated_at` nor rendering advances it.

## HTTP-to-display example

The runnable end-to-end demonstration is independently repeatable:

```powershell
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal --filter End_to_end_demo
```

It starts a loopback synthetic ICS server and the **real Functions host from the build output**, invokes the actual refresh handler with a controlled eligible tick and the production registered client, renders the settings' POST body, and passes the cache-only host response directly to production templates. The source includes a public `British Columbia Standard Time` meeting, exercising maintained rules after worker recreation. Chromium visits all six generated native pages, checking labels, commitments, bounds and the original timestamp. Rule edits, malformed editor text and `[]` affect HTTP output without another source request. A scheduled-handler redirect check fails without following it. The test **restarts the Functions process**, reloads both persisted source and failed outcome, and renders stale results in all six views without renewing success. Real worker indexing must expose exactly function-authenticated `Agenda` POST plus one `RefreshSource` timer with monitoring and no startup run; no test route is added. The local harness does not establish host timer-storage coordination or managed-identity rights: actual timer execution remains a deployed gate. Synthetic confidential markers must remain absent from host diagnostics. Owned processes and temporary caches are cleaned up on success/failure.

Generated synthetic outputs include `artifacts\demo-agenda.json`, `artifacts\demo-stale-agenda.json`, `artifacts\demo.html`, `artifacts\demo.png`, `artifacts\demo-host.log`, and six each of `demo-{og|x}-{full|half_horizontal|half_vertical}.html`/`.png` and `demo-stale-{og|x}-{full|half_horizontal|half_vertical}.html`/`.png`. The adaptive and HTTP/cache matrices also save native-bounds screenshots. These generated artifacts are ignored, not private or committed calendar data. To inspect the last generated HTML previews:

```powershell
node .\scripts\synthetic-source.mjs 8899
```

Open `http://127.0.0.1:8899/` for the default OG view, or, for example, `http://127.0.0.1:8899/demo-x-half_vertical.html` and `http://127.0.0.1:8899/demo-stale-og-half_horizontal.html`. Stop the preview with Ctrl+C. This server exposes only the allowlisted synthetic demo pages/feed and the downloaded framework assets.

## Interactive Functions run

With the synthetic server above running, a second terminal can run:

```powershell
$env:FUNCTIONS_WORKER_RUNTIME = 'dotnet-isolated'
$env:AZURE_FUNCTIONS_ENVIRONMENT = 'Development'
$env:AzureWebJobsSecretStorageType = 'files'
$env:AzureWebJobsStorage = 'UseDevelopmentStorage=true'
$env:Agenda__SourceUrl = 'http://127.0.0.1:8899/calendar.ics'
$env:Agenda__DevelopmentCacheDirectory = Join-Path (Get-Location) 'artifacts\interactive-source-cache'
dotnet build .\src\CalendarAgenda\CalendarAgenda.csproj
func start --no-build --script-root .\src\CalendarAgenda\bin\Debug\net10.0
```

Run a local Azurite blob emulator for the interactive timer's host coordination before starting Core Tools; this well-known development connection is not a production credential or setting. The automatic timer first refreshes on an eligible scheduled tick, not startup. A poll before successful refresh returns `refresh_missing`. The automated direct-handler/HTTP/rendering suite does not need Azurite. Then poll from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:7071/api/agenda -Method Post `
  -Headers @{ 'x-functions-key' = 'synthetic-local-only' } `
  -ContentType application/json -Body '{"rules_json":"[]"}'
```

`Agenda__DevelopmentCacheDirectory` is an internal local-persistence substitute selected **only** in the explicit Development environment. It exercises the production source-cache policy without cloud credentials; it is not an end-user/plugin setting. Production ignores it and requires the managed-identity blob settings above. Use synthetic sources only with these local tools.

**Core Tools normally disables local authentication.** A local success with this synthetic header does not prove Azure key enforcement. The emitted definition is POST with `AuthorizationLevel.Function`; actual timer execution, Azure key enforcement, native delivery, system-identity blob access and cold-start latency still require [#8](https://github.com/geevensingh/trmnl-calendar/issues/8). Empty local host storage can prevent the timer listener/monitor from running even when indexing and HTTP work; the adapter's local source cache is separate from host coordination storage.

## Production surfaces, not activation

`display\src\settings.yml` defines native endpoint, password-style function key, and code-style rules fields. Polling is POST every 15 minutes, with `x-functions-key` in the header and the rule text serialized using TRMNL's `json` filter. The source URL is **not** a plugin field or request parameter.

Rules have exactly `field`, `mode`, and `value`: use field `title`, mode `whole_word`, `starts_with`, or `contains`, and a nonblank literal string. Values match case-insensitively without changing displayed titles; any match excludes an occurrence. Whole-word matching treats punctuation and underscores as separators, so `OOF_holiday` matches while `Proofreading session` does not. Prefix rules do not match the middle of a title. Whitespace in values is significant, including the space in `"Following: "`. Unsupported fields/modes and any invalid rule reject the entire configuration. See [the rule contract](docs/agenda-contract.md#exclusion-rules) for the defaults and complete validation behavior.

For a secret-free, ready-to-run Release archive and commit/hash manifest:

```powershell
.\scripts\package-function.ps1
```

The [Azure delivery runbook](docs/azure-delivery.md) covers the approved Linux Flex .NET 10 infrastructure, guarded what-if/infrastructure/code deployment, runtime-only owner inputs, Key Vault source workflow, function-scoped key rotation, safe active/previous package retention, redacted smoke checks, $20 budget alerts, recovery and the still-unverified live evidence checklist. `.\scripts\deploy-azure.ps1` defaults to a local Bicep build, not cloud changes. Live activation belongs to the reviewed integration branch and explicit owner gates.

The target is Functions v4, .NET 10 isolated, Linux **Flex Consumption**, not classic Linux Consumption. Configure the HTTPS source URL solely as the runtime secret `Agenda__SourceUrl`. HTTP source URLs are rejected except loopback URLs in explicit Development. Only scheduled refresh fetches that fixed URL: no redirects, 30 seconds headers plus body, 2 MiB and a shared 35-second refresh deadline. HTTP request JSON remains bounded to 16 KiB and successful serialized results to 95,000 UTF-8 bytes. An oversize agenda is a renderable error, never silently truncated commitments.

Only fixed error codes are logged. HttpClient URL logging and automatic dependency URL capture are disabled; allowed host telemetry categories, sampling, retention and volume safeguards are described in the runbook. Do not add worker auto-instrumentation, enable request/response body logging, or use private data with the local preview tools. Committed fixtures and generated demo inputs are synthetic.

See [the shared agenda contract](docs/agenda-contract.md) for field definitions, timed/all-day shapes, grouping, stale/expiry behavior, and explicit errors. Source-success time is the successful fetch/interpretation time, not Outlook's publication time or the most recent cache response.
