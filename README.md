# TRMNL Calendar

The basic agenda slice for [#3](https://github.com/geevensingh/trmnl-calendar/issues/3), under [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2).

The production path is a .NET 10 isolated Azure Function, stable Ical.Net **5.2.3**, and a private TRMNL plugin. The function fetches its configured source, interprets nonrecurring timed events, and returns a two-working-day agenda in `America/Los_Angeles`. The full-screen OG view uses the actual `trmnl-liquid` environment and TRMNL framework **3.4.3**, including its native clamp and overflow engines.

This slice intentionally accepts **only `[]` exclusion rules**. Recurrence, all-day events, floating times, unsupported timezones, nonempty rules, and invalid sources produce explicit errors rather than partial or unfiltered success. Adaptive OG/X layouts, persistent stale fallback, private-feed compatibility, and Azure/TRMNL activation belong to follow-on tickets.

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

- **HTTP requests/results:** the production function handler, real Ical.Net parser, controlled external HTTP transport and clock. No private parser/matcher/helper tests.
- **Rendered output:** the production `display\src` Liquid templates rendered by `TRMNL::Liquid`, with the real framework, fonts, JavaScript, 800 x 480 OG viewport, and framework readiness signal. Assertions check physical bounds as well as text, escaping, counts, and overflow.

The runnable end-to-end demonstration is also independently repeatable:

```powershell
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal --filter End_to_end_demo
```

It starts a loopback synthetic ICS server and the **real Functions host from the build output**, renders the actual settings' POST body, fetches the feed through the production HTTP adapter, and renders the resulting response through the production templates/framework. It checks the host's actual POST/function-auth definition and verifies that a redirect is a source error, exercising the production HttpClient registration. Owned processes are stopped, including on failure.

Generated synthetic outputs are `artifacts\demo-agenda.json`, `artifacts\demo.html`, `artifacts\demo.png`, `artifacts\demo-host.log`, and `artifacts\og-busy.png`. To inspect the last generated HTML preview:

```powershell
node .\scripts\synthetic-source.mjs 8899
```

Open `http://127.0.0.1:8899/`; stop the preview with Ctrl+C. This server exposes only synthetic demo data and the downloaded framework assets.

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

For deployment packaging only:

```powershell
dotnet publish .\src\CalendarAgenda\CalendarAgenda.csproj -c Release -o .\artifacts\publish
```

The target is Functions v4, .NET 10 isolated, Linux **Flex Consumption**, not classic Linux Consumption. Configure the HTTPS source URL solely as the runtime secret `Agenda__SourceUrl`. HTTP source URLs are rejected except loopback URLs in the explicit Development environment. Redirects are not followed, retrieval is bounded to six seconds and 2 MiB, request JSON to 16 KiB, and serialized successful results to 95,000 UTF-8 bytes. An oversize agenda becomes a small renderable error; events are never silently truncated at the HTTP seam.

Only fixed error codes are logged. HttpClient URL logging is removed. Do not enable request/response body logging or use private data with the local preview tools. Committed fixtures and generated demo inputs are synthetic.

See [the shared agenda contract](docs/agenda-contract.md) for field definitions, reserved all-day/stale shapes, grouping, and sibling-ticket extension points. Source-success time is the successful fetch/interpretation time, not Outlook's publication time. Fifteen-minute polling plus Outlook publication and device refresh delays is not a freshness guarantee; an offline device can retain its old image.
