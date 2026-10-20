# Agenda HTTP and display contract, version 1

The agenda module's public interface is `POST /api/agenda`, with function-scoped Azure authentication using the `x-functions-key` header. Host authentication failures are rejected, not encoded as calendar data. The application does not implement a competing key check. Local test hosting does not establish Azure authentication behavior.

## Request

```json
{"rules_json":"[]"}
```

`rules_json` is a **required string containing the user's JSON rule array**, not an interpolated JSON fragment. The private plugin's production polling body is:

```liquid
{"rules_json": {{ rules_json | json }}}
```

This deliberately preserves quotes, newlines, and malformed edited text for validation at the HTTP interface. The request must be an object with exactly this one required string field. Missing fields, nulls, duplicate/unknown fields, malformed outer or inner JSON (including invalid Unicode escapes), and non-array rule configuration are `configuration_invalid`. The entire UTF-8 request is limited to 16 KiB, inclusive, and both JSON documents have a maximum nesting depth of 16. There is no implicit default or old-rules fallback.

The one source URL is secret runtime configuration `Agenda__SourceUrl`, never an HTTP input, display setting, query parameter, or result field.

### Exclusion rules

The native editable code-style TRMNL field seeds this JSON:

```json
[
  {"field":"title","mode":"whole_word","value":"OOF"},
  {"field":"title","mode":"whole_word","value":"OOO"},
  {"field":"title","mode":"starts_with","value":"working from"},
  {"field":"title","mode":"starts_with","value":"Following: "}
]
```

Every rule is an object with exactly three required string fields: `field`, `mode`, and `value`. Field and mode names are case-sensitive identifiers. Only `title` is supported; description, participant, and location fields are not active features. Supported modes are:

| Mode | Literal comparison |
|---|---|
| `whole_word` | Find the value with word boundaries on both sides. Letters, numbers, and combining marks continue a word; whitespace and punctuation, including underscores, separate words. `(OOO)`, `OOO/PTO`, and `OOF_holiday` match the defaults; `OOOps` and `Proofreading session` do not. |
| `starts_with` | Match only the beginning of the title. The working from default does not exclude a policy discussion mentioning working from later. The `"Following: "` value includes the literal trailing space, so `Following:Roadmap` is not excluded. |
| `contains` | Find the literal value anywhere in the title, including the middle. Regex metacharacters are ordinary text, not patterns. |

All comparisons use culture-independent ordinal case-insensitive matching. Source titles are not trimmed or rewritten for evaluation or display, and leading/trailing whitespace in rule values is preserved. A value must be a valid, nonempty, non-whitespace-only string. Quotes, newlines, and punctuation within a literal are data, not expressions. A missing source title is not inferred from descriptions, locations, participants, or the display's `(Untitled)` placeholder.

Validate the **complete** configuration before source acquisition or exclusion evaluation. Malformed rules, duplicate/unknown rule properties, unsupported fields/modes, non-string values, and empty/whitespace-only values reject the whole request as `configuration_invalid`; no valid prefix of the array is evaluated. Regex/executable modes and arbitrary Boolean expressions are unsupported.

Any matching rule excludes the resolved occurrence. Counts are computed only after occurrence interpretation, exclusion, and ended-event removal, including every selected date an occurrence overlaps. Excluded occurrences, rules, descriptions, attendees, source credentials, and raw source identifiers are not included in results or diagnostics.

A deliberately valid empty array (`[]`, with optional JSON whitespace) means **no exclusions**. Missing or malformed configuration is an error even after a previous valid poll; it never reuses old rules or substitutes the editor defaults. Every poll uses its current `rules_json`, so valid edits take effect without changing the adapter or its deployment. Defaults belong only to the native settings field, not the HTTP handler.

## Result

Authorized, completed polls return HTTP 200 and `application/json`, with `Cache-Control: no-store`. HTTP transport success does **not** mean calendar success; consumers must inspect `state`.

```json
{
  "schema_version": 1,
  "state": "current",
  "time_zone": "America/Los_Angeles",
  "generated_at": "2026-10-23T18:00:00+00:00",
  "source_succeeded_at": "2026-10-23T18:00:00+00:00",
  "primary": {
    "date": "2026-10-23",
    "label": "Friday, Oct 23",
    "eligible_total": 1,
    "occurrences": [{
      "time_kind": "timed",
      "id": "opaque-occurrence-identifier",
      "title": "Synthetic planning",
      "location": "Studio A",
      "start_at": "2026-10-23T18:00:00+00:00",
      "end_at": "2026-10-23T19:00:00+00:00"
    }]
  },
  "secondary": {
    "date": "2026-10-26",
    "label": "Monday, Oct 26",
    "eligible_total": 0,
    "occurrences": []
  },
  "error": null
}
```

`AgendaResult.cs` is the shared C# model; wire names are snake_case and states are lowercase strings.

