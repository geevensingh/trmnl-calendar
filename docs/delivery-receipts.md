# Manual post-merge delivery receipts

The [delivery contract](agents/delivery.md) defines repository-change delivery as authorized human-merge acceptance, fresh Full on the exact landing, live publication, and a durable receipt. Ticket-scoped delivery additionally requires the explicitly declared gates and durable ticket pointers. Workstation synchronization is separate. Manual dispatch supports both scopes independently of automatic push discovery. Interrupted/concurrent reconciliation remains a separate slice.

## Operator path and bootstrap

After a human lands `.github/workflows/delivery-receipt.yml` and its orchestration on `main`, dispatch **Post-merge delivery receipt** with `pr_number` identifying one already human-merged PR in `geevensingh/trmnl-calendar` targeting `main`. Dispatch from `main` only. For example:

```powershell
gh workflow run delivery-receipt.yml --ref main -f pr_number=<merged-pr-number>
```

Use actual already human-published history. No path merges, pushes to main, enables auto-merge, deploys, synchronizes/repairs a workstation, changes protection/credentials, closes issues or edits PR titles/bodies.

There is no same-landing concurrency guarantee in this slice: let a manual collection finish before dispatching another for that PR. A newer main tip does not cancel an older landing's Full. There are no automatic retries or validation-result reuse. Rerun **all jobs** for a fresh sequential attempt; rerunning only failed jobs cannot inherit an earlier attempt's successful Full. Whole-workflow interruption can prevent publication; that is an explicit missing receipt, not success.

Fixture success is not hosted acceptance. Until a human lands the workflow on the default branch, hosted dispatch, Windows least-privilege setup/Full and actual comment creation/update remain **pending bootstrap**. After that landing, separately record successful manual wiring, genuine Full's exact checkout commit/tree, permission separation, initial canonical comment, sequential update/history and an advanced-main reachability observation. Also exercise a safe synthetic declared gate through pending and later accepted observations and unchanged-state issue pointers. Use already human-published history; do not automate a landing, perform real activation, or update a real workstation to manufacture evidence.

## Trusted orchestration and selected-code execution

Preparation and publication check out the dispatch's immutable `github.sha` from trusted `main`, not the selected historical landing. They read Git objects and GitHub evidence only. The validation job alone checks out the selected landing, with no persisted checkout credentials, only `contents: read`, no production secrets and no issue/comment-write token.

Validation uses the same Windows image, Node 22, manifest-selected .NET plus the .NET 8 host tooling, Ruby 4/Devkit/locked Bundler, Functions v4, Bicep, display setup and genuine shared Full as PR CI. Its finite timeout is 60 minutes; preparation/publication each have 10 minutes. The required PR workflow/check identity and triggers are unchanged.

The publisher receives the **trusted preparation output**, never executable output or an artifact from selected validation code. It independently resolves PR/timeline/permission/review and Git-object evidence, compares immutable pins, and queries the exact Actions run/attempt and named validation job/checkout/Full step conclusions. Actual run-on/tree identity is bound to the trusted pin and successful trusted checkout-verification step, not arbitrary JSON printed by landed code. A different workflow, revision, attempt, missing checkout verification or unsuccessful Full cannot certify delivery.

Only publication has `issues: write`, alongside read permissions for objects, PRs and Actions evidence. It performs comment-only API writes. It never invokes landed scripts, setup, hooks, Full or dependency manifests with that write token. PR bodies and API diagnostics are data; receipts retain only bounded, validated essential fields.

## Workflow-facing process protocol

`scripts/delivery-receipt.mjs` is the two-phase workflow process boundary, not a replacement validation suite. Run it from an isolated collection checkout with complete relevant Git objects and configured `origin`. Supply `GH_TOKEN` only to the operation needing GitHub access:

```text
node scripts/delivery-receipt.mjs prepare --repository owner/repo --pr N --run-id RUN --attempt ATTEMPT --orchestration-commit FULL_SHA
node scripts/delivery-receipt.mjs publish --repository owner/repo --pr N --run-id RUN --attempt ATTEMPT --orchestration-commit FULL_SHA --plan trusted-plan.json
```

Preparation emits compact version-1 JSON with `repository`, `pr_number`, `run_id`, `run_attempt`, `orchestration_commit`, `provenance`, a structured `declaration` observation and provenance `blockers`. Its successful process exit means resolution was recorded, not acceptance: a merged PR can have blockers. Schedule Full only when provenance blockers are empty and acceptance is present, using exactly `provenance.landing_commit` and `landing_tree`. A malformed declaration or missing ticket evidence does not skip repository-change Full. Preserve that trusted plan across the isolated validation job. Do not accept a caller-supplied validation artifact as an authoritative plan.

Publication independently recollects evidence and emits `{ persisted, assessment, comment_id, attempt_id, blockers }` on stdout/exit 0 after a confirmed comment write. `assessment` is `complete`, `pending` or `failed`; a successful collector process is not necessarily delivery. Operation/persistence failure emits fixed-code JSON with `persisted: false` on stderr/exit 1, and the workflow fails visibly. There is no success fallback or retry loop.

