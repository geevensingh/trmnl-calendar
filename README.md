# TRMNL Calendar

The agenda slices for [#3](https://github.com/geevensingh/trmnl-calendar/issues/3) and [#4](https://github.com/geevensingh/trmnl-calendar/issues/4), native configurable title exclusions from [#5](https://github.com/geevensingh/trmnl-calendar/issues/5), adaptive production views from [#6](https://github.com/geevensingh/trmnl-calendar/issues/6), persistent stale-source fallback from [#7](https://github.com/geevensingh/trmnl-calendar/issues/7), and secure delivery tooling for [#8](https://github.com/geevensingh/trmnl-calendar/issues/8), under [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2). Delivery tooling is not a claim of live activation.

The production path is a .NET 10 isolated Azure Function, stable Ical.Net **5.2.3**, and a private TRMNL plugin. The function fetches its configured source, resolves timed and all-day occurrences, applies validated title exclusions, and returns a two-working-day agenda in `America/Los_Angeles`. OG and X support full-screen, half-horizontal, and half-vertical placements through the actual `trmnl-liquid` environment and pinned TRMNL framework **3.4.3**.

Timezone rules are pinned to NodaTime **3.3.5**, including its embedded **TZDB 2026e**. Ical's default resolver remains first; previously unmapped Windows IDs use TimeZoneConverter **8.0.0**'s exact territory-`001` Windows-to-IANA mapping and the same NodaTime provider. The resolver is installed once per process, including direct HTTP hosting, without source-derived global mappings, runtime downloads, host Windows/ICU conversion, or fixed-offset aliases. Public 2026 IDs such as `British Columbia Standard Time`, `Alberta Standard Time`, and `Manitoba Standard Time` therefore use their maintained Vancouver/Edmonton/Winnipeg rules, not superseded seasonal Windows rules. Unknown/floating identifiers and unrecognized custom `VTIMEZONE` definitions remain explicit compatibility errors.

Recurring series use the installed stable library's `RRULE`, `RDATE`, and `EXDATE` evaluation before selection and counting. Timed and date-only occurrence streams are bounded separately before selection, so an out-of-window all-day occurrence cannot hide an eligible evening meeting. Both retain the complete calendar's override metadata for the library's replacement logic. Moved instances replace their originals; cancelled overrides, including those without their own start/end, suppress originals without appearing themselves. Cancelling a series also suppresses its overrides. All-day ranges retain date-only, exclusive ends and render as **All day**, not midnight meetings. Windows timezone aliases use the library's actual resolver, including Los Angeles daylight-saving changes.

An attached all-day change may use a known, nonfloating DATE-TIME `RECURRENCE-ID` at exact literal wall midnight when its series start and complete actual override are DATE-only. The override must supply an end or duration; a cancellation with no start, end, or duration is also supported on that known series. Its identifier and timezone metadata remain untouched for the library's wall-date replacement, not converted through UTC or coerced to DATE. Nonmidnight identifiers (even UTC-equivalent local midnight), unknown/floating zones, timed actual overrides, and changes with their own recurrence sets remain errors. Other date-kind mismatches and the detached requirements below are not relaxed.

Published snapshots can contain detached `RECURRENCE-ID` records without a series definition. These are supported only as individually supplied occurrences with an explicit start and end or duration, a matching identifier date kind, and no recurrence set or range of their own. Stable 5.2.3 evaluates their actual `DTSTART`, not the identifier's original time; the adapter neither invents a master nor expands unseen instances. Complete cancelled detached records are omitted, while duplicate occurrence identities remain whole-source errors, including equivalent UTC/Windows-zone identifiers. Active detached records sharing a UID and actual start are also rejected rather than collapsed or returned with duplicate display IDs. Incomplete detached records, including start-less cancellations, are not guessed; attached cancellation behavior above is unchanged.

The native code-style rule editor starts with whole-word OOF/OOO and starts-with working from/`Following: ` exclusions. An edit changes the next poll without adapter redeployment. A deliberate `[]` disables exclusions; missing, malformed, or unsupported configuration shows a visible error, never defaults, old rules, or an unfiltered fallback.

Parsed `RECURRENCE-ID;RANGE=THISANDFUTURE`, other recurrence ranges, deprecated `EXRULE`, detached records with their own recurrence sets or incomplete timing, floating times, unsupported timezones, and invalid sources fail the whole source check rather than producing partial success. The stable occurrence engine does not cascade ranged edits; serializer support does not establish evaluation support. Unproductive recurrence evaluation is bounded and returns a compatibility error. Such failures may use a recent, visibly stale last-good source, but never replace it or renew its timestamp. Private-feed compatibility and Azure/TRMNL activation remain [#8](https://github.com/geevensingh/trmnl-calendar/issues/8).

## Persistent source and freshness

The cache retains the last successfully fetched **and interpreted source within supported calendar semantics**, not filtered agenda rows or rendered output. Every fallback runs that source through the same real calendar/rule logic with the current request's rules, current Los Angeles working dates, and current ended-event cutoff. Edited rules and Friday-to-Saturday rollover therefore take effect during an outage. Missing or invalid rules still return a configuration error without reading or using cached data.

After a rejected response, redirect, timeout, transport/encoding/parse failure, or unsupported calendar feature, a matching retained source is usable only while its source-success age is **strictly less than one hour**. It returns `stale`, the safe fresh-check failure, a visible warning, and its **original** source-success date/time. At exactly one hour or later, with no usable cache, or with a future-dated snapshot, it returns an error with unknown counts and no events, never a healthy empty day. Repeated stale polls and renders cannot extend this interval. A later supported source check replaces the snapshot and establishes a new success time. Changing the configured feed cannot reuse another feed's commitments.

Production stores one overwritten `last-good-source.json` blob in a **private, pre-existing container**. Its versioned envelope contains the raw source, a digest binding it to the configured source URL, and the original source-success time. Raw source may contain confidential fields that are never returned to TRMNL. The 2 MiB source limit also applies on reload; stored JSON is bounded to 13 MiB to allow JSON escaping. Conditional blob writes prevent an older concurrent source success from overwriting a newer one. A worker restart does not erase this cache.

Configure these **Azure runtime settings**, not TRMNL settings or HTTP inputs:

| Setting | Value |
|---|---|
| `Agenda__CacheServiceUri` | The HTTPS blob service URI of the reused Functions StorageV2 account, e.g. `https://<account>.blob.core.windows.net`. No credentials, SAS/query string, or container path. |
| `Agenda__CacheContainer` | The name of the private cache container created during activation. |

The cache explicitly uses the Function app's **system-assigned managed identity**. Grant that identity **Storage Blob Data Contributor at the cache container's scope only**, `/subscriptions/<subscription>/resourceGroups/<group>/providers/Microsoft.Storage/storageAccounts/<account>/blobServices/default/containers/<container>`. The adapter reads and conditionally overwrites its blob; it does not create containers, request account keys, or require account/resource-group/subscription-wide Contributor access. Do not enable anonymous container/blob access or configure storage credentials. The Functions host's separate user-assigned storage identity and its settings do not select the cache identity.

Missing/unsafe storage configuration, unavailable storage, or an unusable stored envelope produce bounded `cache_configuration`, `cache_unavailable`, or `cache_invalid` errors. Even a supported fresh source produces an explicit error if it cannot be persisted; its known source-success time remains visible, but counts are not claimed. SDK URL/content diagnostics and retries are disabled for the cache. Outbound I/O shares a nine-second cancellation budget. Source acquisition, including headers and body together, is additionally limited to eight seconds; cache reads/writes receive only the remaining shared budget, not a new deadline. These bounds do not guarantee the ten-second TRMNL attempt budget: platform initialization and delivery overhead still need deployed cold-path measurement. Keep blob versioning/soft-delete retention and telemetry growth bounded when configuring the reused account; one overwritten live blob alone does not bound retained versions.

Polling targets **15 minutes**, not end-to-end freshness: Outlook publication and device refresh add delay. An unreachable adapter or offline TRMNL can retain the previous e-ink image, including its previous warning state. The always-visible source-success timestamp matters even when no new warning or error can be delivered.

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

- **HTTP requests/results:** the production function handler, real Ical.Net parser and title matching, controlled external HTTP transport and clock, and persistent local cache states/recreation. No private parser/matcher/helper tests.
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

It starts a loopback synthetic ICS server and the **real Functions host from the build output**, renders the actual settings' POST body, fetches the feed through the production HTTP adapter, and passes the returned JSON directly to the production templates. The source includes a public `British Columbia Standard Time` meeting, exercising the maintained mapping in the real worker and after restart. Chromium visits all six generated display pages over HTTP with the actual pinned assets, checking selected labels, visible commitments, physical bounds, and the source-success timestamp. It preserves the native rule-editor example: edit exclusions between polls, show a visible configuration error for malformed editor text, and clear exclusions with `[]`, without restarting the host. A subsequent redirect fails the fresh source check without being followed. The test then **terminates and restarts the Functions process**, reloads the same persisted source, and renders visibly stale results in all six views with the unchanged last-success timestamp. It checks the host's actual POST/function-auth definition and verifies confidential synthetic rule/key/source markers are absent from both processes' diagnostics. Owned processes and temporary local cache directories are cleaned up, including on failure.

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
$env:AzureWebJobsStorage = ''
$env:Agenda__SourceUrl = 'http://127.0.0.1:8899/calendar.ics'
$env:Agenda__DevelopmentCacheDirectory = Join-Path (Get-Location) 'artifacts\interactive-source-cache'
dotnet build .\src\CalendarAgenda\CalendarAgenda.csproj
func start --no-build --script-root .\src\CalendarAgenda\bin\Debug\net10.0
```

Then poll from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:7071/api/agenda -Method Post `
  -Headers @{ 'x-functions-key' = 'synthetic-local-only' } `
  -ContentType application/json -Body '{"rules_json":"[]"}'
```

`Agenda__DevelopmentCacheDirectory` is an internal local-persistence substitute selected **only** in the explicit Development environment. It exercises the production source-cache policy without cloud credentials; it is not an end-user/plugin setting. Production ignores it and requires the managed-identity blob settings above. Use synthetic sources only with these local tools.

**Core Tools normally disables local authentication.** A local success with this synthetic header does not prove Azure key enforcement. The emitted function definition is POST with `AuthorizationLevel.Function`; Azure function-scoped key/header enforcement, actual TRMNL delivery, system-managed-identity blob access, and cold-start latency still require [#8](https://github.com/geevensingh/trmnl-calendar/issues/8). An empty local host storage setting can produce a host storage-health warning; the adapter's local source cache is separate from Functions host storage.

## Production surfaces, not activation

`display\src\settings.yml` defines native endpoint, password-style function key, and code-style rules fields. Polling is POST every 15 minutes, with `x-functions-key` in the header and the rule text serialized using TRMNL's `json` filter. The source URL is **not** a plugin field or request parameter.

Rules have exactly `field`, `mode`, and `value`: use field `title`, mode `whole_word`, `starts_with`, or `contains`, and a nonblank literal string. Values match case-insensitively without changing displayed titles; any match excludes an occurrence. Whole-word matching treats punctuation and underscores as separators, so `OOF_holiday` matches while `Proofreading session` does not. Prefix rules do not match the middle of a title. Whitespace in values is significant, including the space in `"Following: "`. Unsupported fields/modes and any invalid rule reject the entire configuration. See [the rule contract](docs/agenda-contract.md#exclusion-rules) for the defaults and complete validation behavior.

For a secret-free, ready-to-run Release archive and commit/hash manifest:

```powershell
.\scripts\package-function.ps1
```

The [Azure delivery runbook](docs/azure-delivery.md) covers the approved Linux Flex .NET 10 infrastructure, guarded what-if/infrastructure/code deployment, runtime-only owner inputs, Key Vault source workflow, function-scoped key rotation, safe active/previous package retention, redacted smoke checks, $20 budget alerts, recovery and the still-unverified live evidence checklist. `.\scripts\deploy-azure.ps1` defaults to a local Bicep build, not cloud changes. Live activation belongs to the reviewed integration branch and explicit owner gates.

The target is Functions v4, .NET 10 isolated, Linux **Flex Consumption**, not classic Linux Consumption. Configure the HTTPS source URL solely as the runtime secret `Agenda__SourceUrl`. HTTP source URLs are rejected except loopback URLs in the explicit Development environment. Redirects are not followed, retrieval is bounded to eight seconds for headers plus body and 2 MiB within the shared nine-second I/O budget, request JSON to 16 KiB, and serialized successful results to 95,000 UTF-8 bytes. An oversize agenda becomes a small renderable error; events are never silently truncated at the HTTP seam.

Only fixed error codes are logged. HttpClient URL logging and automatic dependency URL capture are disabled; allowed host telemetry categories, sampling, retention and volume safeguards are described in the runbook. Do not add worker auto-instrumentation, enable request/response body logging, or use private data with the local preview tools. Committed fixtures and generated demo inputs are synthetic.

See [the shared agenda contract](docs/agenda-contract.md) for field definitions, timed/all-day shapes, grouping, stale/expiry behavior, and explicit errors. Source-success time is the successful fetch/interpretation time, not Outlook's publication time or the most recent cache response.
