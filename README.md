# TRMNL Calendar

The agenda slices for [#3](https://github.com/geevensingh/trmnl-calendar/issues/3) and [#4](https://github.com/geevensingh/trmnl-calendar/issues/4), native configurable title exclusions from [#5](https://github.com/geevensingh/trmnl-calendar/issues/5), and adaptive production views from [#6](https://github.com/geevensingh/trmnl-calendar/issues/6), under [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2).

The production path is a .NET 10 isolated Azure Function, stable Ical.Net **5.2.3**, and a private TRMNL plugin. The function fetches its configured source, resolves timed and all-day occurrences, applies validated title exclusions, and returns a two-working-day agenda in `America/Los_Angeles`. OG and X support full-screen, half-horizontal, and half-vertical placements through the actual `trmnl-liquid` environment and pinned TRMNL framework **3.4.3**.

Recurring series use the installed stable library's `RRULE`, `RDATE`, and `EXDATE` evaluation before selection and counting. Moved instances replace their originals; cancelled overrides, including those without their own start/end, suppress originals without appearing themselves. Cancelling a series also suppresses its overrides. All-day ranges retain date-only, exclusive ends and render as **All day**, not midnight meetings. Windows timezone aliases use the library's actual resolver, including Los Angeles daylight-saving changes.

The native code-style rule editor starts with whole-word OOF/OOO and starts-with working from/`Following: ` exclusions. An edit changes the next poll without adapter redeployment. A deliberate `[]` disables exclusions; missing, malformed, or unsupported configuration shows a visible error, never defaults, old rules, or an unfiltered fallback.

Parsed `RECURRENCE-ID;RANGE=THISANDFUTURE`, other recurrence ranges, deprecated `EXRULE`, orphan overrides, floating times, unsupported timezones, and invalid sources produce explicit errors rather than partial success. The stable occurrence engine does not cascade ranged edits; serializer support does not establish evaluation support. Unproductive recurrence evaluation is bounded and returns a compatibility error. Persistent stale fallback, private-feed compatibility, and Azure/TRMNL activation belong to follow-on tickets; the display already supports the agreed stale result shape without implementing a cache.

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

- **HTTP requests/results:** the production function handler, real Ical.Net parser and title matching, controlled external HTTP transport and clock. No private parser/matcher/helper tests.
- **Rendered output:** the production `display\src` Liquid templates rendered by `TRMNL::Liquid`, with the real framework, fonts, JavaScript, and all six native placements. Assertions check text ranges against clipping ancestors and physical view bounds, non-overlapping essential rows, physical PNG dimensions and actual raster ink at required-text positions, readable font sizes, truthful overflow, escaping, and fitting at the native capture-readiness signal itself. Raster inspection uses the already-locked ChunkyPNG gem; it does not render or fit the agenda.

Synthetic recurrence fixtures cover ongoing and ended instances, recurrence dates/exclusions, exclusive all-day ends, implicit single-day all-day occurrences, cross-date moves, start-less cancellations, cancelled series, and UTC-equivalent override identifiers. Representative HTTP results are rendered through production Liquid to verify all-day labels, actual moved times, complete per-day counts, both DST transitions with Outlook Pacific/Eastern aliases, and visible compatibility failures without a successful source timestamp.

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

It starts a loopback synthetic ICS server and the **real Functions host from the build output**, renders the actual settings' POST body, fetches the feed through the production HTTP adapter, and passes the returned JSON directly to the production templates. Chromium visits all six generated display pages over HTTP with the actual pinned assets, checking selected labels, visible commitments, physical bounds, and the unchanged source-success timestamp. It also preserves the native rule-editor example: edit exclusions between polls, show a visible configuration error for malformed editor text, and clear exclusions with `[]`, without restarting the host. It checks the host's actual POST/function-auth definition, verifies confidential synthetic rule/key/source markers are absent from host diagnostics, and verifies that a redirect is a source error, exercising the production HttpClient registration. Owned processes are stopped, including on failure.

Generated synthetic outputs include `artifacts\demo-agenda.json`, `artifacts\demo.html`, `artifacts\demo.png`, `artifacts\demo-host.log`, and six `demo-{og|x}-{full|half_horizontal|half_vertical}.html`/`.png` pairs. The adaptive matrix also saves six `busy-{og|x}-{full|half_horizontal|half_vertical}.png` images; these generated artifacts are ignored, not private or committed calendar data. To inspect the last generated HTML previews:

```powershell
node .\scripts\synthetic-source.mjs 8899
```

Open `http://127.0.0.1:8899/` for the default OG view, or, for example, `http://127.0.0.1:8899/demo-x-half_vertical.html` and `http://127.0.0.1:8899/demo-og-half_horizontal.html`. Stop the preview with Ctrl+C. This server exposes only the allowlisted synthetic demo pages/feed and the downloaded framework assets.

## Interactive Functions run

With the synthetic server above running, a second terminal can run:

```powershell
$env:FUNCTIONS_WORKER_RUNTIME = 'dotnet-isolated'
$env:AZURE_FUNCTIONS_ENVIRONMENT = 'Development'
$env:AzureWebJobsSecretStorageType = 'files'
$env:AzureWebJobsStorage = ''
$env:Agenda__SourceUrl = 'http://127.0.0.1:8899/calendar.ics'
dotnet build .\src\CalendarAgenda\CalendarAgenda.csproj
func start --no-build --script-root .\src\CalendarAgenda\bin\Debug\net10.0
```

Then poll from another terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:7071/api/agenda -Method Post `
  -Headers @{ 'x-functions-key' = 'synthetic-local-only' } `
  -ContentType application/json -Body '{"rules_json":"[]"}'
```

**Core Tools normally disables local authentication.** A local success with this synthetic header does not prove Azure key enforcement. The emitted function definition is POST with `AuthorizationLevel.Function`; Azure function-scoped key/header enforcement, actual TRMNL delivery, managed hosting/storage, and cold-start latency still require the later activation check. An empty local storage setting can produce a host storage-health warning; this HTTP-only slice does not use persistent storage.

## Production surfaces, not activation

`display\src\settings.yml` defines native endpoint, password-style function key, and code-style rules fields. Polling is POST every 15 minutes, with `x-functions-key` in the header and the rule text serialized using TRMNL's `json` filter. The source URL is **not** a plugin field or request parameter.

Rules have exactly `field`, `mode`, and `value`: use field `title`, mode `whole_word`, `starts_with`, or `contains`, and a nonblank literal string. Values match case-insensitively without changing displayed titles; any match excludes an occurrence. Whole-word matching treats punctuation and underscores as separators, so `OOF_holiday` matches while `Proofreading session` does not. Prefix rules do not match the middle of a title. Whitespace in values is significant, including the space in `"Following: "`. Unsupported fields/modes and any invalid rule reject the entire configuration. See [the rule contract](docs/agenda-contract.md#exclusion-rules) for the defaults and complete validation behavior.

For deployment packaging only:

```powershell
dotnet publish .\src\CalendarAgenda\CalendarAgenda.csproj -c Release -o .\artifacts\publish
```

The target is Functions v4, .NET 10 isolated, Linux **Flex Consumption**, not classic Linux Consumption. Configure the HTTPS source URL solely as the runtime secret `Agenda__SourceUrl`. HTTP source URLs are rejected except loopback URLs in the explicit Development environment. Redirects are not followed, retrieval is bounded to six seconds and 2 MiB, request JSON to 16 KiB, and serialized successful results to 95,000 UTF-8 bytes. An oversize agenda becomes a small renderable error; events are never silently truncated at the HTTP seam.

Only fixed error codes are logged. HttpClient URL logging is removed. Do not enable request/response body logging or use private data with the local preview tools. Committed fixtures and generated demo inputs are synthetic.

See [the shared agenda contract](docs/agenda-contract.md) for field definitions, timed/all-day shapes, grouping, the reserved stale state, and sibling-ticket extension points. Source-success time is the successful fetch/interpretation time, not Outlook's publication time. Fifteen-minute polling plus Outlook publication and device refresh delays is not a freshness guarantee; an offline device can retain its old image.
