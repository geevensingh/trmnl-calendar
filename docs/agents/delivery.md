# Git delivery contract

This is the authoritative completion workflow for implementation, dependency acceptance, delivery reports, and delivery-ticket closure. An accepted integration commit, successful deployment, or green test suite is not proof of delivery.

## Standing authorization and PR handoff

For the requested task, use a session-owned feature branch in a linked worktree. Reuse a host-provided worktree; otherwise create a dedicated worktree and feature branch before editing. Use host-managed workspace operations where available and preserve other sessions' work.

Unless the user narrows the task's authorization, agents may create that workspace, stage and commit task-related changes, push the feature branch to `origin`, create or update its PR, address feedback, and resolve conflicts on the feature branch without asking again. Push after each coherent commit checkpoint and before a handoff or pause, using an explicit single-branch push. Report failed or blocked pushes; do not substitute bulk, mirror, or tag pushes.

Repository PR policy controls merge-versus-rebase strategy and any published-history rewriting. There is no global rebase requirement. When no policy specifies otherwise, preserve published history and obtain separate authorization before rewriting published commits or force-pushing. Branch deletion, worktree cleanup/pruning, stashing, destructive resets, and credential/protection changes are outside this standing grant.

The default endpoint for substantive implementation is a pushed feature branch and an open PR ready for human review once the agreed review prerequisites are met, unless the user requests a different handoff. Report unmet prerequisites explicitly. Feature-branch backup is not publication to `main`, and **ready for review** is not **delivered**. Keep delivery tickets open until the closure gate below is satisfied.

### Human-only landing

Agents prepare new changes for a human to land. Landing on `main`, the default branch, or another protected/shared integration target by local merge, direct commit or push, PR merge, API call, merge queue, or auto-merge remains human-only. Do not configure or delegate another agent or automation to bypass this boundary. Updating the session-owned feature branch from its base for conflict resolution is allowed; landing it into the target is not.

After a human merges, follow [post-human-merge bookkeeping](post-merge.md) to collect the actual landing's durable receipt. Workstation synchronization is independent, not a repository-delivery gate. It still requires applicable recorded approval, a permitted host/checkout, and the clean fast-forward-only safeguards in that procedure; human landing grants no workstation permission.

These are standing instructions, not technical enforcement or changes to tool approvals, credentials, hooks, or GitHub protections.

## Agree before implementation

Record the contract in the issue or session before implementation starts. Use the standing authorization and defaults below without repeating permission requests; confirm only unresolved choices or deviations. The human-only landing boundary remains in force:

