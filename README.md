# TRMNL Calendar

<!-- Disposable CI eligibility probe afdfa011-ad8b-4497-85b4-35adc3085cdc. Do not integrate this marker. -->

The agenda slices for [#3](https://github.com/geevensingh/trmnl-calendar/issues/3) and [#4](https://github.com/geevensingh/trmnl-calendar/issues/4), native configurable title exclusions from [#5](https://github.com/geevensingh/trmnl-calendar/issues/5), adaptive production views from [#6](https://github.com/geevensingh/trmnl-calendar/issues/6), persistent stale-source fallback from [#7](https://github.com/geevensingh/trmnl-calendar/issues/7), and secure delivery tooling for [#8](https://github.com/geevensingh/trmnl-calendar/issues/8), under [spec #2](https://github.com/geevensingh/trmnl-calendar/issues/2). Delivery tooling and the protected source preflight from [#11](https://github.com/geevensingh/trmnl-calendar/issues/11) are not claims of live activation.

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

- .NET 10 SDK selected by `global.json`, PowerShell 7, and Node.js 22 or newer. Node uses its built-in test runner; no npm packages or hook manager are needed.
- Git **2.38 or newer** for disposable-repository validation and CI's pinned merge preparation (`merge-tree --write-tree`).
- For Full validation: Azure Functions Core Tools v4 with .NET 10 support, the .NET/ASP.NET Core 10 runtimes, and Azure CLI with Bicep on PATH. Only local compilation is used; no Azure login is needed.
- For display setup: Ruby 4, the lockfile's Bundler **4.0.20**, and compatible native-extension compiler/linker/make tools. On Windows, use RubyInstaller **with Devkit**; `redcarpet` and other locked gems have native extensions. Full validation needs the restored native gems to load, not a compiler merely to render them.

No private feed, Azure credentials, or TRMNL account is needed.

### One-time shared Ruby installation and selection

Install shared tools explicitly, separately from project setup. On Windows, choose a supported Ruby+Devkit **4.x** installer for your architecture from the [official RubyInstaller downloads](https://rubyinstaller.org/downloads/). Compare the installer's SHA-256 with the corresponding official release and/or verify its PGP signature using the [official signing-key and verification guidance](https://github.com/oneclick/rubyinstaller2/wiki/FAQ#user-content-verify-signatures). For example, `Get-FileHash .\rubyinstaller-devkit-4.0.7-2-x64.exe -Algorithm SHA256` computes a hash; computing it without comparing against the official value does not verify the download.

Review the installer's persistent PATH and file-association choices. PATH changes and associations can affect other shells/apps through environment or registry settings; deselect them when you want explicit side-by-side selection. That does not make the installer itself portable or side-effect-free. Use a separate installation directory for a different Ruby stable branch rather than overwriting an existing Ruby 3 installation. Complete the compatible MSYS2/Devkit installation explicitly; [RubyInstaller's Devkit/ridk guidance](https://github.com/oneclick/rubyinstaller2#the-ridk-command) describes installation and repair. `ridk install` and MSYS2 package updates can download/change shared packages; project scripts never invoke them.

Select an existing installation in the current PowerShell process; no persistent PATH change is necessary:

```powershell
$env:TRMNL_RUBY = 'C:\Ruby40-x64\bin\ruby.exe'
& $env:TRMNL_RUBY -e 'puts RUBY_VERSION'
```

The selection order is explicit `TRMNL_RUBY`, an existing `.tools\ruby\bin\ruby.exe` in the **current worktree**, then `ruby` on PATH. An invalid/unusable explicit or existing local selection fails without falling back or searching other checkouts. Working installations are not replaced or downgraded.

Bundler **4.0.20** must already be available to the selected Ruby. If the prerequisite check reports it missing, explicitly install that version once with the selected interpreter:

```powershell
& $env:TRMNL_RUBY -rrubygems/gem_runner -e 'Gem::GemRunner.new.run(ARGV)' -- install bundler --version 4.0.20 --no-document
```

This is the RubyGems `install bundler` operation, independent of another installation's `gem` on PATH or a missing binstub. It accesses RubyGems and writes the selected installation's normal gem location; obtain permission for shared installation/repair as appropriate. Neither setup nor validation installs/upgrades Ruby, Bundler, Devkit or other shared tools. A later shared runtime/Devkit upgrade affects every worktree selecting it and can require rebuilding worktree-local native gems; use side-by-side selection when those effects are unwanted.

## Local validation

**`scripts\validate.ps1` is the authoritative validation procedure**, for manual use and GitHub Actions. Run the shared entrypoint rather than maintaining another list of checks.

The checked-in [Full validation workflow](.github/workflows/full-validation.yml) runs genuine Full for PR creation, head updates (including documentation-only changes), reopening and **every edit, including title/body edits**, using a Windows runner and synthetic inputs. Each admitted event supersedes active validation for that PR; a full run costs approximately 43 minutes. Draft/readiness activities are not triggers. Use issue comments for progress/acceptance updates rather than editing PR metadata, which restarts Full. Repository-managed automatic hooks are retired; existing installations need the explicit migration below. **Owner-authorized `main` protection is configured and read back; [#39](https://github.com/geevensingh/trmnl-calendar/issues/39) issue comments are the live acceptance ledger, with [PR #38](https://github.com/geevensingh/trmnl-calendar/pull/38) identifying the reviewed/current head and required genuine Full check.** See [Required CI and manual local validation](docs/ci-validation-design.md) for the stable check identity, provisioning, protection configuration and recorded evidence. Adding a workflow alone does not establish enforcement.

### Setup once per worktree

For Fast-only work, restore .NET dependencies without requesting an SDK development certificate:

```powershell
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
dotnet restore .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj
```

Fast does not need Ruby, Chromium, framework assets, Core Tools, or Azure CLI.

For Full validation, install the prerequisites above and run from the repository root:

```powershell
.\scripts\setup-display.ps1
```

Setup reports the selected Ruby and locked Bundler, compiles/loads a small disposable native extension using that Ruby's build configuration, and checks the SDK before restoring dependencies. It freezes `Gemfile.lock` (including `trmnl-liquid` **0.8.2**), keeps Bundler configuration in `.bundle` and project gems in `vendor\bundle`, acquires framework **3.4.3** and all fonts referenced by its CSS in `.tools\framework`, and builds the .NET harness. The installed Microsoft.Playwright **1.56.0** runtime selects the required Chromium revision. A local blank-page launch verifies usability; only explicit setup installs Chromium when that check fails.

Repeat the same command safely. Usable locked gems, nonempty versioned framework assets, complete fonts, and a usable selected Chromium installation are reused. Downloads and font extraction are staged before publication, so interrupted work cannot become a successful cached asset on the next run. Setup fails nonzero with recovery guidance rather than changing lockfiles, upgrading shared tools, skipping rendering tests or claiming partial success.

Project configuration, restored gems, framework assets and build output stay in the current worktree, including when inherited Bundler settings point elsewhere. Setup and Full use controlled project Bundler settings; normal Bundler user-cache selection, SDK/NuGet caches and versioned Playwright caches remain shared. An explicit `PLAYWRIGHT_BROWSERS_PATH` is honored. This is **not** a hermetic or guaranteed-offline bootstrap: downloads, shared caches, installer choices and later shared upgrades have external effects. Assets, dependency installations and generated output are not committed.

Both setup and validation set `DOTNET_GENERATE_ASPNET_CERTIFICATE=false` before their **first** SDK invocation, including version checks, overriding an inherited enabling value even with a fresh SDK home. They restore process environment changes after success or failure; the Fast-only command block leaves its process-local setting in the current PowerShell process and its children. These flows do not inspect, trust, remove or replace existing certificates, and any remediation needs separate authorization. Project scripts make no persistent PATH/registry/global-configuration changes.

Check `az bicep version` and, only if missing, install the local compiler once with `az bicep install`. Repeat display setup when dependencies or the selected Ruby/browser cache change. Validation itself never runs setup, installs tools or restores dependencies.

### Fast and Full scopes

```powershell
.\scripts\validate.ps1 -Scope Fast
.\scripts\validate.ps1 -Scope Full
```

| Scope | Checks | Intended use |
|---|---|---|
| Fast (default) | Read-only C# whitespace formatting, production and test-project compilation with existing warnings-as-errors settings, PowerShell parsing, and Node syntax | Optional manual feedback |
| Full | Complete read-only C# formatting, the Fast build/syntax checks, the unfiltered production .NET suite (real Functions host, Liquid, framework/fonts and Chromium), and every delivery/guardrail `*.test.mjs` through Node's existing runner | PR CI and optional manual full feedback |

The command resolves its own checkout root and reports each component as **PASSED**, **FAILED**, or **BLOCKED**, with elapsed time. Exit **0** means every selected component passed; any failure or blocked component exits **1**. Full diagnoses Ruby/Bundler, locked native-gem loading and framework/font readiness before expensive checks, then launches pinned Chromium after the existing build and before production tests. Failed readiness blocks dependent tests, never successful skips. Formatting uses `--verify-no-changes`; build/format/.NET test commands use `--no-restore`. Bicep update checks are disabled for validation subprocesses without changing Azure CLI configuration.

Manual validation checks the current working tree, including unstaged edits. Full uses synthetic fixtures, local HTTP/storage substitutes, and disposable Git repositories/local bare remotes. Delivery checks compile Bicep and publish a local Release package; external mutating Azure commands are substituted. Validation does not fetch the owner's calendar, require private inputs, change Azure resources, deploy, or change application behavior.

Foreign-repository Git subprocesses remove **all inherited `GIT_*` environment variables before the first `git init` or read**, not just `GIT_DIR` or the working directory. This includes common/work-tree, index/object/alternate selectors and environment-injected configuration. Node callers use `isolatedGitEnvironment(controls, inherited)` from `scripts/git-environment.mjs`; the C# Workbench fixture applies the same rule to `ProcessStartInfo.Environment`. Callers reapply only deliberate controls: fixtures disable system/global configuration and inherited templates, while the public Workbench retains normal on-disk user configuration. Non-Git tool settings are preserved. Workbench fixtures live in independent temporary directories. Owning-repository hook migration, packaging/deployment reads and completion proof retain their intended Git context; the validation boundary is not a substitute for isolating each foreign command.

`tests/validation/git-isolation.test.mjs` exercises actual completion and C# Workbench fixture commands with exported pre-push context from synthetic standard and linked owners, individual selectors, and injected configuration. It compares SHA-256s of all owner working files and Git metadata, including config, refs, HEAD, indexes and object storage; identity checks alone cannot detect inherited index/object targets. Build the existing test project before running this Node regression directly; Full already builds it before Node tests. No reproduction targets a real checkout's metadata.

### Display setup troubleshooting

| Failure | Recovery |
|---|---|
| Ruby missing, unusable or not major 4 | Set `TRMNL_RUBY` to a working existing Ruby 4 executable, or explicitly install Ruby+Devkit as above. An invalid explicit/local selection never silently falls back. |
| Locked Bundler missing/incompatible | Use the exact selected-Ruby Bundler installation command above; do not update `Gemfile.lock` or run an unqualified `bundle update`. |
| Native compile/link/make probe fails | Repair/install the compatible Devkit explicitly, or select an existing compatible installation, then rerun setup. The probe uses disposable worktree-local files and has a 45-second build deadline. |
| Locked Liquid/raster/native gems cannot load | Rerun setup with the same selected Ruby. If a damaged local bundle still passes Bundler's presence check but cannot load, remove/repair only this worktree's ignored `vendor\bundle`, then rerun setup; do not copy gems from another checkout. |
| Framework/font download or extraction fails | Check access to `trmnl.com` and rerun setup. If pre-existing versioned CSS/JS is damaged, remove only that reported ignored asset before retrying. |
| Pinned Chromium missing or cannot launch | Check the selected `PLAYWRIGHT_BROWSERS_PATH`, platform browser dependencies and network access, then rerun setup. Full never installs a browser as a fallback. |
| SDK or .NET restore/build fails | Install the SDK selected by `global.json`, or fix the reported package/compiler error and rerun setup. Missing tools/dependencies remain failures, not skipped tests. |

### Migrate previously installed Git hooks

Commits, merge commits and feature-branch backups no longer need repository-managed automatic validation. Fast and Full remain manually callable; no replacement local gate is installed. `-Action Install` now fails with retirement and migration guidance rather than creating hooks.

**Existing installed hooks are not silently uninstalled.** Before using this checkout for normal Git writes, coordinate with users of other linked worktrees, inspect the shared hooks, then explicitly remove unchanged generated hooks:

```powershell
.\scripts\git-hooks.ps1
.\scripts\git-hooks.ps1 -Action Remove
```

The migration command remains available in this version; its frozen v1 recognition data exists only to identify already-installed `pre-commit`, `pre-merge-commit` and `pre-push` files. Status is read-only and reports each name as `Managed`, `Missing` or `Preserved`. Removal is repeatable. It deletes **only exact, unchanged generated v1 hooks** from Git's common default hooks directory, which is **shared by linked worktrees**. Removing from one worktree removes those hooks for every checkout using that directory, including older branches.

Foreign/edited hooks, linked hook entries/directories and unrelated hook files are preserved. If a target hook is preserved, removal exits nonzero and explicitly reports a partial migration; review it manually rather than assuming automatic validation has stopped. Effective local/global/worktree `core.hooksPath` values and their configured destinations remain untouched, even if that configuration changed after installation. No Git configuration is changed. Custom hooks that call validation can still run until their owner edits them; do not delete them automatically. Keep this migration command available while old installations are supported.

### Synthetic test coverage

Tooling tests exercise the public PowerShell process interface with controlled external-command substitutes, and real commit/merge/push operations in disposable repositories. They cover scope selection, summaries/exit propagation, toolchain selection/readiness, repeatable display setup and partial-failure recovery, local project state/shared-cache selection, exact environment restoration and certificate suppression, rejected hook installation, repeatable v1 migration, partial-removal failures, foreign hook/configuration preservation, common worktree effects, and Git writes without automatic validation after migration. A frozen legacy-hook fixture is independent of the removal implementation. These synthetic tests do not prove hosted runner readiness or GitHub enforcement; both need the separate acceptance evidence in the CI design.

Count labels use standard Liquid conditionals: the standalone `trmnl-liquid` environment does not provide the Rails helper required by its `pluralize` filter. The rendering harness drains stdout/stderr concurrently and bounds rendering time, so template exceptions are reported rather than hanging a test run.

The core agenda/display tests cross two outer interfaces:

- **Refresh plus HTTP results:** the actual timer handler/cadence gate and cache-only production HTTP handler, real Ical.Net parser/title matching, controlled external HTTP/time/storage and persistent local source/outcome recreation. A common fixture helper refreshes on fixture changes, never on repeated HTTP/rule polls. Tests include real registered-client acquisition above ten seconds, exact 15-minute/hour boundaries, overlapping/equal-clock generations, partial publication, and 30/35/9-second deadlines. No private parser/matcher/scheduling-helper tests.
- **Rendered output:** the production `display\src` Liquid templates rendered by `TRMNL::Liquid`, with the real framework, fonts, JavaScript, and all six native placements. Assertions check text ranges against clipping ancestors and physical view bounds, non-overlapping essential rows, physical PNG dimensions and actual raster ink at required-text positions, readable font sizes, truthful overflow, escaping, and fitting at the native capture-readiness signal itself. Raster inspection uses the already-locked ChunkyPNG gem; it does not render or fit the agenda.

Synthetic recurrence fixtures cover ongoing and ended instances, recurrence dates/exclusions, exclusive all-day ends, implicit single-day all-day occurrences, cross-date moves, start-less attached cancellations, cancelled series, UTC-equivalent override identifiers, and complete detached timed/all-day snapshots with multiple instances sharing a UID. Representative HTTP results are rendered through production Liquid to verify all-day labels, actual moved/detached times, complete per-day counts, both DST transitions with Outlook Pacific/Eastern aliases, and visible compatibility failures without a successful source timestamp. Detached-source checks also exercise edited rules, persisted fallback after adapter recreation, working-date rollover, and expiry without renewing source success.

Attached all-day midnight-identifier checks cover Windows/IANA wall dates across both DST changes, zones whose midnight falls on a different UTC date, moves and cancellations, and duplicates equivalent to DATE-only identifiers. Current rules and persisted fallback also cross production Liquid/Chromium with date-only output, truthful totals, and unchanged source success.

Maintained-timezone HTTP checks use public Windows IDs before/after 2026 transitions and through future winter/summer dates, including their permanent-DST rules. They also cover recurring moves/cancellations, canonical duplicate rejection, detached and all-day semantics, concurrent Windows/IANA/unknown sources, current rules, persisted stale-source reevaluation, exact expiry, and production native rendering.

Cache requests cover repeated failures, invalid UTF-8, malformed/unsupported replacements, a stale response one tick below an hour, expiry at exactly an hour, source replacement, feed isolation, edited/invalid rules, and working-date rollover. HTTP-produced current, empty, stale, stale-empty, expired compatibility, configuration, and no-cache source-error results are raster-checked inside all six native views, including truthful overflow, secondary counts, and source freshness.

## Protected source preflight

After source access is authorized and **before accepting an acquisition strategy**, run the [protected operator preflight](docs/azure-delivery.md#protected-source-preflight-before-design-approval). It is a local executable mode of the actual production assembly, not an HTTP diagnostic route. No test or setup command accesses a private source. Live access requires `--authorize-source-access` and hidden terminal input; source URLs and credentials are not command arguments, environment configuration, or report fields.

The command optionally compares an exact hidden reference, measures the same production fixed-source acquisition and installed calendar/timezone interpretation, and retains every explicitly requested attempt. It reports the proposed nine-second synchronous application budget separately from the approved 30-second acquisition/35-second background allowance. An eleven-second source can fit the latter without being certified for synchronous polling. An optional nonsecret `--agenda-endpoint` runs the existing cache-only HTTP smoke with a separately hidden function key. Reports contain only safe codes, booleans, aggregate sizes and timings; they do not save private source content or write source/cache/refresh configuration.

Synthetic `SourcePreflightTests` cross the agreed operator-command and existing HTTP-smoke seams, including real header/body deadlines, exact/mismatched representations, maintained calendar fixtures, independent cache-only polling, first-red evidence, and stdout/stderr/saved-report redaction. Local source results are not Azure cold-start, identity, native TRMNL, or physical-device evidence.

## Delivery completion

The [Git delivery contract](docs/agents/delivery.md) governs implementation acceptance, landing on `main`, publication to GitHub, and ticket closure. It includes the executable read-only `scripts\check-completion.mjs` proof and the evidence to record before reporting delivery. Accepted integration work can unblock implementation dependencies without closing its delivery ticket; successful tests or Azure deployment do not establish Git delivery.

After human landing, use [post-merge bookkeeping](docs/agents/post-merge.md) to route already-approved fast-forward synchronization to a permitted existing checkout, accept the actual merge/squash content with truthful review provenance, and durably record the final proof. The workflow grants no synchronization permission and preserves host workspace restrictions.

## Adaptive production views

TRMNL prepends `shared.liquid` to each matching view template: `full.liquid`, `half_horizontal.liquid`, or `half_vertical.liquid`. All three use the same production markup and fitter under the platform's native view wrapper; `display\render.rb` adds only a local preview shell, not another layout algorithm.

The fitter measures the available view after fonts load and before the framework publishes capture readiness, and refits on dimension changes. It reserves both selected-day headers and source-success information before admitting ordered primary occurrences. Both populated-day counts stay beside their dates on the left: **N events** when complete, or **N of M events shown** when any eligible events are hidden, including zero displayed rows. Counts update as rows are admitted or removed. Valid empty days use one date/**No remaining events** line; they never promote later dates. There is no separate overflow row or footer. The absolute successful source-check timestamp is at the right of the primary header in wide views and on a second header line in narrow views, including empty primary days. Error views retain last-success information without inventing valid days or counts.

Only remaining room goes to secondary details, then optional locations. A populated-day count may wrap beside a longer date when needed, without shrinking header or event text. Titles occupy one readable 21px logical line with visual end ellipsis when necessary; their complete escaped text remains unchanged. Narrow views retain time above the single-line title. Locations may be elided or removed, not allowed to displace essential rows. Timed rows retain AM/PM start-end ranges and all-day rows say **All day**. No descriptions or attendees are rendered.

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

The shared version-controlled JSON catalogue in `display\scenarios` supplies the workbench and display checks, including busy primary days, secondary overflow, long/escaped strings, optional-location removal, all-day entries, Friday/weekend labels, selected empty days, stale warnings, error categories, and absent source success. Bounded-row fixtures deliberately supply fewer occurrences than `eligible_total` to verify inline counts include undisplayed adapter-side commitments; the current adapter still returns `agenda_too_large` rather than truncating. Stale fixtures retain their original source-success time; neither `generated_at` nor rendering advances it.

## Local agenda UI workbench

**Readiness first:** Review the [local prerequisites](#local-prerequisites) and [display setup](#setup-once-per-worktree) before choosing a preview approach, and check the available native tools and worktree-local assets. Keep missing prerequisites explicit. This navigation route does not authorize installations/repairs, new worktrees, commits, or production-template changes; existing task scope and permission requirements still apply.

**Illustrative, sketch-only fallback:** When native tooling is unavailable or inappropriate for a quick layout question, label any mockup as a sketch and state the missing prerequisites or reason for using it. Its fonts, geometry, scaling, or event counts are not evidence of production native fitting, capacity, or capture readiness.

After the existing [display setup](#setup-once-per-worktree), launch from this worktree:

```powershell
node .\scripts\agenda-workbench.mjs
```

Open the reported loopback URL (default `http://127.0.0.1:8898`). Stop with Ctrl+C. No Outlook access, private calendar, credentials, Azure login, or running Functions host is needed. The workbench uses the real strict Liquid renderer, production templates, installed framework 3.4.3/fonts, and production fitting; it does not reimplement agenda layout.

The baseline defaults to the current Git commit resolved **once at startup**. Its full identity stays visible and fixed even when you save files or create another commit. To use another locally available compatible revision or port:

```powershell
node .\scripts\agenda-workbench.mjs --baseline <commit-or-ref> --port 8898
```

Only the committed templates are pinned, not the scenarios or an arbitrary historical runtime. Baselines must declare the current agenda schema in their committed contract and pin the same framework CSS/JavaScript in their renderer. Missing or incompatible history fails explicitly; the tool never checks out old files over your edits, moves its baseline, or silently uses current templates instead. `--port 0` allocates an available port; `--workspace <local-directory>` selects an isolated Git/input workspace while retaining this checkout's installed renderer and assets, as used by browser tests.

The initial view is **Normal mixed agenda / OG Full / Fit to window**. Select one scenario and target for a focused baseline/working-copy pair, or open an on-demand overview of the selected scenario across exactly these four targets:

| Target | Native canvas |
| --- | --- |
| OG Full | 800 x 480 |
| X / v2 Full | 1872 x 1404 |
| X / v2 Half-horizontal | 1872 x 1404, with the production split wrapper |
| X / v2 Half-vertical | 1872 x 1404, with the production split wrapper |

This four-target interactive subset is intentional. For native-capacity or all-placement claims, use the existing [adaptive rendering checks](#adaptive-production-views), which cover all six device/placement combinations.

Fit-to-window scales the completed native documents only. **100% (scroll)** exposes their unscaled native dimensions with scrolling; neither option changes wrapping, event admission, or fitting. X retains the framework's native 1.8 transform, not an additional browser-density scale. Every side/target is a separately sandboxed document. In an overview taller than the window, scroll through the four pairs to finish fitting them; offscreen previews remain explicitly pending rather than failing because the browser pauses their animation frames. Readiness timeouts pause while previews or the browser tab are not visible.

Saving a `display\src\*.liquid` template refreshes only working-copy presentation. Saving a scenario refreshes both sides with exactly the same current normalized payload. Scenario/target selections are retained. After warm startup, a selected template- or scenario-save comparison must finish within **five seconds**, including required font loading and both production readiness signals; initial setup/startup, overview loading, and on-demand checks are separate. Loading, disconnected updates, invalid inputs, rendering/asset failures, and readiness timeouts are visibly different from ready; an old successful render is never presented as the latest success.

**Check layout** runs the shared browser assertions on the currently displayed ready documents. Results identify target, side, and concrete clipping, readability, overlap, native-dimension, count/overflow, source-state, or admission failures. An edit invalidates old check results. These are on-demand invariant checks, not screenshot equality or visual approval; comparative optional-location and raster-ink coverage remains in the automated harness.

### Authoring agenda scenarios

Copy a readable file such as `display\scenarios\normal-mixed.json`, give it a lowercase kebab-case filename, and set its matching `id`. Each file has exactly `id`, `name`, `description`, and `agenda`. The `agenda` value follows the [version-1 normalized contract](docs/agenda-contract.md#result), including supplied working-day labels, complete counts, timed or date-only occurrences, fixed `generated_at` reference time, original `source_succeeded_at`, and current/stale/error state. Invalid JSON, field types, timing, or inconsistent source states produce filename/field diagnostics, not an empty agenda. Error scenarios may have no source-success timestamp; current/stale scenarios may not invent or omit one.

The catalogue covers normal timed/all-day mixes, multiday ranges, all empty-day combinations, dense agendas and bounded-row overflow, optional locations, long/unusual text, midnight/offset/working-day examples, and freshness/errors. It is presentation data only: it does **not** parse feeds, expand recurrence, apply exclusions, select working days, or exercise cache/refresh transitions. Those remain covered by the existing source/HTTP tests. Commit synthetic inputs only, never private calendar content.

For focused browser and display checks:

```powershell
dotnet test .\tests\CalendarAgenda.Tests\CalendarAgenda.Tests.csproj --no-restore --nologo --verbosity minimal --filter "FullyQualifiedName~WorkbenchTests|FullyQualifiedName~DisplayTests"
```

Workbench checks launch the public process in disposable Git/input workspaces and use real Chromium. Warm template/scenario-save measurements are saved to ignored `artifacts\workbench-latency.json`; all eight selected-target measurements must be at most 5,000 ms. The shared catalogue also runs through the native display matrix, including both OG half placements that are intentionally absent from the interactive workbench. Use the authoritative `scripts\validate.ps1` Fast/Full scopes for normal validation; nothing runs the full suite on every save.

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
