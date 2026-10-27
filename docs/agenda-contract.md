# Agenda HTTP and display contract, version 2

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

The source URL is secret runtime configuration `Agenda__SourceUrl`, never an HTTP input, display setting, query parameter, or result field. The owner identity used for participation expectation is adapter-side runtime configuration `Agenda__OwnerAddress`, an exact `mailto:` address from the calendar. It is not a request field or result field; address aliases are not inferred.

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

Validate the **complete** configuration before reading cached source/outcome or evaluating exclusions. HTTP does not acquire source; scheduled refresh is independent of plugin rules and validates source with the same real supported-semantics parser before retaining it. Malformed rules, duplicate/unknown rule properties, unsupported fields/modes, non-string values, and empty/whitespace-only values reject the whole HTTP request as `configuration_invalid`; no valid prefix is evaluated. Regex/executable modes and arbitrary Boolean expressions are unsupported.

Any matching rule excludes the resolved occurrence. Counts are computed only after occurrence interpretation, exclusion, and ended-event removal, including every selected date an occurrence overlaps. Excluded occurrences, rules, descriptions, attendees, source credentials, and raw source identifiers are not included in results or diagnostics.

A deliberately valid empty array (`[]`, with optional JSON whitespace) means **no exclusions**. Missing or malformed configuration is an error even after a previous valid poll; it never reuses old rules or substitutes the editor defaults. Every poll uses its current `rules_json`, so valid edits take effect without changing the adapter or its deployment. Defaults belong only to the native settings field, not the HTTP handler.

## Result

Authorized, completed polls return HTTP 200 and `application/json`, with `Cache-Control: no-store`. HTTP transport success does **not** mean calendar success; consumers must inspect `state`.

