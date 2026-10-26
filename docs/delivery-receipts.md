# Post-merge delivery receipts

The [delivery contract](agents/delivery.md) defines repository-change delivery as authorized human-merge acceptance, fresh Full on the exact landing, live publication, and a durable receipt. Workstation synchronization is separate. Main pushes initiate automatic collection; manual dispatch collects one identified PR. Ticket-gate evaluation/pointers and interrupted/concurrent reconciliation remain separate slices.

## Operator path and bootstrap

After a human lands both receipt workflows and their orchestration on `main`, **Collect pushed delivery receipts** admits main pushes automatically. Inspect its admission and final collection summaries before reporting delivery. To collect one already human-merged PR in `geevensingh/trmnl-calendar` targeting `main`, dispatch **Post-merge delivery receipt** from `main`:

```powershell
gh workflow run delivery-receipt.yml --ref main -f pr_number=<merged-pr-number>
```

Use actual already human-published history. No path merges, pushes to main, enables auto-merge, deploys, synchronizes/repairs a workstation, changes protection/credentials, closes issues or edits PR titles/bodies.

There is no same-landing concurrency guarantee in this slice: let a manual collection finish before dispatching another for that PR. A newer main tip does not cancel an older landing's Full. There are no automatic retries or validation-result reuse. Rerun **all jobs** for a fresh sequential attempt; rerunning only failed jobs cannot inherit an earlier attempt's successful Full. Whole-workflow interruption can prevent publication; that is an explicit missing receipt, not success.

Fixture success is not hosted acceptance. Until a human lands the workflows on the default branch, hosted push admission/dispatch, Windows least-privilege setup/Full and actual comment creation/update remain **pending bootstrap**. After that landing, separately record actual event-bound discovery, non-superseding distinct-landing execution, successful manual wiring, genuine Full's exact checkout commit/tree, permission separation, initial canonical comment, sequential update/history and an advanced-main reachability observation. Use already human-published history; do not automate a landing or update a real workstation to manufacture evidence.

## Automatic collection and exceptions

The push workflow binds admission to the payload's full `before` and `after` commits and repository/main ref, with orchestration pinned to `after`. It reads complete Git history rather than the payload's potentially truncated commit list or a moving main tip. First-parent target history identifies landing positions; an ordinary merge's side-parent implementation commits are constituents, not extra deliveries. Commit-associated PR evidence is paginated, deduplicated and cross-checked against the authoritative merged-main PR and actual result. The existing per-PR preparation then verifies human acceptance and ordinary/squash content mapping.

Each admitted `{ pr_number, landing_commit }` gets its own invocation of the existing prepare -> exact-landing Full -> publish path. The matrix uses `fail-fast: false`, with no cancellation/concurrency group across pushes or landings. An earlier landing remains pinned even when main advances; publication re-observes live main after Full. Budget roughly **another 40-45 minutes of Full per landing**, subject to setup variability and the existing 60-minute Full job cap. No PR-validation or matching-tree reuse reduces that cost.

Missing/zero before identities, rewritten/deleted targets, unavailable or shallow history, non-first-parent ranges, ambiguous/changed associations and genuinely unassociated target commits produce explicit exceptions. Nonhuman or unexpected landing provenance gets a pending receipt and skips Full until acceptance is established. An API or receipt-write failure for one landing leaves the others scheduled. A batch is complete only when it has no admission exceptions and every landing's current attempt is durably complete with a successful publication job. A persisted pending/failed receipt is not a successful batch.

Admission and final summaries retain event identities, every identified landing and fixed exception codes without PR prose or diagnostics. Summarization queries actual owned canonical comments and the exact run/attempt's named publication jobs; missing receipts, failed jobs and partial results fail visibly. The GitHub matrix limit is 256 landings: larger batches retain all identities, report `push_matrix_capacity_exceeded` and require explicit per-PR manual collection rather than silently dropping work. The bounded 400,000-byte batch and API/Git limits also fail explicitly rather than truncate evidence. Whole-workflow interruption, overlapping same-landing writes and rerun recovery remain the later recovery slice; do not assume those guarantees yet.