| Field | Agreement to record |
| --- | --- |
| Target | The human landing target, normally `main`, not permission for an agent to update it. |
| Publication | Normally live `origin/main`, with the accepted landing reachable from the observed full tip. Verify configured names. A feature-branch push is backup/handoff, not publication under this contract. Explicit local-only agreements remain limited local handoffs. |
| Verification | Required implementation checks/review and extra gates, plus fresh `scripts/validate.ps1 -Scope Full` on the exact human landing. Use the [existing local checks](../azure-delivery.md#local-checks-and-package); a pre-merge result or matching tree cannot replace post-merge Full. |
| Git writes | The standing feature-branch grant above and any narrower task-specific limits. Record separately authorized exceptions outside that grant; landing remains human-only. |

After review, record the full accepted implementation commit ID and bind verification evidence to that content. If review precedes committing, identify the resulting commit of the unchanged reviewed content. A moving branch name is not a reviewed commit identity.

After the PR handoff, identify human landing and remaining evidence as pending, and keep the delivery ticket open. Once human landing is confirmed, use the [post-merge procedure](post-merge.md); a workstation's availability or synchronization is not a prerequisite.

## Delivery states

| State | Git evidence |
| --- | --- |
| **Integrated** | The reviewed implementation exists and may satisfy an implementation dependency; human landing remains pending. |
| **Human-landed** | Authoritative merged-PR and Git-object evidence identifies the actual accepted landing, including a squash's new identity. |
| **Published** | The accepted landing is reachable from the full **live** agreed remote branch tip at the recorded observation time. It need not remain the tip. |

These describe evidence, not the whole completion contract. Repository-change delivery additionally requires fresh exact-landing Full and a persisted receipt. Ticket-scoped delivery additionally requires every explicitly declared gate. An existing workstation checkout, its cleanliness and tip equality are not part of repository delivery.

An authorized human's merge of the exact final PR revision is default acceptance, not an invented separate review approval. Retain actual review records. Ambiguous provenance, unexpected merge content, automation actors or missing evidence leave acceptance pending. Ordinary merges and squash results are compared using their real parents and merged tree; original-head ancestry is not required for a squash.

## Executable, read-only proof

The repository-publication proof requires Git and Node.js, complete relevant objects, and a configured remote. Use the full **actual landing** identity, not the original head or a moving ref:

```powershell
$landingCommit = '<full accepted landing commit ID>'
node .\scripts\check-publication.mjs `
  --landing-commit $landingCommit --remote origin --remote-branch main
if ($LASTEXITCODE -ne 0) { throw 'Live publication is pending.' }
```

The remote name and branch default to `origin` and `main`; use the agreed names when different. The command observes the advertised branch with `git ls-remote`, requires that exact observed tip's object, and proves landing ancestry from it. Cached refs, unavailable objects and unreachable landings fail explicitly. Restore missing history only in a permitted disposable collection checkout; no workstation synchronization is needed.

It emits JSON on stdout/exit **0** for reachability or stderr/exit **1** otherwise: `checked_at`, `landing_commit`, `remote`, `remote_branch`, `remote_commit`, `reachable`, and fixed `errors`. Only full 40- or 64-character commit IDs are accepted. A later reachable landing may complete even after main advances. The timestamp is an observation, not a lock on history.

The proof neither fetches nor changes files, branches, refs, `FETCH_HEAD`, configuration, or index flags. Reads remove inherited Git selectors, disable replacement/lazy objects, tracing and filesystem monitoring, suppress credential prompts, and have a 30-second per-command bound. Diagnostics, remote URLs and machine-private paths are excluded. This proves publication only, not acceptance, Full or ticket gates.

Use the [manual receipt workflow and operator protocol](../delivery-receipts.md) for the complete path. It separates exact-landing validation from trusted comment publication and stores essential evidence plus sequential attempt history in one automation-owned PR comment. Optional version-1 declarations explicitly associate tickets and their acceptance/review gates; malformed, ambiguous or unsupported declarations remain pending. Only declared issues receive idempotent receipt pointers, with state and substantive requirements unchanged. Repository-change success does not waive missing ticket evidence or pointer persistence.

### Legacy/local-target proof

`scripts/check-completion.mjs` is unchanged. Its `--reviewed-commit`, `--target-branch` and `--publication local|remote` interface still measures local-target reachability, clean/unrestricted checkout state and, in remote mode, exact local/live-remote tip equality. Its `delivery_state` and `git_contract_satisfied` fields retain their original meanings. It remains useful for explicit local handoffs or independent workstation checks; it is not the new remote-only delivery contract. Historical receipts and tests are not retroactively reinterpreted, and running this checker in an Actions checkout is not a substitute for the new proof.

## Acceptance can advance the frontier

Record implementation acceptance with its full reviewed commit ID, verification/review evidence, and the specific dependency it satisfies. Accepted integration work can unblock **implementation-only** dependencies while its delivery ticket remains open.

After recording acceptance, clear only the satisfied implementation dependency's native blocking edge and leave a pointer to that acceptance on the dependent ticket. For fallback body dependencies, annotate the edge as `Satisfied for implementation at <full commit ID>` with the acceptance link. Frontier selection excludes unsatisfied dependencies, not every still-open delivery ticket. Dependencies that require **delivery** remain blocked until the delivery contract is fulfilled. Keep the existing triage vocabulary; no extra delivery labels are needed.

## Closure and final reporting

1. Record required verification results and review acceptance for the implementation content, including any scope-specific evidence. Tests and deployment evidence supplement, rather than replace, Git proof.
2. A human performs landing/publication to the agreed target. Follow [post-human-merge bookkeeping](post-merge.md) to resolve the actual result and default human-merge acceptance while retaining actual reviews and extra requirements.
3. Run fresh Full on the exact landing, observe live publication, and persist essential identities, outcomes, provenance, blockers and run/attempt identity in the canonical receipt **before** claiming completion. A prior complete observation does not make a newer pending/failed attempt complete. Keep credentials, remote URLs, private runtime inputs and machine-private paths out of the record.
4. Close a delivery ticket or report delivery complete only when **every** agreed condition is satisfied. Otherwise report the PR handoff as **ready for review**, or describe the actual remaining blocker if it is not ready, and leave the delivery ticket open. After human landing, name any remaining publication or evidence gate. Use issue references rather than automatic closing keywords until the closure gate has been met.

An Azure activation checklist remains an additional gate. A repository-change receipt does not certify a delivery ticket. Collection grants no landing, deployment, workstation synchronization, protection/credential changes or ticket closure.