Production uses only `https://api.github.com`. `--api-url` accepts an HTTP loopback origin for public-process external-boundary fixtures; arbitrary hosts, credentials and redirects are rejected. GitHub requests and Git operations are bounded to 30 seconds, pagination to 100 pages of 100 items, and receipt content to 60,000 UTF-8 bytes. Exceeding limits fails rather than truncating essential evidence.

Successor collectors can extend event admission/scheduling while retaining this per-landing prepare -> exact Full -> publish boundary. Ticket evaluation extends declaration assessment and the strict record shape, not the validation identity or publication proof. Recovery can extend canonical-write coordination; this slice deliberately supports sequential attempts, not overlapping or interrupted collectors.

## Essential record

The canonical PR comment has a readable latest assessment and one embedded `<!-- delivery-receipt:v1` JSON envelope. Version 1 contains:

| Record | Essential facts |
| --- | --- |
| Envelope | Schema version, repository, PR number, full landing identity, latest attempt ID and all sequential attempts |
| Attempt | `run_id:run_attempt` identity, observation time, scope, latest overall and separate repository-change assessments, fixed blockers |
| Provenance | Final head, API base observation, landing commit/tree/parents, computed merge base, ordinary/squash mapping, merge time, default human-merge acceptance and actual review records |
| Acceptance | Human ID/login/type, current authorized permission observation, merge time, exact final head and landing; not a separate approval |
| Full | Exact command/scope, actual run-on commit/evaluated tree when checkout is verified, actual outcome, orchestration commit, run/attempt and job IDs |
| Publication | UTC observation, configured remote/branch names, exact live full tip, landing identity, reachability result and errors |
| Ticket scope | Separate assessment; declaration status, merged-PR-body SHA-256, requirements SHA-256 and normalized explicit ticket/gate/evidence references; per-ticket assessments, individual gate facts/blockers, pointer outcomes/comment IDs |
| Gate fact | Specific issue-comment or PR-review ID, human actor and authorized permission observation, source timestamps/body SHA-256 or actual review record, applicable structured acceptance, actual complete/pending result and fixed blockers |

IDs and run/attempt links make evidence attributable; essential facts remain in the comment after Actions logs/artifacts expire. A failed/cancelled/blocked evaluation records its actual outcome and leaves missing identities unverified. The record never includes PR prose, review bodies, arbitrary evidence URLs, raw diagnostics, remote URLs, credentials, private runtime inputs or machine-private paths.

Canonical discovery paginates PR comments and requires the matching envelope plus the exact GitHub Actions bot identity and GitHub Actions app ownership. The repository/PR/landing binding and strict historical shape are checked before update. A foreign marker, ambiguous canonical comments, mismatched identity, malformed or contradictory history, duplicate attempt or exhausted capacity fails without overwriting foreign state or dropping history. Sequential collection updates the same comment and retains earlier outcomes; an earlier complete observation is visibly distinct from a newer failed/pending assessment.

The v1 envelope remains compatible with original repository-change attempts and the old `explicit_delivery_declaration_unsupported` pending outcome: historical attempts without `ticket_scope` remain unchanged. New attempts always have `ticket_scope`; no old pending outcome is reclassified. Recovery code must preserve both forms.

## Scope and pending outcomes

No declaration means repository-change scope (`ticket_scope.assessment: not-applicable`). Incidental issue mentions and closing keywords do not associate tickets. Explicit `<!-- delivery ...`, Markdown `Delivery` headings or `delivery` code fences, including malformed/unterminated forms, cannot silently become absent. Unsupported formats/versions, unknown fields, duplicate JSON keys/identities and unsafe references produce `delivery_declaration_malformed`; multiple declaration sources produce `delivery_declaration_ambiguous`. These leave ticket scope pending while retaining the separate repository-change result. One optional `Delivery` heading may introduce the supported block below.

### Author declaration v1

Put exactly one JSON `delivery` fence in the PR body. Only same-repository issue numbers explicitly in `tickets` receive pointers. `gates: []` means no additional gates declared, not inferred Azure/device acceptance. Name every additional requirement with a stable, lowercase, hyphenated `id` (at most 64 characters); its meaning must match the issue's substantive requirement. Changed requirements need a new gate identity/acceptance, not reuse of an old ID. The collector neither edits nor infers requirements from issue prose.

````text
```delivery
{
  "version": 1,
  "tickets": [
    {
      "issue": 8,
      "gates": [
        {
          "id": "azure-activation",
          "kind": "acceptance",
          "evidence": [{ "kind": "issue-comment", "id": 500 }]
        },
        {
          "id": "design-review",
          "kind": "review",
          "evidence": [{ "kind": "pr-review", "id": 55 }]
        }
      ]
    }
  ]
}
```
````

Replace example issue/evidence IDs with real sources. The strict schema accepts only these fields: `version: 1`; 1-20 unique tickets; 0-20 unique gates per ticket; and 0-20 distinct `{kind, id}` evidence references per gate. Numeric IDs must be positive safe integers. An empty evidence array is explicitly missing; more than one candidate for a gate is explicitly ambiguous, never an arbitrary choice. To require several approvals/acceptances, declare separate gates. Arbitrary URLs, freeform evidence, unknown kinds and extra fields cannot certify delivery. No input is executed.