## Trusted orchestration and selected-code execution

Preparation and publication check out the event's immutable `github.sha` from trusted `main`, not the selected historical landing. They read Git objects and GitHub evidence only. The validation job alone checks out the selected landing, with no persisted checkout credentials, only `contents: read`, no production secrets and no issue/comment-write token.

Validation uses the same Windows image, Node 22, manifest-selected .NET plus the .NET 8 host tooling, Ruby 4/Devkit/locked Bundler, Functions v4, Bicep, display setup and genuine shared Full as PR CI. Its finite timeout is 60 minutes; preparation/publication each have 10 minutes. The required PR workflow/check identity and triggers are unchanged.

The publisher receives the **trusted preparation output**, never executable output or an artifact from selected validation code. It independently resolves PR/timeline/permission/review and Git-object evidence, compares immutable pins, and queries the exact Actions run/attempt and named validation job/checkout/Full step conclusions. Actual run-on/tree identity is bound to the trusted pin and successful trusted checkout-verification step, not arbitrary JSON printed by landed code. A different workflow, revision, attempt, missing checkout verification or unsuccessful Full cannot certify delivery.

Only publication has `issues: write`, alongside read permissions for objects, PRs and Actions evidence. It performs comment-only API writes. It never invokes landed scripts, setup, hooks, Full or dependency manifests with that write token. PR bodies and API diagnostics are data; receipts retain only bounded, validated essential fields.

## Workflow-facing process protocol

`scripts/delivery-receipt.mjs` is the two-phase workflow process boundary, not a replacement validation suite. Run it from an isolated collection checkout with complete relevant Git objects and configured `origin`. Supply `GH_TOKEN` only to the operation needing GitHub access:

```text
node scripts/delivery-receipt.mjs prepare --repository owner/repo --pr N --run-id RUN --attempt ATTEMPT --orchestration-commit FULL_SHA
node scripts/delivery-receipt.mjs publish --repository owner/repo --pr N --run-id RUN --attempt ATTEMPT --orchestration-commit FULL_SHA --plan trusted-plan.json
```

For automatic admission and final accounting:

```text
node scripts/delivery-push.mjs admit --repository owner/repo --run-id RUN --attempt ATTEMPT --orchestration-commit EVENT_AFTER --event push-event.json
node scripts/delivery-push.mjs summarize --repository owner/repo --run-id RUN --attempt ATTEMPT --orchestration-commit EVENT_AFTER --batch admitted-batch.json
```

Admission emits version-1 JSON with repository, event before/after, run/attempt/orchestration identity, `landings`, `exceptions` and `schedulable`. Exit 0 means admission was recorded, not delivery. Feed every schedulable landing independently into the two-phase receipt process, adding `--landing-commit FULL_SHA` to **both** phases; a changed API landing becomes `admitted_landing_identity_changed`, never a moving replacement. The reusable workflow preserves the manual path while accepting this automatic pin.

Automatic validation provenance requires the push workflow's exact run/path/orchestration and the unique job name `Receipt PR N / FULL_SHA / Exact landing Full`, with the existing successful checkout, verification and shared Full steps. Each landing retains its own validation job ID even though a batch shares one run/attempt. Final accounting also requires that landing's `Persist the delivery assessment` job to succeed. `summarize` emits the complete per-landing JSON result on stdout, returning 0 only for a complete batch and 1 for explicit exceptions or incomplete collection. Invalid inputs/API operations emit fixed-code error JSON; no raw GitHub diagnostics are persisted.