```json
{
  "schema_version": 2,
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
      "participation_expectation": "likely",
      "location": "Studio A",
      "emphasis": "in_progress",
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
| `schema_version` | Integer `2`; incompatible shape changes require a new version. |
| `state` | `current`, `stale`, or `error`. Never infer health from empty arrays. |
| `time_zone` | IANA timezone for date selection and display; version 2 uses `America/Los_Angeles`. |
| `generated_at` | UTC instant when this agenda result was evaluated, not the source freshness clock. |
| `source_succeeded_at` | UTC instant of the latest known successful fetch **and supported interpretation**, persisted with the last-good source. Null when unavailable. Storage reads, failed checks, stale HTTP responses, and rendering must not renew it. |
| `primary`, `secondary` | The selected dates and their complete eligible totals/ordered occurrences. |
| `error` | Null for current data; otherwise `{ "code": "...", "message": "..." }` with a safe, renderable explanation, never raw exception/source/rule text. |

### Days and occurrences

The primary day is the first Monday-Friday date on or after the Los Angeles current date; the secondary day is the following working day. Holidays are ordinary weekdays. An empty primary day never moves the window.

Each day has ISO date-only `date`, a literal weekday/date `label` (not misleading today/tomorrow aliases), nullable integer `eligible_total`, and `occurrences`. Current and stale totals are complete **after** supported calendar selection, current exclusions, and current time filtering, not the visible row count. An occurrence overlapping both selected local dates appears and counts on each; its end is exclusive. Overnight timing is not clipped or rewritten to midnight. A timed occurrence disappears at `end_at <= now`, including ongoing occurrences only while their end is still ahead.

Each occurrence has an opaque `id`, `title`, required `participation_expectation`, optional/null `location`, and a `time_kind` discriminator. The expectation is one of `definite`, `likely`, `maybe`, `unlikely`, or `unknown`; `unknown` means there is insufficient owner-specific evidence, not the lowest likelihood. Descriptions, attendees, organizer addresses, source URL, raw UID, and rule contents are absent. IDs distinguish occurrences; consumers must not decode them. The implementation hashes the parser's UID and resolved UTC start for timed occurrences, or its date-only start for all-day occurrences. It uses Ical.Net's normalization and occurrence evaluation, not a separate hand-written RFC parser.

Timed occurrences may also carry optional `emphasis`; this is independent of participation expectation. The producer, strict validators, and renderer use version 2 with required participation values; version-1 payloads are incompatible. The workbench requires matching version-2 baseline contracts and framework pins rather than substituting a different baseline.

Participation expectation uses the following precedence on the effective event occurrence:

| Evidence | Expectation |
|---|---|
| Explicit transparent (`TRANSP:TRANSPARENT`), a recognized `Following: ` title marker, or the calendar owner's declined response | `unlikely` |
| Otherwise, the configured calendar owner is the organizer | `definite` |
| Otherwise, the configured owner's response is accepted | `likely` |
| Otherwise, the configured owner's response is tentative or the owner's attendee entry is unanswered | `maybe` |
| Otherwise, including missing owner identity, unmatched/ambiguous owner attendees, or insufficient evidence | `unknown` |

Free/transparent, followed, and declined evidence outranks organizer role and acceptance. Only an explicitly supplied transparent property is evidence of Free; an absent transparency property is not. A `Following: ` marker follows the existing exact title-prefix convention and the default exclusion remains unchanged; a matching event gets a label only if other rules leave it eligible. An owner attendee entry with no response is positively established unanswered evidence; absence of the owner attendee is not. Event-level `STATUS:TENTATIVE` is distinct from the owner's `PARTSTAT` and does not imply `maybe`. Exact address matching uses only the configured `mailto:` address; it does not use attendee order, display names, titles, or guessed aliases. If owner identity is absent or invalid, only independently supported low-participation evidence can classify an event; otherwise it is `unknown`.

The protected source preflight reports only allowlisted booleans for whether the configured owner identity and matching organizer/attendee/response signals, transparent events, and the followed title marker were observed. It does not print addresses or calendar content. These observations are not a guarantee that every event carries the relevant metadata; actual publication capability remains an owner-authorized evidence gate.

- **`timed`:** UTC offset-bearing `start_at` and `end_at`, with end strictly after start. There are no all-day date fields. Optional `emphasis` is `in_progress` or `upcoming`, assigned by the adapter against the same `generated_at` instant. Every eligible timed event with `start_at <= generated_at < end_at` is `in_progress`. If none is in progress, only the earliest future start-time group is `upcoming`, and only when its start is no more than 15 minutes after `generated_at`, inclusive. Exclusions and ended-event filtering precede classification; all-day occurrences never receive emphasis. Explicit DTSTART/DTEND or DTSTART/DURATION are interpreted by Ical.Net. UTC, ordinary IANA timezone IDs, and verified Outlook Windows timezone identifiers are supported; floating/unknown zones are explicit compatibility errors.
- **`all_day`:** ISO date-only `start_date` and `end_date_exclusive`, with no timed instant fields. An all-day range is `[start_date, end_date_exclusive)` and must never be reinterpreted as midnight instants. Without an explicit end/duration, Ical.Net supplies the implicit one-day range. A multiday occurrence appears and counts once on each selected date in its range, never on its exclusive end date. The display labels it `All day`.

Ical.Net stays at **5.2.3**, with timezone rules from pinned **NodaTime 3.3.5 / embedded TZDB 2026e**. The process-wide resolver first uses Ical's unchanged default lookup. Only an unresolved identifier is eligible for **TimeZoneConverter 8.0.0**'s maintained exact Windows-to-IANA conversion with territory `001`, followed by resolution through the same NodaTime TZDB provider. This covers the public 2026 Canadian Windows IDs with their updated permanent-DST rules without mapping them back to older seasonal Windows IDs. Existing IANA and Windows resolution still uses the default path with current packaged rules. No source-dependent global aliases, fixed offsets, calendar-field rewrites, custom DST interpretation, host Windows/ICU mapping, or runtime data downloads are used. Concurrent sources share only this source-independent resolver and packaged data. Unrecognized IDs, floating times, and custom `VTIMEZONE` IDs absent from these supported resolvers fail the whole source check; embedded observances alone do not establish support.

Within a day, all-day occurrences come first, ordered by start date, exclusive end date, then opaque ID. Timed occurrences follow, ordered by start instant, end instant, then opaque ID. Emphasis never changes this order or complete eligible totals.

The installed stable Ical.Net 5.2.3 engine resolves `RRULE`, `RDATE` (dates or explicit periods), and `EXDATE` before time filtering, exclusion evaluation, and counting. Date-only `EXDATE` also follows the library's Outlook-compatible whole-date exclusion behavior. A moved individual instance replaces its original even when either date is outside the selected window. Cancelled overrides remain present during replacement resolution so they suppress originals, including overrides with only `RECURRENCE-ID` and cancellation status. They are omitted from the resulting agenda; a cancelled series suppresses its overrides as well. Equivalent timed recurrence identifiers for timed series are converted by the library into the series' timezone before its wall-time identity lookup.

An attached override normally requires an identifier with the same date-only/timed kind as its series. The narrowly supported Outlook exception is a DATE-only series start with a DATE-TIME identifier at **exact literal wall midnight** in a resolvable, nonfloating zone. Its actual override must have a DATE-only start and explicit end or duration, or be a cancellation with no start, end, or duration. The change cannot have its own `RRULE`, `RDATE`, `EXDATE`, `EXRULE`, or recurrence range. The identifier's original parsed wall value, DATE-TIME kind, and timezone metadata remain intact: stable 5.2.3 suppresses the matching original by wall date and emits the actual DATE-only override once. There is no UTC-to-date conversion, timezone stripping, inferred day/offset, or fabricated master. Nonmidnight identifiers remain unsupported even if they are UTC-equivalent to a local midnight. Unknown/floating zones, timed actual overrides, incomplete active changes, and other identifier-kind mismatches remain explicit errors.

A detached `RECURRENCE-ID` record without its series is supported only as a single explicitly published occurrence: it must supply `DTSTART` and either `DTEND` or `DURATION`, with the identifier's date-only/timed kind matching its start. The attached midnight exception does not apply. This explicit-end requirement also applies to detached all-day records; their date-only ends remain exclusive. The record cannot carry its own `RRULE`, `RDATE`, `EXDATE`, `EXRULE`, or recurrence range. The installed library evaluates the actual start/end, not the identifier's original time, without synthesizing a series or inferring unpublished instances. Multiple complete detached instances may share a UID. Complete cancelled detached records are omitted; incomplete ones, including start-less cancellations, remain explicit errors rather than invented timing or a fabricated master. Attached start-less cancellation and cancelled-series suppression are unchanged.

Duplicate series identifiers or duplicate UID/normalized recurrence-identifier pairs are invalid, not arbitrarily selected revisions or silently omitted instances. Detached timed identifiers are normalized to UTC by the library for duplicate validation, so equivalent UTC, IANA, and Windows-zone identifiers denote the same identity; attached timed-series identifiers retain series-zone normalization for replacement. On a DATE-only series, a DATE identifier and a literal-midnight DATE-TIME identifier on the same wall date denote the same occurrence even when their timezone metadata differ; duplicate records are errors rather than selected revisions. Active detached records sharing a UID and actual start also fail compatibility validation, even with different recurrence identifiers: they cannot safely yield distinct display identities under this contract. Parsed `RECURRENCE-ID` metadata with `RANGE=THISANDFUTURE` is an explicit **whole-source compatibility error**: the verified stable occurrence engine does not cascade that change correctly. Other supplied recurrence ranges and deprecated `EXRULE` also remain unsupported. No guessed, duplicate, or partial current agenda is returned for these features. Floating or unknown zones in start/end, recurrence dates, exclusions, or identifiers are compatibility errors rather than host-timezone defaults. Invalid parsed recurrence dates and bounded-evaluation failures cannot establish source success.

Non-published calendar methods, non-Gregorian scales, conflicting event properties, and invalid intervals are not accepted as healthy data.

### States and errors

- **`current`:** The latest **completed scheduled refresh** succeeded, its persisted outcome matches supported retained source, and original source-success age is nonnegative and **strictly less than 15 minutes**. The current HTTP request reevaluates that raw source with current rules/window/ended filtering; it does not fetch Outlook. `source_succeeded_at` is non-null, `error` is null, and totals are nonnegative integers. A genuinely empty day has total `0` and an empty array. The 15-minute threshold is unchanged by five-minute business-hours refresh.
- **`stale`:** The latest completed refresh failed, no matching completed outcome can certify the source, a refresh/publication is delayed/incomplete, or source success has reached 15 minutes. Reevaluate matching supported last-good **source** and retain its original `source_succeeded_at`; `generated_at` is this evaluation's time. Source-success age must be nonnegative and **strictly less than one hour**; at exactly one hour, with a future-dated snapshot, or without usable source, return `error`. Repeated delivery, reads, rule edits and renders cannot restart age. Invalid/missing rules never read the cache or use old/default rules. All six views show the safe warning and original source-success date/time, including stale empty agendas.
- **`error`:** Neither date has an authoritative count: both totals are **null**, not `0`, and occurrence arrays are empty. Dates/labels remain defined. `source_succeeded_at` is null unless matching persisted source supplies known success, including an expired retained source or a supported persisted source whose evaluated agenda exceeds the response budget. A source check that could not be persisted cannot supply a new timestamp through an HTTP in-memory fallback. A known timestamp does not make the result current or authorize expired commitments. Corrupt/unsafe storage and invalid rules remain explicit errors.

Last-good persistence retains raw source, version, source-URL digest, actual source-success instant and refresh identity/generation, not a filtered window/old rules/rendered output. Rejected, timed-out, malformed and unsupported checks cannot replace it. A later supported scheduled check replaces it even when the filtered agenda is empty. The same maintained parser reinterprets recurrence, moved/cancelled instances and date-only semantics for each HTTP request. Another configured feed cannot borrow its source or successful outcome.

One bounded private `source-refresh-status.json` accompanies `last-good-source.json`. Its version-1 envelope has `SourceKey` (digest only), `RefreshId`, `StartedAt`, `CompletedAt` (supported check/failure processing time), nullable `SourceSucceededAt`/fixed `ErrorCode`/numeric fixed-message `FailureDetail`, durable `Generation`, required `CompletedGeneration`, and a required nullable `Pending` field (`SourceKey`, `RefreshId`, `StartedAt`, `Generation`, `Committing`). It is at most 4 KiB and contains no source text, URLs, rules, credentials, titles or exception messages. The source envelope is version 2 with the original fields plus refresh start/ID/generation. Legacy version 1 accepts exactly its original four fields, not version-2 metadata even with default values; it cannot certify current. Required/unknown/duplicate-field checks apply recursively, including `Pending`, before deserialization; versions, bounds, identities and timestamps are also validated. Status lacking the required completed generation is a storage error until a new supported refresh repairs it, not an inferred success.

`CompletedGeneration` is the generation of the last completed outcome, and stays unchanged when another attempt starts. It equals `Generation` without pending work; with pending work it is strictly less than `Pending.Generation`, which equals the latest allocated `Generation`. Allocation gaps from superseded work are valid. Zero completed generation means no completed outcome (`refresh_missing`), never success. A positive completed identity cannot be reused by the pending attempt, whose start must be at or after the completed outcome's time. To certify current, a version-2 source must match the completed source key, refresh ID, refresh start, source-success time and **exact completed generation** regardless of pending work; merely being older than the pending generation is insufficient. Individually valid but mixed source/outcome pairs are visibly incomplete, not current; malformed or contradictory status is an explicit storage error.

Durable generations are allocated under a short private status-blob lease before acquisition, preserving the last completed outcome and source-success clock. Only the still-owning generation may publish; older success/failure cannot overwrite newer work even with equal clock readings, a source change or process recreation. During acquisition, a valid completed success younger than 15 minutes can remain current. A pending attempt at 35 seconds is delayed. Publication marks its pending attempt `Committing` before replacing source, then atomically publishes the small completed marker only after persistence; partial/racing pairs are visibly incomplete, never current. Failed source acquisition does not write raw source. Missing matching status permits only stale supported source below one hour; corrupt status is an explicit storage error.

Production storage is a private, pre-existing blob container with explicit system-assigned managed-identity access; a process restart does not erase it. `Agenda__CacheServiceUri` and `Agenda__CacheContainer` are Azure runtime settings, not HTTP/plugin fields. The internal file persistence substitute is Development-only. See [setup and container-scoped permissions](../README.md#persistent-source-and-freshness). Persistence/configuration/decoding errors are explicit and redacted, not silently lost resilience.

The single internal `RefreshSource` timer uses UTC NCRONTAB `0 */5 * * * *`, `UseMonitor=true`, `RunOnStartup=false`, and the pinned Los Angeles zone for its gate. Monday-Friday 09:00 inclusive to 18:00 exclusive uses every five-minute tick; otherwise only minutes 00/15/30/45 acquire source. Weekday holidays remain weekdays and DST changes the UTC window. No host-local/fixed-offset scheduling, Linux Flex `WEBSITE_TIME_ZONE`, new scheduling UI or caller-selected source is introduced. Future adjustability is deferred.

Refresh allows 30 seconds for headers plus body inside one 35-second overall cancellation budget, including generation coordination, supported interpretation and persistence; storage does not reset it. Cache-only HTTP retains nine seconds for outbound storage/interpretation and never starts a source fetch/background refresh. The transport remains ten seconds per attempt and at most one retry. These bounds exclude platform initialization/delivery overhead and do not establish ten-second end-to-end cold-path delivery.

Current error codes:

| Code | Meaning |
|---|---|
| `configuration_invalid` | Missing, malformed, oversized, duplicate, or unknown request/configuration fields; unsupported exclusion fields/modes or invalid literal values. |
| `source_configuration` | Missing or unsafe runtime source URL. |
| `source_unavailable` | Timeout, transport failure, rejected HTTP status, or redirect. |
| `source_invalid` | Invalid source encoding/calendar/interval/identity, or a source above 2 MiB. |
| `compatibility_unsupported` | Recognized semantics outside the supported subset; no partial result. |
| `agenda_too_large` | The required metadata envelope alone cannot fit within 95,000 UTF-8 bytes. Ordinary occurrence volume instead uses the bounded admission policy below, retaining complete totals. |
| `cache_configuration` | Missing/unsafe persistent-storage runtime settings; no storage credentials or local production fallback are accepted. |
| `cache_unavailable` | Persistent source could not be read or written, including access/authentication/timeout failures. |
| `cache_invalid` | Stored source envelope is malformed, unsupported, oversized, or missing required information. |
| `refresh_missing` | No matching completed scheduled outcome is available; no good source is an error, usable recent source can only be stale. |
| `refresh_delayed` | Source success reached 15 minutes or a pending refresh reached 35 seconds; stale only below one hour. |
| `refresh_incomplete` | Publication is committing/partial, status changed during the read, or a completed success does not match retained source. |

Codes are extensible safe strings; consumers display the message/code and must not treat an unknown error as current or empty. Configuration errors are not source failures eligible for old-rules fallback. Only an actual supported source check can set source success; HTTP evaluation, reads, status writes and rendering never do. The smoke validator uses native seven-digit timestamp precision at the strict 15-minute/hour boundaries, not rounded millisecond ages.

## Private diagnostics

Owner-approved Azure diagnostics and Copilot investigations may include eligible meeting titles and locations. This is separate from the public HTTP shape and does not permit private calendar contents in Git, GitHub tickets/PRs, local previews, or public log exports. Azure data remains Entra/RBAC-protected; reading it into a Copilot session necessarily brings those selected fields into that conversation.

Each current or stale HTTP result emits one information-level `Agenda poll ` message followed by JSON with `poll_id`, `state`, `generated_at`, `source_succeeded_at`, `primary_date`, `primary_eligible_total`, `secondary_date`, and `secondary_eligible_total`. One `Agenda occurrence ` JSON record per returned day/occurrence includes `poll_id`, `occurrence_id`, `date`, `time_kind`, `start`, `end_exclusive`, `title`, `location`, `title_truncated`, and `location_truncated`. All-day ranges remain date-only; timed ranges retain offset-bearing UTC instants. A multiday occurrence has a record for each selected date on which it appears. Null locations remain null, not an inferred room or online meeting.

Records describe eligible data sent to the consumer after response bounding, **not** which details fit on a device or whether the device refreshed. The request's exclusions and current ended-event cutoff have already run. Summary totals remain complete even when response bounding omits occurrences; omitted occurrences have no meeting records. Errors, including an unrepresentable metadata envelope reported as `agenda_too_large`, retain fixed warning codes without logging unreturned meetings. Current/stale responses with no supplied occurrences have a summary but no meeting records, even when their eligible totals are nonzero.

Each diagnostic title/location is limited to 1,024 UTF-16 code units without splitting a surrogate pair, with explicit truncation flags; this never changes HTTP data. JSON escaping keeps calendar text as single-line data, and each occurrence record is below 14 KiB even at maximum escaping. No raw ICS, source URL, credentials, raw UID, rule text, excluded/ended events, descriptions, attendees, or upstream exceptions enter these records. The Functions host may discard structured logger properties, so the JSON is carried in the formatted message and queried there. Trace telemetry is excluded from adaptive sampling to avoid losing individual meetings within a poll; ingestion failure/caps and device delivery remain separate limitations. See the [runbook](azure-delivery.md#bounded-storage-and-diagnostics) for queries, retention, access, and deployment verification.

## Display ownership

The display consumes this result and the platform's view context. It does not select dates, reevaluate exclusions, drop ended meetings, reorder occurrences, or change totals. OG and X each support full-screen, half-horizontal, and half-vertical placements using actual native dimensions, not model-specific row limits. Selected labels/dates remain authoritative: Friday/Monday and weekend Monday/Tuesday windows are not renamed tomorrow, and empty selected days remain explicitly empty.

Reserve both selected-day headers and absolute source-success information before admitting ordered primary rows. Emphasized timed rows have priority over ordinary rows across both selected days; admitted rows remain in their supplied chronological positions. If not all emphasized rows fit, admit them in chronological order and withhold ordinary rows. Otherwise, ordinary secondary rows use only space left after primary rows. Valid zero-eligible days use one date/`No remaining events` line. Populated-day counts remain beside dates on the left, showing `N events` when complete or `N of M events shown` otherwise, with natural singular/plural grammar. The displayed count is the number of visible details; the eligible total includes occurrences not supplied as rows. Zero displayed rows never imply an empty day. There is no standalone overflow row or footer: source-success metadata is at the right of the primary header in wide views and may use its second line in narrow views. Unavailable presentation retains last-success information or `No successful source check` without fabricating valid days or counts.

Secondary ordinary details use only space left after the supplied primary rows fit; optional locations are admitted last and never reduce the essential visible row count. Counts update during actual-space fitting before native capture readiness and may wrap beside longer dates rather than shrinking required text. Timed entries retain readable start-end AM/PM labels and titles. An emphasized timed event is rendered once as an inverse card with white text, a larger bold title, scheduled time, and the `IN PROGRESS` or `UPCOMING` status; both statuses share the same treatment. All-day entries use `time_kind` to render `All day` without accessing or inventing timed instants. Every displayed event keeps its explicit right-hand participation label, including white text on inverse cards. Titles retain their complete escaped text on one line and yield width with visual end ellipsis rather than hiding the label. Existing event/title/time typography is retained; optional locations may be elided or removed but cannot clip mandatory information. No legend, extra participation badge, meter, or fading is used. Descriptions and attendees are never rendered.

Overflow is `eligible_total - visible_rows`, not supplied-array length minus visible rows. The producer classifies the complete eligible set before constructing a response of at most **95,000 serialized UTF-8 bytes**, including JSON escaping, punctuation, both day headers, complete totals, warnings and original source-success metadata. It reserves that envelope, then admits emphasized occurrences in existing primary/secondary chronological order, followed by ordinary primary and then ordinary secondary occurrences in their existing order. Admission stops at the first occurrence that cannot fit: if that is an emphasized occurrence, no ordinary occurrences are supplied. Thus emphasized-only overflow is a deterministic chronological prefix, even if a later shorter occurrence could fit. An individually oversized occurrence is omitted whole, never shortened; it still counts in `eligible_total`. The admitted arrays are restored to their original day order (all-day before timed). IDs, timing, titles and locations are not rewritten to save bytes. Byte measurement serializes individual occurrences, not an unbounded complete response. Synthetic bounded-row fixtures exercise the same truthful omission contract; ordinary volume is not a whole-agenda error.

TRMNL prepends `shared.liquid` to the selected `full.liquid`, `half_horizontal.liquid`, or `half_vertical.liquid` template. Shared content captures the common markup/fitter once; `display\render.rb` uses that exact production template sequence with `TRMNL::Liquid`. Only the local preview adds the native screen/mashup shell. Framework CSS, JavaScript, and fonts are pinned to real version 3.4.3, not test approximations. OG's physical canvas is 800 x 480; X uses native `screen--v2` with a 1040 x 780 logical canvas transformed by 1.8 to 1872 x 1404 physical pixels. Native padding/gaps reduce usable full/split view bounds, as documented in the README.

Fitting responds to actual view geometry and font readiness, completes synchronously before the framework publishes capture readiness, and reruns after dimension changes. Browser tests observe the native readiness signal itself as well as the display's `data-agenda-ready` signal, assert physical screenshot dimensions and raster ink at required-text positions, and check text ranges against clipping ancestors and essential rows against overlap in every placement. Current/empty, stale, configuration errors, source/compatibility errors, and other safe errors remain distinguishable. Unknown error codes are displayed, not treated as healthy empty data. A null `source_succeeded_at` produces an explicit absence of source success; rendering never substitutes `generated_at` or the current clock. Cache production/expiry remains outside display ownership.

Calendar text is escaped as HTML/data attributes and time formatting assigns `textContent`; calendar text never becomes executable markup. Times and source-success labels are formatted with the named Los Angeles timezone and a 12-hour AM/PM clock.

The [local UI workbench](../README.md#local-agenda-ui-workbench) consumes version-controlled normalized JSON scenarios from `display\scenarios`, shared with display checks. Its fixed reference instant is `generated_at`; dates, source state, and original source-success time are supplied, never recomputed from a live clock. These presentation inputs bypass source interpretation and selection rather than claiming to test those behaviors. Commit-pinned and working-copy template inputs use the same strict renderer and native wrappers, with isolated browser documents and unchanged production fitting. The optional `--template-root` renderer input changes only where templates are read; ordinary rendering, native settings, and polling-body defaults are unchanged.

## Activation evidence

The [Azure delivery runbook](azure-delivery.md) defines deployment, secret/identity configuration, key rotation, bounded telemetry/storage, redacted smoke tooling and the live acceptance checklist. The smoke tool measures the complete native single-URL polling object in serialized UTF-8, with a strict 100,000-byte limit and a ten-second deadline per attempt with at most one transport retry. A rescued slow first attempt still fails the latency check. Authorized renderable calendar errors remain different from authentication rejection and fresh source success.

An unexpected state/error remains a failed smoke check, with `activation_complete: false`, and preserves the authorized poll's attempts/status/duration/retry, safe actual state/code, validated source-success timestamp, raw UTF-8 bytes and whole-object serialized bytes before any authentication probes. Calendar fields are extracted only after strict contract/timestamp validation. Evidence permits only known states and the current code allowlist above; unknown codes use a fixed `unknown` marker and cannot be accepted via an arbitrary `--expected-code`. Malformed/unknown contracts retain transport evidence with unknown calendar fields, never raw bodies, labels, commitments, rules, source URLs, keys or exception messages. Missing/wrong-key probes do not run after a failed calendar check.

Synthetic HTTP/results/rendering checks, local Core Tools, compiled infrastructure and ARM what-if are not evidence of Azure key enforcement, production managed-identity access, private-feed compatibility or actual private-device delivery. Missing owner access or a controlled deployed source-failure path remains an explicit live gate, not a healthy fallback.
