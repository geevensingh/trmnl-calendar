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
| `state` | `current`, reserved `stale`, or `error`. Never infer health from empty arrays. |
| `time_zone` | IANA timezone for date selection and display; version 1 uses `America/Los_Angeles`. |
| `generated_at` | UTC instant when this agenda result was evaluated, not the source freshness clock. |
| `source_succeeded_at` | UTC instant of the latest known successful fetch **and supported interpretation**. Null when unavailable. Rendering/retrying an error must not renew it. |
| `primary`, `secondary` | The selected dates and their complete eligible totals/ordered occurrences. |
| `error` | Null for current data; otherwise `{ "code": "...", "message": "..." }` with a safe, renderable explanation, never raw exception/source/rule text. |

### Days and occurrences

The primary day is the first Monday-Friday date on or after the Los Angeles current date; the secondary day is the following working day. Holidays are ordinary weekdays. An empty primary day never moves the window.

Each day has ISO date-only `date`, a literal weekday/date `label` (not misleading today/tomorrow aliases), nullable integer `eligible_total`, and `occurrences`. Current totals are complete **after** supported calendar selection, exclusions, and time filtering, not the visible row count. An occurrence overlapping both selected local dates appears and counts on each; its end is exclusive. Overnight timing is not clipped or rewritten to midnight. A timed occurrence disappears at `end_at <= now`, including ongoing occurrences only while their end is still ahead.

Each occurrence has an opaque `id`, `title`, optional/null `location`, and a `time_kind` discriminator. Descriptions, attendees, source URL, raw UID, and rule contents are absent. IDs distinguish occurrences; consumers must not decode them. The implementation hashes the parser's UID and resolved UTC start for timed occurrences, or its date-only start for all-day occurrences. It uses Ical.Net's normalization and occurrence evaluation, not a separate hand-written RFC parser.

- **`timed`:** UTC offset-bearing `start_at` and `end_at`, with end strictly after start. There are no all-day date fields. Explicit DTSTART/DTEND or DTSTART/DURATION are interpreted by Ical.Net. UTC, ordinary IANA timezone IDs, and verified Outlook Windows timezone identifiers are supported; floating/unknown zones are explicit compatibility errors.
- **`all_day`:** ISO date-only `start_date` and `end_date_exclusive`, with no timed instant fields. An all-day range is `[start_date, end_date_exclusive)` and must never be reinterpreted as midnight instants. Without an explicit end/duration, Ical.Net supplies the implicit one-day range. A multiday occurrence appears and counts once on each selected date in its range, never on its exclusive end date. The display labels it `All day`.

Within a day, all-day occurrences come first, ordered by start date, exclusive end date, then opaque ID. Timed occurrences follow, ordered by start instant, end instant, then opaque ID. Ordering never changes complete eligible totals.

The installed stable Ical.Net 5.2.3 engine resolves `RRULE`, `RDATE` (dates or explicit periods), and `EXDATE` before time filtering, exclusion evaluation, and counting. Date-only `EXDATE` also follows the library's Outlook-compatible whole-date exclusion behavior. A moved individual instance replaces its original even when either date is outside the selected window. Cancelled overrides remain present during replacement resolution so they suppress originals, including overrides with only `RECURRENCE-ID` and cancellation status. They are omitted from the resulting agenda; a cancelled series suppresses its overrides as well. Equivalent timed recurrence identifiers are converted by the library into the series' timezone before its wall-time identity lookup.

An override requires its series and an identifier with the same date-only/timed kind as that series. Duplicate series identifiers or duplicate UID/normalized recurrence-identifier pairs are invalid, not arbitrarily selected revisions. Parsed `RECURRENCE-ID` metadata with `RANGE=THISANDFUTURE` is an explicit **whole-source compatibility error**: the verified stable occurrence engine does not cascade that change correctly. Other supplied recurrence ranges and deprecated `EXRULE` also remain unsupported. No guessed, duplicate, or partial current agenda is returned for these features. Floating or unknown zones in start/end, recurrence dates, exclusions, or identifiers are compatibility errors rather than host-timezone defaults. Invalid parsed recurrence dates and bounded-evaluation failures cannot establish source success.

Non-published calendar methods, non-Gregorian scales, conflicting event properties, and invalid intervals are not accepted as healthy data.

### States and errors

- **`current`:** Supported source interpretation succeeded for this poll. `source_succeeded_at` is non-null, `error` is null, and both totals are nonnegative integers. A genuinely empty day has total `0` and an empty array.
- **Reserved `stale`:** A follow-on cache slice may use last-good **source**, reevaluate the current rules/window/time filtering, and retain its original `source_succeeded_at`. `generated_at` remains this evaluation's time. Totals/occurrences still describe that reevaluated source, and `error` explains the failed fresh check. It is eligible only while source-success age is strictly less than one hour; at one hour or with no usable source, return `error`. Invalid configuration never falls back to old rules. This slice emits no stale responses and its basic view does not claim stale data is current.
- **`error`:** Neither date has an authoritative count: both totals are **null**, not `0`, and both occurrence arrays are empty. Dates/labels remain defined. `source_succeeded_at` is null unless a successful source check is known (for example, the source parsed successfully but its complete agenda exceeded the response budget). The no-cache basic slice never invents an earlier success.

Current error codes:

| Code | Meaning |
|---|---|
| `configuration_invalid` | Missing, malformed, oversized, duplicate, or unknown request/configuration fields; unsupported exclusion fields/modes or invalid literal values. |
| `source_configuration` | Missing or unsafe runtime source URL. |
| `source_unavailable` | Timeout, transport failure, rejected HTTP status, or redirect. |
| `source_invalid` | Invalid source encoding/calendar/interval/identity, or a source above 2 MiB. |
| `compatibility_unsupported` | Recognized semantics outside the supported subset; no partial result. |
| `agenda_too_large` | The complete serialized current agenda exceeds 95,000 UTF-8 bytes. Return a bounded error, never a silently shortened agenda. |

Codes are extensible safe strings; consumers display the message/code and must not treat an unknown error as current or empty. The later cache implementation must distinguish configuration errors from source/compatibility failures and preserve the source-success clock.

## Display ownership

The display consumes this result and the platform's view context. It does not select dates, reevaluate exclusions, drop ended meetings, or change totals. This slice supports only full-screen OG. It uses the platform-provided view wrapper, literal weekday labels, native 21px event titles/time labels, native clamping/table overflow, primary-day priority, secondary label/count, and an always-present source-check date/time or explicit absence of a successful check. All-day entries use the `time_kind` discriminator to render `All day` without accessing or inventing timed instant fields. Location is reserved in the response but omitted in this basic view.

TRMNL prepends `shared.liquid` to `full.liquid`; `display\render.rb` uses that exact production template sequence with `TRMNL::Liquid`, not a second rendering algorithm. Only the local preview adds the platform shell. CSS/JavaScript/fonts are the real pinned framework, not test approximations. Readiness and physical bounds are checked in a browser, including truthful overflow for a crowded OG view. Adaptive six-layout behavior and persistent stale rendering remain follow-on work.

Calendar text is escaped as HTML/data attributes and time formatting assigns `textContent`; calendar text never becomes executable markup. Times and source-success labels are formatted with the named Los Angeles timezone and a 12-hour AM/PM clock.