Preparation emits compact version-1 JSON with `repository`, `pr_number`, `run_id`, `run_attempt`, `orchestration_commit`, `provenance`, a declaration-presence flag and `blockers`. Its successful process exit means resolution was recorded, not acceptance: a merged PR can have blockers. Schedule Full only when blockers are empty and acceptance is present, using exactly `provenance.landing_commit` and `landing_tree`. Preserve that trusted plan across the isolated validation job. Do not accept a caller-supplied validation artifact as an authoritative plan.

Publication independently recollects evidence and emits `{ persisted, assessment, comment_id, attempt_id, blockers }` on stdout/exit 0 after a confirmed comment write. `assessment` is `complete`, `pending` or `failed`; a successful collector process is not necessarily delivery. Operation/persistence failure emits fixed-code JSON with `persisted: false` on stderr/exit 1, and the workflow fails visibly. There is no success fallback or retry loop.

Production uses only `https://api.github.com`. `--api-url` accepts an HTTP loopback origin for public-process external-boundary fixtures; arbitrary hosts, credentials and redirects are rejected. GitHub requests and Git operations are bounded to 30 seconds, pagination to 100 pages of 100 items, and receipt content to 60,000 UTF-8 bytes. Exceeding limits fails rather than truncating essential evidence.

Ticket evaluation extends declaration assessment and the strict record shape, not the validation identity or publication proof. Recovery can extend canonical-write coordination and interrupted batch accounting; preserve the event range, per-landing pin and distinct validation/publication job names. Same-landing attempts remain sequential in this slice.

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

IDs and run/attempt links make evidence attributable; essential facts remain in the comment after Actions logs/artifacts expire. A failed/cancelled/blocked evaluation records its actual outcome and leaves missing identities unverified. The record never includes PR prose, review bodies, arbitrary evidence URLs, raw diagnostics, remote URLs, credentials, private runtime inputs or machine-private paths.

Canonical discovery paginates PR comments and requires the matching envelope plus the exact GitHub Actions bot identity and GitHub Actions app ownership. The repository/PR/landing binding and strict historical shape are checked before update. A foreign marker, ambiguous canonical comments, mismatched identity, malformed history, duplicate attempt or exhausted capacity fails without overwriting foreign state or dropping history. Sequential collection updates the same comment and retains earlier outcomes; an earlier complete observation is visibly distinct from a newer failed/pending assessment.

## Scope and pending outcomes

No declaration means repository-change scope. Incidental issue mentions and closing keywords do not associate tickets. This slice conservatively recognizes explicit `<!-- delivery ...`, Markdown `Delivery` headings or `delivery` code fences, including malformed/unterminated forms. Any such declaration produces `explicit_delivery_declaration_unsupported`, a pending ticket-scoped assessment and a separate repository-change result. Its content is not executed or silently ignored. Ticket-gate semantics, evidence attribution and issue pointers are not implemented here.

Provenance uses merged PR data, matching merge timeline, current collaborator permission and Git objects. Ordinary merges require the final head as second parent; squash results need not contain that head. Both require the expected merged tree of the first landing parent and final head. Rebase/cherry-pick/ambiguous mappings and unexpected conflict-resolution edits stay pending rather than being guessed.

The standalone publication boundary is:

```powershell
node ./scripts/check-publication.mjs --landing-commit <full-landing-sha> --remote origin --remote-branch main
```

It observes live main and proves ancestry from that exact tip without fetching or consulting a local target/tracking ref. Missing objects, unavailable observations or unreachable history fail explicitly. The workflow restores objects only in its disposable orchestration checkout before this read-only observation. Advancing main is supported; rewriting away a landing is not. The legacy `check-completion.mjs` and historical local-target receipts retain their original semantics.

The public-process tests in `tests/delivery/receipt.test.mjs` drive manual and push inputs through independent admission/scheduling, the real two-phase process, actual comment effects and final batch accounting. They use disposable real Git repositories/local bare remotes and controlled GitHub/expensive-Full boundaries. They are automatically discovered by the existing authoritative Full entrypoint. They are not actual Windows hosted Full, GitHub token-policy or event-wiring acceptance.
