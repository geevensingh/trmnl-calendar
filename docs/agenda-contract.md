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

This deliberately preserves quotes, newlines, and malformed edited text for validation at the HTTP interface. The basic slice requires an object with exactly this one field and an intentionally empty array inside the string. Missing fields, nulls, duplicate/unknown fields, malformed outer or inner JSON, and non-array rule configuration are `configuration_invalid`; a nonempty array is `configuration_unsupported`. There is no implicit default or old-rules fallback. The exclusion slice can extend validation/evaluation of that same string without replacing transport.

The one source URL is secret runtime configuration `Agenda__SourceUrl`, never an HTTP input, display setting, query parameter, or result field.

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

Each day has ISO date-only `date`, a literal weekday/date `label` (not misleading today/tomorrow aliases), nullable integer `eligible_total`, and `occurrences`. Current totals are complete **after** supported calendar selection and time filtering, not the visible row count. An occurrence overlapping both selected local dates appears and counts on each; its end is exclusive. Overnight timing is not clipped or rewritten to midnight. A timed occurrence disappears at `end_at <= now`, including ongoing occurrences only while their end is still ahead.

Each occurrence has an opaque `id`, `title`, optional/null `location`, and a `time_kind` discriminator. Descriptions, attendees, source URL, raw UID, and rule contents are absent. IDs distinguish occurrences; consumers must not decode them. The basic implementation hashes the parser's UID and UTC start. It uses Ical.Net's normalization, not a separate hand-written RFC parser.

- **`timed`:** UTC offset-bearing `start_at` and `end_at`, with end strictly after start. There are no all-day date fields. Explicit DTSTART/DTEND or DTSTART/DURATION are interpreted by Ical.Net. UTC, ordinary IANA timezone IDs, and verified Outlook Windows timezone identifiers are supported; floating/unknown zones are explicit compatibility errors.
- **Reserved `all_day`:** ISO date-only `start_date` and `end_date_exclusive`, with no timed instant fields. An all-day range is `[start_date, end_date_exclusive)` and must never be reinterpreted as midnight instants. `AllDayOccurrence` reserves this shape but the basic emitter/view does not support all-day behavior.

Within a day, timed occurrences are ordered by start instant, end instant, then opaque ID. Future all-day/recurrence work owns its selection and mixed-kind ordering while preserving complete totals and unambiguous timing. Nonrecurring cancelled events are omitted. RRULE, RDATE, EXRULE, EXDATE, and RECURRENCE-ID (including parsed RANGE metadata) are rejected for the **entire source** until the recurrence slice; they cannot yield guessed or partial current data. Non-published calendar methods, non-Gregorian scales, duplicate nonrecurring identifiers, and invalid intervals are not accepted as healthy data.

### States and errors

- **`current`:** Supported source interpretation succeeded for this poll. `source_succeeded_at` is non-null, `error` is null, and both totals are nonnegative integers. A genuinely empty day has total `0` and an empty array.
- **Reserved `stale`:** A follow-on cache slice may use last-good **source**, reevaluate the current rules/window/time filtering, and retain its original `source_succeeded_at`. `generated_at` remains this evaluation's time. Totals/occurrences still describe that reevaluated source, and `error` explains the failed fresh check. It is eligible only while source-success age is strictly less than one hour; at one hour or with no usable source, return `error`. Invalid configuration never falls back to old rules. This slice emits no stale responses and its basic view does not claim stale data is current.
- **`error`:** Neither date has an authoritative count: both totals are **null**, not `0`, and both occurrence arrays are empty. Dates/labels remain defined. `source_succeeded_at` is null unless a successful source check is known (for example, the source parsed successfully but its complete agenda exceeded the response budget). The no-cache basic slice never invents an earlier success.

Current error codes:

| Code | Meaning |
|---|---|
| `configuration_invalid` | Missing, malformed, oversized, duplicate, or unknown request/configuration fields. |
| `configuration_unsupported` | Nonempty exclusions are not yet supported. |
| `source_configuration` | Missing or unsafe runtime source URL. |
| `source_unavailable` | Timeout, transport failure, rejected HTTP status, or redirect. |
| `source_invalid` | Invalid source encoding/calendar/interval/identity, or a source above 2 MiB. |
| `compatibility_unsupported` | Recognized semantics outside the supported subset; no partial result. |
| `agenda_too_large` | The complete serialized current agenda exceeds 95,000 UTF-8 bytes. Return a bounded error, never a silently shortened agenda. |

Codes are extensible safe strings; consumers display the message/code and must not treat an unknown error as current or empty. The later cache implementation must distinguish configuration errors from source/compatibility failures and preserve the source-success clock.

## Display ownership

The display consumes this result and the platform's view context. It does not select dates, reevaluate exclusions, drop ended meetings, or change totals. This slice supports only full-screen OG. It uses the platform-provided view wrapper, literal weekday labels, native 21px event titles/time labels, native clamping/table overflow, primary-day priority, secondary label/count, and an always-present source-check date/time or explicit absence of a successful check. Location is reserved in the response but omitted in this basic view.

TRMNL prepends `shared.liquid` to `full.liquid`; `display\render.rb` uses that exact production template sequence with `TRMNL::Liquid`, not a second rendering algorithm. Only the local preview adds the platform shell. CSS/JavaScript/fonts are the real pinned framework, not test approximations. Readiness and physical bounds are checked in a browser, including truthful overflow for a crowded OG view. Adaptive six-layout behavior and persistent stale rendering remain follow-on work.

Calendar text is escaped as HTML/data attributes and time formatting assigns `textContent`; calendar text never becomes executable markup. Times and source-success labels are formatted with the named Los Angeles timezone and a 12-hour AM/PM clock.
