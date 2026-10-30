# Post-merge delivery receipt automation

**Status: agreed design, not implemented or activated.** Agreed on 2026-10-26.
This document records the decisions from the delivery-receipt design discussion.
The existing [delivery contract](agents/delivery.md),
[post-merge procedure](agents/post-merge.md), and workflows remain operative.
The policy changes below take effect only through a separately reviewed implementation.

## Purpose and vocabulary

A **delivery receipt** records the evidence supporting delivery of a particular
human-landed PR, together with any missing gates. It is not a requirement for
every feature-branch commit, a replacement for validation, or permission to land changes.

A **repository-change receipt** covers human landing acceptance, validation of the
landed content, and publication. A **ticket-scoped receipt** additionally covers
explicitly declared delivery tickets and their additional requirements.
Repository-change delivery alone does not establish ticket-specific delivery.

These are delivery-process terms, not additions to the calendar domain glossary.

## Agreed policy changes

| Concern | Current contract | Agreed replacement |
| --- | --- | --- |
| Local synchronization | An authorized existing local target checkout must be safely synchronized before final delivery proof. | Workstation synchronization is separate and does not block repository delivery. It retains its own permission and safety requirements. |
| Acceptance | Resulting-content acceptance and review provenance must be established after human landing. | An authorized human merging the exact final PR revision is the default acceptance decision. This does not assert that a separate review approval occurred or waive additional requirements. |
| Validation | Evidence may be inherited through the prescribed content/context comparison. | Always rerun the existing Full validation on the exact landing commit. Do not reuse PR validation as its substitute. |
| Publication proof | Local target and live remote target tips must be equal. | The exact accepted landing commit must remain reachable from live remote main when the receipt is finalized. No workstation target is part of this proof. |
| Evidence collection | An agent assembles and persists the receipt. | Post-merge automation assembles and persists the evidence and its complete/pending assessment. |

Human-only landing, additional delivery gates, and evidence-before-completion
remain requirements. Ticket closure remains a separate human or otherwise
explicitly authorized agent operation; the collector never closes tickets.

Implementation must update the authoritative delivery documentation and introduce
the appropriate executable remote-publication proof together. Running the existing
`scripts\check-completion.mjs` in a fresh Actions checkout does not satisfy today's
existing-local-checkout procedure or establish this proposed remote-only contract.
Do not silently reinterpret its current results.

## Collection and validation

Collection starts after pushes to main, after human landing. Produce one receipt
per human-landed PR, not per constituent commit or push. Account for every newly
landed PR when one push contains several landings. An unassociated commit is an
explicit exception, not a silently certified PR delivery.

Resolve each PR's actual landing identity, including ordinary merge or squash
results, from its landing provenance. Record the exact final head, relevant base
and parent identities, landing result, human actor, and landing time. A moving
branch name, PR number, or currently advertised tip is not a landing identity.
Unexpected landed changes or ambiguous provenance leave acceptance pending.

For each landing:

1. Validate the exact landing commit with the existing
   `scripts\validate.ps1 -Scope Full`, using the repository's documented setup and
   validation procedures. Record the actual run-on commit and evaluated tree,
   command/scope, outcome, and run identity. A synthetic PR evaluation or another
   revision's green check is not post-merge validation.
2. Retain the human acceptance record and any separately required review evidence.
   Human merging is the default acceptance decision, not invented review evidence.
3. Observe live remote main and establish landing-commit reachability from that
   observed tip. Record the observation time, full tip identity, and result.
4. Evaluate any explicitly declared additional requirements.
5. Persist the receipt before claiming completion.

Every landed PR gets its own fresh Full evaluation. If PR B lands while PR A is
being validated, do not cancel A merely because B arrived. A can complete when
its own gates pass and its result remains reachable from live main; A need not
remain the tip. The configured CI concurrency must preserve that independence.
Budget for a second Full execution after the existing required PR validation.

Automation collects evidence only after landing. It never merges PRs, pushes to
main, enables auto-merge, deploys, or synchronizes a workstation checkout.

## Ticket scope and additional gates

PR authors may prepare a small structured delivery section declaring:

- The specific delivery tickets this PR satisfies.
- Additional gate requirements and their evidence references.

Without that declaration, produce only a repository-change receipt. Do not infer
delivery scope from incidental issue mentions or automatic closing keywords.
Do not introduce automatic closing keywords as part of this mechanism.

Missing, ambiguous, or unsatisfied additional requirements keep the ticket-scoped
receipt pending even when Full succeeds. For example, Azure or device activation
requires its own evidence; neither human merging nor hosted tests establishes it.
An extra gate that cannot be machine-verified needs an explicit acceptance record,
not an inference of success. Later evidence can be reconciled by rerunning collection.

The structured section's exact schema and evidence-validation rules remain
implementation details; they must preserve these boundaries rather than require
a contract for every PR.

## Durable record and permissions

Maintain one automation-owned receipt comment on the merged PR. Include a readable
summary and machine-readable evidence. Reruns update that comment rather than
creating duplicates; retain prior attempt identities, outcomes, and evidence
references. Post receipt pointers to explicitly associated delivery tickets without
changing their state.

The receipt records its scope, complete/pending assessment, exact commit identities,
human acceptance provenance, actual Full command and outcome, live publication
observation, additional-gate evidence, blockers, and collection attempt identity.
Retain the essential evidence in the comment itself rather than relying solely
on expiring Actions artifacts or logs. Evidence links identify the specific run
and attempt; they do not replace the recorded essential facts.

Do not edit the PR title/body to publish progress or evidence. Under the existing
[CI policy](ci-validation-design.md), those edits trigger genuine Full again.
Keep credentials, private runtime inputs, remote URLs, and machine-private paths
out of durable records.

Use only the permissions needed for each operation. Validation must not gain
ticket/comment write authority merely because evidence publication needs it.
Treat PR text and evidence references as data, not executable instructions.
This design grants no deployment, protection-setting, or credential changes.

## Failure and recovery

Missing provenance, unavailable GitHub or remote evidence, and failed or cancelled
Full cannot yield a complete receipt. Record the actual failure or pending gate,
including failed validation evidence. Receipt-write failure leaves completion
pending; the failed workflow is the visible blocker until persistence succeeds.

Support rerun and manual dispatch for recovery and reconciliation. Preserve the
same PR/landing identity and prior attempt outcomes. Do not add automatic retry
loops or substitute another revision's success.

A complete receipt is a timestamped observation, not a lock on main or a promise
that history and external conditions cannot change. If the required live
reachability observation fails, leave publication pending.

## Implementation acceptance scenarios

- Ordinary and squash merges record and validate the actual landing commit.
- Several PRs landing together each receive their own receipt and Full evaluation.
- A newer landing does not cancel an earlier landing's required evaluation.
- A PR with no delivery declaration receives only a repository-change receipt.
- Missing extra-gate evidence leaves ticket-scoped delivery pending.
- Unassociated commits and ambiguous or unexpected landing provenance are explicit exceptions.
- Failed/cancelled Full, unavailable live main, or unreachable landings cannot complete.
- Rerun/manual dispatch updates the existing receipt and preserves attempt outcomes.
- Receipt persistence failures remain visible and prevent a completion claim.
- No path performs landing, deployment, workstation synchronization, or ticket closure.