| Field | Meaning |
|---|---|
| `schema_version` | Integer `1`; incompatible shape changes require a new version. |
| `state` | `current`, `stale`, or `error`. Never infer health from empty arrays. |
| `time_zone` | IANA timezone for date selection and display; version 1 uses `America/Los_Angeles`. |
| `generated_at` | UTC instant when this agenda result was evaluated, not the source freshness clock. |
| `source_succeeded_at` | UTC instant of the latest known successful fetch **and supported interpretation**, persisted with the last-good source. Null when unavailable. Storage reads, failed checks, stale HTTP responses, and rendering must not renew it. |
| `primary`, `secondary` | The selected dates and their complete eligible totals/ordered occurrences. |
| `error` | Null for current data; otherwise `{ "code": "...", "message": "..." }` with a safe, renderable explanation, never raw exception/source/rule text. |

### Days and occurrences

The primary day is the first Monday-Friday date on or after the Los Angeles current date; the secondary day is the following working day. Holidays are ordinary weekdays. An empty primary day never moves the window.

Each day has ISO date-only `date`, a literal weekday/date `label` (not misleading today/tomorrow aliases), nullable integer `eligible_total`, and `occurrences`. Current and stale totals are complete **after** supported calendar selection, current exclusions, and current time filtering, not the visible row count. An occurrence overlapping both selected local dates appears and counts on each; its end is exclusive. Overnight timing is not clipped or rewritten to midnight. A timed occurrence disappears at `end_at <= now`, including ongoing occurrences only while their end is still ahead.

Each occurrence has an opaque `id`, `title`, optional/null `location`, and a `time_kind` discriminator. Descriptions, attendees, source URL, raw UID, and rule contents are absent. IDs distinguish occurrences; consumers must not decode them. The implementation hashes the parser's UID and resolved UTC start for timed occurrences, or its date-only start for all-day occurrences. It uses Ical.Net's normalization and occurrence evaluation, not a separate hand-written RFC parser.

- **`timed`:** UTC offset-bearing `start_at` and `end_at`, with end strictly after start. There are no all-day date fields. Explicit DTSTART/DTEND or DTSTART/DURATION are interpreted by Ical.Net. UTC, ordinary IANA timezone IDs, and verified Outlook Windows timezone identifiers are supported; floating/unknown zones are explicit compatibility errors.
- **`all_day`:** ISO date-only `start_date` and `end_date_exclusive`, with no timed instant fields. An all-day range is `[start_date, end_date_exclusive)` and must never be reinterpreted as midnight instants. Without an explicit end/duration, Ical.Net supplies the implicit one-day range. A multiday occurrence appears and counts once on each selected date in its range, never on its exclusive end date. The display labels it `All day`.

Ical.Net stays at **5.2.3**, with timezone rules from pinned **NodaTime 3.3.5 / embedded TZDB 2026e**. The process-wide resolver first uses Ical's unchanged default lookup. Only an unresolved identifier is eligible for **TimeZoneConverter 8.0.0**'s maintained exact Windows-to-IANA conversion with territory `001`, followed by resolution through the same NodaTime TZDB provider. This covers the public 2026 Canadian Windows IDs with their updated permanent-DST rules without mapping them back to older seasonal Windows IDs. Existing IANA and Windows resolution still uses the default path with current packaged rules. No source-dependent global aliases, fixed offsets, calendar-field rewrites, custom DST interpretation, host Windows/ICU mapping, or runtime data downloads are used. Concurrent sources share only this source-independent resolver and packaged data. Unrecognized IDs, floating times, and custom `VTIMEZONE` IDs absent from these supported resolvers fail the whole source check; embedded observances alone do not establish support.

Within a day, all-day occurrences come first, ordered by start date, exclusive end date, then opaque ID. Timed occurrences follow, ordered by start instant, end instant, then opaque ID. Ordering never changes complete eligible totals.

The installed stable Ical.Net 5.2.3 engine resolves `RRULE`, `RDATE` (dates or explicit periods), and `EXDATE` before time filtering, exclusion evaluation, and counting. Date-only `EXDATE` also follows the library's Outlook-compatible whole-date exclusion behavior. A moved individual instance replaces its original even when either date is outside the selected window. Cancelled overrides remain present during replacement resolution so they suppress originals, including overrides with only `RECURRENCE-ID` and cancellation status. They are omitted from the resulting agenda; a cancelled series suppresses its overrides as well. Equivalent timed recurrence identifiers for timed series are converted by the library into the series' timezone before its wall-time identity lookup.