`declaration.sha256` fingerprints the entire observed PR body; the source is that PR body, not a claimed body editor or an invented reviewer. `requirements_sha256` fingerprints compact JSON in declared order with evidence excluded: `{"version":1,"tickets":[{"issue":8,"gates":[{"id":"azure-activation","kind":"acceptance"},...]}]}`. Copy the actual digest from preparation/the pending receipt, not the example. Adding evidence references does not change this digest; changing gate IDs/kinds, tickets or order does.

### Explicit non-machine-verifiable acceptance

An authorized human supplies one structured record in the referenced **comment on the declared issue**, after the landing is known. Its author must be a GitHub `User` with currently observed write, maintain or admin permission in this repository. Bot/app authors, unavailable permission/source evidence, unrelated comments, bad timestamps, unknown fields, duplicate keys/records and wrong scope stay pending. Comment ID, author, timestamps, body digest, permission observation and accepted scoped facts are persisted; prose and diagnostics are not.

```text
<!-- delivery-acceptance:v1
{"version":1,"repository":"geevensingh/trmnl-calendar","pr_number":67,"landing_commit":"<full actual landing SHA>","ticket":8,"gate":"azure-activation","requirements_sha256":"<digest from the pending receipt>","outcome":"accepted"}
-->
```

Use the real merged PR, landing, ticket, gate and requirements digest. `outcome` is `accepted` or `rejected`; rejection is pending, not proof of success. The source's updated time must be at/after the recorded human landing, at/after its creation, and not in the future. Acceptance is a human assertion of the named external requirement, not an automated proof of activation. Green Full, an arbitrary link, a PR merge or prose saying "approved" is insufficient. Collection authorizes **no activation or external action**.

For a `review` gate, the referenced ID must resolve to one actual `APPROVED` PR review of the exact final head by an authorized human. A missing, dismissed, other-revision, duplicate or superseded decisive review stays pending. `COMMENTED` is not approval; human merging never creates a review. All actual review provenance remains in the repository-change evidence separately.

### Later evidence and pointer publication

Reserve/reference an issue comment before landing when practical. If its structured acceptance is not yet available, the gate stays pending. Later the authorized human supplies/updates that same referenced comment and dispatches the same PR again (or reruns all jobs). No new PR or collector PR-metadata edit is needed. The publisher rereads the current PR declaration and every referenced source, reruns exact-landing Full through the shared path and reobserves live publication; it never reuses the previous green evaluation. Each attempt keeps its own actual source digest, outcome, blockers and run identity, including accepted evidence that is later rejected or unavailable.

For valid declarations, the publisher first saves a pending PR receipt, then posts/discovers one stable `delivery-receipt-pointer:v1` comment per explicit issue/PR/landing, then persists confirmed pointer IDs and the final assessment in that same attempt. Each pointer links the canonical PR comment; it does not assert permanent completion or contain closing keywords. Discovery paginates and checks the exact Actions bot/app ownership and repository/PR/landing/issue/receipt identity. Existing identical pointers are reused without a write. Unavailable issues and PRs incorrectly listed as issues remain pending with no pointer write.

Pointer write/ownership/identity failures remain individual durable blockers with `pointer.outcome: failed`; other tickets' observations are preserved. The collector exits nonzero after recording these failures. A sequential later dispatch can retry publication while retaining the prior failed attempt and reusing already confirmed pointers. If the final PR write itself fails, completion remains unconfirmed and the workflow fails; an intermediate pending receipt is not a completed collection.

The staged write is deliberately not a cross-comment transaction or a same-landing concurrency solution. The recovery slice must coordinate/fence overlapping attempts, reconcile interrupted/uncertain writes, and preserve the initial pending attempt plus every actual outcome. Do not dispatch concurrently for one PR in this slice.

Provenance uses merged PR data, matching merge timeline, current collaborator permission and Git objects. Ordinary merges require the final head as second parent; squash results need not contain that head. Both require the expected merged tree of the first landing parent and final head. Rebase/cherry-pick/ambiguous mappings and unexpected conflict-resolution edits stay pending rather than being guessed.

The standalone publication boundary is:

```powershell
node ./scripts/check-publication.mjs --landing-commit <full-landing-sha> --remote origin --remote-branch main
```

It observes live main and proves ancestry from that exact tip without fetching or consulting a local target/tracking ref. Missing objects, unavailable observations or unreachable history fail explicitly. The workflow restores objects only in its disposable orchestration checkout before this read-only observation. Advancing main is supported; rewriting away a landing is not. The legacy `check-completion.mjs` and historical local-target receipts retain their original semantics.

The public-process tests in `tests/delivery/receipt.test.mjs` use disposable real Git repositories/local bare remotes and controlled GitHub/expensive-Full boundaries. They are automatically discovered by the existing authoritative Full entrypoint. They are not actual Windows hosted Full, GitHub token-policy or event-wiring acceptance.
