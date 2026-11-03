# Outlook publication: observed source contract

This is the participation-metadata shape and capability boundary of the **actual configured Outlook publication checked on 2026-11-02**. It is not a complete iCalendar schema, a guarantee about every Outlook publication, or the adapter's [HTTP/display contract](agenda-contract.md).

**This is retained source evidence, not an active participation-classifier plan.** [#104](https://github.com/geevensingh/trmnl-calendar/issues/104) supersedes the earlier participation-label work and plans to retire the labels entirely, without replacing them with inferred attendance or availability labels. The existing production tracer still emits Unknown until that retirement is separately implemented. This document implements neither classification nor removal.

These observations remain useful for understanding and diagnosing the publication. They do not establish physical presence, approachability, an available time slot, or a promise of availability to visitors. Further checks solely for the retired classifier are not prerequisites for #104.

## Evidence and scope

The [#60 evidence record](https://github.com/geevensingh/trmnl-calendar/issues/60#issuecomment-6586740790) contains the owner authorization, dated measurements, primary references, report digests, limitations, and cleanup confirmation. This document keeps the reusable conclusions, not the investigation transcript.

The comparison used the existing .NET 10 application with Ical.Net **5.2.3**, its maintained timezone resolver, production HTTP-client registration, source acquisition, and interpretation path. HTTPS, no redirects, strict UTF-8, the **2 MiB** source limit, **30-second** acquisition limit, and **35-second** overall limit were unchanged. The source URL matched the runtime's completed-source digest before and after each measurement.

Independent Outlook controls established the reference states; the states were not inferred from the same feed markers being tested. Three existing events were read without modification. The owner separately authorized one temporary appointment for the missing Working Elsewhere case and a title-only negative control. That control had no attendees or reminder and was deleted afterward; its removal was verified in Outlook and a fresh publication acquisition.

These are tested timed-event observations, including recurring exceptions. They do not independently establish all-day participation semantics, recurrence inheritance, changed-instance precedence, or stale-source classification. Do not extrapolate them into untested guarantees or reactivate the superseded classifier/recurrence tickets.

## Relevant source shape

| Property | What the checked source supplied | Interpretation boundary |
| --- | --- | --- |
| `TRANSP` | `TRANSPARENT` for the tested Free cases; `OPAQUE` for the tested Busy and Working Elsewhere cases. | Availability/nonblocking time, not an invitation response. Do not generalize this service observation to all Outlook versions. |
| `X-MICROSOFT-CDO-BUSYSTATUS` | Distinct `FREE`, `BUSY`, and `WORKINGELSEWHERE` values in the corresponding reference cases. | A corroborating explicit availability signal. Missing, multiple, unsupported, or contradictory values do not establish the tested state. |
| `SUMMARY` | Free-form titles, including a `Following: ` prefix on a genuinely followed meeting and on a deliberately non-followed appointment. | Subject text is not an authoritative Follow-state field. |
| `ORGANIZER` | No organizer properties observed anywhere in the checked sample. | The feed did not establish the owner's organizer role. |
| `ATTENDEE` / attendee `PARTSTAT` | No attendee records observed anywhere in the checked sample. | Accepted, declined, tentative, and positively known unanswered invitation states were not available as owner-specific feed evidence. |
| Event `STATUS` | Not accepted as a personal-response signal. | Event confirmation, availability, and the owner's response are distinct concepts. `CONFIRMED` must not become owner-accepted, nor event `TENTATIVE` owner-tentative. |
| `UID`, actual start, and recurrence metadata | Used to correlate the same occurrence across Outlook and the maintained parser. | Identity and timing, not participation evidence. Preserve the existing supported-calendar and duplicate-identity protections. |

The absence findings apply to the inspected sample, not every future snapshot. A valid calendar or a configured owner address does not establish metadata coverage. The absence was checked across the source, not only against one mailbox; adding guessed aliases cannot restore omitted properties.

Owner matching, if a later source supplies personal metadata, still requires approved adapter-side identity. Do not choose the first attendee, match display names, infer identity from subjects/source URLs, or invent equivalent addresses.

### Schematic property fragments

These are synthetic illustrations of the relevant fields, **not complete calendars or captured private events**.

Corroborated Free shape:

```ical
SUMMARY:Example event
TRANSP:TRANSPARENT
X-MICROSOFT-CDO-BUSYSTATUS:FREE
```

The tested Working Elsewhere shape was different:

```ical
SUMMARY:Example event
TRANSP:OPAQUE
X-MICROSOFT-CDO-BUSYSTATUS:WORKINGELSEWHERE
```

A subject alone cannot prove Follow state:

```ical
SUMMARY:Following: Example event
```

An ordinary non-followed appointment can carry that last fragment. Its subject remains ordinary untrusted text even when the owner intentionally uses such a naming convention.

## Verified contrasts and safe consequences

All five cases below were correlated to exact source definitions, not matched by title.

| Independent Outlook reference | Observed publication shape | Safe consequence |
| --- | --- | --- |
| Accepted meeting shown Free | Transparent plus explicit Free status. | Free availability was exported; acceptance was known in Outlook, not exported as an owner response. |
| Accepted meeting shown Busy | Opaque plus explicit Busy status. | Busy data did not carry the known personal acceptance. |
| Genuinely followed meeting shown Free | Transparent plus explicit Free status; subject prefix present. | The followed reference also exported Free. This does not make the prefix authoritative. |
| Controlled appointment shown Working Elsewhere | Opaque plus explicit Working Elsewhere status. | The source preserved a distinct availability state; it must not silently become Free. |
| Same control changed to Free and given a title-only prefix, without becoming a followed meeting | Transparent plus explicit Free status; subject prefix also present. | A demonstrated counterexample to prefix-only Follow detection. Free, not the prefix, is the usable evidence in this case. |

The tested Free cases had consistent explicit Microsoft Free status together with transparency. That is a source-state observation, not an instruction to implement the retired Unlikely rule. It does not establish a generic "all transparent events are Free" rule or a "`Following: ` means followed" rule.

The inspected source did not supply the personal evidence sought by the retired Definite/Likely/Maybe classifier. Missing metadata must not become accepted or unanswered invitations, and a parser's default response is not explicitly supplied evidence. Subject text alone does not establish Follow state.

The current tracer's Unknown value is not an error-recovery shortcut. Existing malformed-source, unsupported-calendar, storage, and configuration failures remain explicit errors. This note changes neither the current version-2 payload nor the coordinated contract transition required for #104.

The default title exclusion for `Following: ` remains a literal, editable exclusion preference. Its continued use does not assert that every matching title is genuinely followed, and source-capability findings do not change that exclusion.

## Edge cases that matter

### Documentation is not an execution result

[RFC 5545 section 3.8.2.7](https://www.rfc-editor.org/rfc/rfc5545#section-3.8.2.7) defines transparency as whether an event blocks free/busy time. It does not define an attendee's response.

Microsoft's [TRANSP conversion table](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/54d3000c-a6b3-43c0-b4b0-543578f86fa0) maps both Free and Working Elsewhere to transparency for documented product contexts. Its [product-behavior appendix](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/afb90409-bcd2-4a44-9f1e-ca9340ec0508) qualifies versions and implementations. The actual checked cloud publication exported Working Elsewhere as opaque, so the table alone was not a sufficient source contract.

The [documented busy-status property](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/cd68eae7-ed65-4dd3-8ea7-ad585c76c736) likewise does not, by itself, establish the current service's Working Elsewhere export. The controlled comparison established that this publication retains a distinct status.

Microsoft [documents Follow as leaving the attendee's calendar time Free](https://support.microsoft.com/en-us/outlook/calendar/follow-a-meeting-in-outlook), but that is not a contract for a literal exported English subject prefix. The negative control supplies stronger evidence against prefix-only detection than an unsuccessful documentation search.

### Recurring reference identities can differ

An Outlook exception's [Global Object ID](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/1d3aac05-a7b9-45cc-a213-47f0a0a2c5c1) can contain an exception date that is cleared in its [Clean Global Object ID](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxocal/6dfb37ac-94e7-4a73-b6dd-f289bcb1f47c). The documented relationship allowed the comparison to use the clean series identity **and the exact actual start** after literal exception identifiers did not match.

That was a diagnostic reference join for recognized Microsoft identifiers, not a new equivalence rule for arbitrary iCalendar UIDs. It did not rewrite source identifiers, alter the parser, resolve a mixed recurrence state by guessing, or change production occurrence IDs.

### Visible editing is not proof of saved state

For a controlled check, verify the saved appointment's actual state, calendar, interval, attendee list, and reminder setting before using it as evidence. The browser editor can display typed text without committing a picker value. Verify cleanup independently too: closing an editor or submitting Delete alone is not proof that the item disappeared from the publication.

## How to recheck this contract

Use the [protected operator workflow](azure-delivery.md#protected-source-preflight-before-design-approval) with explicit owner authorization. The checked-in preflight reports structural booleans; **it does not inspect the vendor busy-status distinction or perform the independent Outlook-to-publication comparison described here**. A successful preflight or synthetic fixture alone cannot renew these capability findings.

1. Establish that the independently opened Outlook calendar is the published source and that acquisition uses the runtime's effective source. Do not infer this from a display name or an old secret version.
2. Read the actual response control and Show As value on known references: followed/Free, non-followed/Free, non-followed/Busy, and Working Elsewhere. Missing reference cases remain unperformed unless separately authorized controlled tests supply them.
3. Keep acquisition and interpretation on the maintained path and original limits. Correlate exact identities and actual occurrence starts; reject ambiguous or missing joins rather than matching subjects.
4. Report only allowlisted capability conclusions. Do not commit private ICS samples, real event titles, raw identifiers, identities, source URLs, credentials, or upstream exception messages. Preserve incomplete/failed measurements instead of replacing them with later success.
5. Any calendar write needs separate authorization. If a temporary control is approved, keep it isolated from real meetings, verify saved values, remove that exact item, and verify removal in Outlook and a fresh source acquisition.

If a later operator decision depends on these assumptions, recheck after changes to the publication, source/owner context, publication settings, relevant parser behavior, or observed field consistency. Treat these findings as dated evidence, not a promise that an unversioned service can never change. These diagnostic steps are not prerequisites for the label-retirement plan.

Source observations, the current output contract, and [Git delivery acceptance](agents/delivery.md) are separate concerns. This document authorizes no source switch, deployment, ticket closure, or permission grant, and adds no source-semantic gate to #104.