An attached override normally requires an identifier with the same date-only/timed kind as its series. The narrowly supported Outlook exception is a DATE-only series start with a DATE-TIME identifier at **exact literal wall midnight** in a resolvable, nonfloating zone. Its actual override must have a DATE-only start and explicit end or duration, or be a cancellation with no start, end, or duration. The change cannot have its own `RRULE`, `RDATE`, `EXDATE`, `EXRULE`, or recurrence range. The identifier's original parsed wall value, DATE-TIME kind, and timezone metadata remain intact: stable 5.2.3 suppresses the matching original by wall date and emits the actual DATE-only override once. There is no UTC-to-date conversion, timezone stripping, inferred day/offset, or fabricated master. Nonmidnight identifiers remain unsupported even if they are UTC-equivalent to a local midnight. Unknown/floating zones, timed actual overrides, incomplete active changes, and other identifier-kind mismatches remain explicit errors.

A detached `RECURRENCE-ID` record without its series is supported only as a single explicitly published occurrence: it must supply `DTSTART` and either `DTEND` or `DURATION`, with the identifier's date-only/timed kind matching its start. The attached midnight exception does not apply. This explicit-end requirement also applies to detached all-day records; their date-only ends remain exclusive. The record cannot carry its own `RRULE`, `RDATE`, `EXDATE`, `EXRULE`, or recurrence range. The installed library evaluates the actual start/end, not the identifier's original time, without synthesizing a series or inferring unpublished instances. Multiple complete detached instances may share a UID. Complete cancelled detached records are omitted; incomplete ones, including start-less cancellations, remain explicit errors rather than invented timing or a fabricated master. Attached start-less cancellation and cancelled-series suppression are unchanged.

Duplicate series identifiers or duplicate UID/normalized recurrence-identifier pairs are invalid, not arbitrarily selected revisions or silently omitted instances. Detached timed identifiers are normalized to UTC by the library for duplicate validation, so equivalent UTC, IANA, and Windows-zone identifiers denote the same identity; attached timed-series identifiers retain series-zone normalization for replacement. On a DATE-only series, a DATE identifier and a literal-midnight DATE-TIME identifier on the same wall date denote the same occurrence even when their timezone metadata differ; duplicate records are errors rather than selected revisions. Active detached records sharing a UID and actual start also fail compatibility validation, even with different recurrence identifiers: they cannot safely yield distinct display identities under this contract. Parsed `RECURRENCE-ID` metadata with `RANGE=THISANDFUTURE` is an explicit **whole-source compatibility error**: the verified stable occurrence engine does not cascade that change correctly. Other supplied recurrence ranges and deprecated `EXRULE` also remain unsupported. No guessed, duplicate, or partial current agenda is returned for these features. Floating or unknown zones in start/end, recurrence dates, exclusions, or identifiers are compatibility errors rather than host-timezone defaults. Invalid parsed recurrence dates and bounded-evaluation failures cannot establish source success.

Non-published calendar methods, non-Gregorian scales, conflicting event properties, and invalid intervals are not accepted as healthy data.

### States and errors

- **`current`:** Supported source interpretation succeeded for this poll. `source_succeeded_at` is non-null, `error` is null, and both totals are nonnegative integers. A genuinely empty day has total `0` and an empty array.
- **`stale`:** A failed fresh source check uses last-good **source**, reevaluates the current rules/window/time filtering, and retains its original `source_succeeded_at`. `generated_at` remains this evaluation's time. Totals/occurrences describe that reevaluated source, and `error` explains the failed fresh check. Source-success age must be nonnegative and **strictly less than one hour**; at exactly one hour, with a future-dated snapshot, or with no usable source, return `error`. Repeated stale delivery cannot restart age. Invalid/missing rule configuration never reads the cache or falls back to old/default rules. All six production views show the warning, safe failure explanation, and original source-success date/time, including when the reevaluated agenda is empty.
- **`error`:** Neither date has an authoritative count: both totals are **null**, not `0`, and both occurrence arrays are empty. Dates/labels remain defined. `source_succeeded_at` is null unless a successful source check is known, including an expired retained source or a supported source whose agenda exceeded the response budget or could not be persisted. This known timestamp does not make the result current or authorize cached events.

Last-good persistence retains raw source, a version, a binding to the configured feed, and the source-success instant, not the filtered window/old rules/rendered output. Rejected, timed-out, malformed, and unsupported source checks cannot replace it. A later supported check replaces the snapshot even when its filtered agenda is empty. Cached source is reinterpreted using the same maintained parser, including recurrence, moved/cancelled instances, and date-only semantics; no independent cache parser or partial-agenda policy is used. A different configured feed cannot receive the previous feed's retained commitments.

Production storage is a private, pre-existing blob container with explicit system-assigned managed-identity access; a process restart does not erase it. `Agenda__CacheServiceUri` and `Agenda__CacheContainer` are Azure runtime settings, not HTTP/plugin fields. The internal file persistence substitute is Development-only. See [setup and container-scoped permissions](../README.md#persistent-source-and-freshness). Persistence/configuration/decoding errors are explicit and redacted, not silently lost resilience.

Current error codes:

| Code | Meaning |
|---|---|
| `configuration_invalid` | Missing, malformed, oversized, duplicate, or unknown request/configuration fields; unsupported exclusion fields/modes or invalid literal values. |
| `source_configuration` | Missing or unsafe runtime source URL. |
| `source_unavailable` | Timeout, transport failure, rejected HTTP status, or redirect. |
| `source_invalid` | Invalid source encoding/calendar/interval/identity, or a source above 2 MiB. |
| `compatibility_unsupported` | Recognized semantics outside the supported subset; no partial result. |
| `agenda_too_large` | The complete serialized current or stale agenda exceeds 95,000 UTF-8 bytes. Return a bounded error, never a silently shortened agenda. |
| `cache_configuration` | Missing/unsafe persistent-storage runtime settings; no storage credentials or local production fallback are accepted. |
| `cache_unavailable` | Persistent source could not be read or written, including access/authentication/timeout failures. |
| `cache_invalid` | Stored source envelope is malformed, unsupported, oversized, or missing required information. |

Codes are extensible safe strings; consumers display the message/code and must not treat an unknown error as current or empty. Configuration errors are not source failures eligible for old-rules fallback. Only a supported fresh source interpretation can advance the source-success clock.

## Display ownership

The display consumes this result and the platform's view context. It does not select dates, reevaluate exclusions, drop ended meetings, reorder occurrences, or change totals. OG and X each support full-screen, half-horizontal, and half-vertical placements using actual native dimensions, not model-specific row limits. Selected labels/dates remain authoritative: Friday/Monday and weekend Monday/Tuesday windows are not renamed tomorrow, and empty selected days remain explicitly empty.

Reserve primary and secondary labels/complete counts, source-success information, and primary overflow before admitting ordered primary rows. Secondary details use only space left after the supplied primary rows fit; optional locations are admitted last and never reduce the essential visible row count. Timed entries retain readable 21px logical start-end AM/PM labels and titles. All-day entries use `time_kind` to render `All day` without accessing or inventing timed instants. Long titles may be clamped to two readable lines and locations elided or removed; neither can clip mandatory information. Descriptions and attendees are never rendered.

Overflow is `eligible_total - visible_rows`, not supplied-array length minus visible rows. Synthetic bounded-row fixtures exercise totals larger than the supplied array without changing the current adapter's 95,000-byte policy: it still returns `agenda_too_large` instead of silently truncating. Any future producer-side bounding must preserve these complete totals and ordered occurrence identities.

TRMNL prepends `shared.liquid` to the selected `full.liquid`, `half_horizontal.liquid`, or `half_vertical.liquid` template. Shared content captures the common markup/fitter once; `display\render.rb` uses that exact production template sequence with `TRMNL::Liquid`. Only the local preview adds the native screen/mashup shell. Framework CSS, JavaScript, and fonts are pinned to real version 3.4.3, not test approximations. OG's physical canvas is 800 x 480; X uses native `screen--v2` with a 1040 x 780 logical canvas transformed by 1.8 to 1872 x 1404 physical pixels. Native padding/gaps reduce usable full/split view bounds, as documented in the README.

Fitting responds to actual view geometry and font readiness, completes synchronously before the framework publishes capture readiness, and reruns after dimension changes. Browser tests observe the native readiness signal itself as well as the display's `data-agenda-ready` signal, assert physical screenshot dimensions and raster ink at required-text positions, and check text ranges against clipping ancestors and essential rows against overlap in every placement. Current/empty, stale, configuration errors, source/compatibility errors, and other safe errors remain distinguishable. Unknown error codes are displayed, not treated as healthy empty data. A null `source_succeeded_at` produces an explicit absence of source success; rendering never substitutes `generated_at` or the current clock. Cache production/expiry remains outside display ownership.

Calendar text is escaped as HTML/data attributes and time formatting assigns `textContent`; calendar text never becomes executable markup. Times and source-success labels are formatted with the named Los Angeles timezone and a 12-hour AM/PM clock.

## Activation evidence

The [Azure delivery runbook](azure-delivery.md) defines deployment, secret/identity configuration, key rotation, bounded telemetry/storage, redacted smoke tooling and the live acceptance checklist. The smoke tool measures the complete native single-URL polling object in serialized UTF-8, with a strict 100,000-byte limit and a ten-second deadline per attempt with at most one transport retry. A rescued slow first attempt still fails the latency check. Authorized renderable calendar errors remain different from authentication rejection and fresh source success.

Synthetic HTTP/results/rendering checks, local Core Tools, compiled infrastructure and ARM what-if are not evidence of Azure key enforcement, production managed-identity access, private-feed compatibility or actual private-device delivery. Missing owner access or a controlled deployed source-failure path remains an explicit live gate, not a healthy fallback.
