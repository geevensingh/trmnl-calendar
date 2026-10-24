# Git delivery contract

This is the authoritative completion workflow for implementation, dependency acceptance, delivery reports, and delivery-ticket closure. An accepted integration commit, successful deployment, or green test suite is not proof of delivery.

## Standing authorization and PR handoff

For the requested task, use a session-owned feature branch in a linked worktree. Reuse a host-provided worktree; otherwise create a dedicated worktree and feature branch before editing. Use host-managed workspace operations where available and preserve other sessions' work.

Unless the user narrows the task's authorization, agents may create that workspace, stage and commit task-related changes, push the feature branch to `origin`, create or update its PR, address feedback, and resolve conflicts on the feature branch without asking again. Push after each coherent commit checkpoint and before a handoff or pause, using an explicit single-branch push. Report failed or blocked pushes; do not substitute bulk, mirror, or tag pushes.

Repository PR policy controls merge-versus-rebase strategy and any published-history rewriting. There is no global rebase requirement. When no policy specifies otherwise, preserve published history and obtain separate authorization before rewriting published commits or force-pushing. Branch deletion, worktree cleanup/pruning, stashing, destructive resets, and credential/protection changes are outside this standing grant.

The default endpoint for substantive implementation is a pushed feature branch and an open PR ready for human review once the agreed review prerequisites are met, unless the user requests a different handoff. Report unmet prerequisites explicitly. Feature-branch backup is not publication to `main`, and **ready for review** is not **delivered**. Keep delivery tickets open until the closure gate below is satisfied.

### Human-only landing

Agents prepare changes for a human to land. They must not advance `main`, the default branch, or another protected/shared integration target by local merge, direct commit or push, PR merge, API call, merge queue, or auto-merge. Do not configure or delegate another agent or automation to bypass this boundary. Updating the session-owned feature branch from its base for conflict resolution is allowed; landing it into the target is human-only.

These are standing instructions, not technical enforcement or changes to tool approvals, credentials, hooks, or GitHub protections.

## Agree before implementation

Record the contract in the issue or session before implementation starts. Use the standing authorization and defaults below without repeating permission requests; confirm only unresolved choices or deviations. The human-only landing boundary remains in force:

| Field | Agreement to record |
| --- | --- |
| Target | The local integration target, normally `main`. This is the human landing target, not permission for an agent to update it. |
| Publication | Normally **remote**, to `origin` branch `main`, after human landing. Verify the configured names. Pushing the feature branch is a separate backup/handoff, not fulfillment of this publication contract. A local-only delivery contract must be explicitly requested; call it locally landed, not published. |
| Verification | The exact existing validation commands/selectors, required outcomes, review, and any scope-specific evidence. Use the [existing local checks](../azure-delivery.md#local-checks-and-package); no new validation entrypoint or live calendar is needed for this workflow. |
| Git writes | The standing feature-branch grant above and any narrower task-specific limits. Record separately authorized exceptions outside that grant; landing remains human-only. |

After review, record the full accepted implementation commit ID and bind verification evidence to that content. If review precedes committing, identify the resulting commit of the unchanged reviewed content. A moving branch name is not a reviewed commit identity.

After the PR handoff, identify human landing and any remaining evidence as pending, and keep the delivery ticket open. The feature-branch grant does not authorize writes to the integration target; neither deployment permission nor a green test suite changes that boundary.

## Delivery states

| State | Git evidence |
| --- | --- |
| **Integrated** | The reviewed implementation commit exists, but is not reachable from the agreed local target. It may satisfy an implementation dependency. |
| **Landed locally** | The reviewed commit is reachable from the local target branch. It need not be the target's tip: an ordinary merge is supported. |
| **Published** | The reviewed commit is locally landed and the **live** agreed remote branch tip equals the local target tip. A local tracking reference is not remote proof. |

These describe Git position, not the whole completion contract. Dirty work or missing verification can still prevent completion. A local check cannot discharge a remote-publication contract. Normal repository delivery requires publication; an explicitly agreed local-only handoff is a different, limited outcome.

The publication check deliberately requires equal target tips. A remote that is behind, ahead, or divergent fails, even if it might contain the reviewed commit. Have a human reconcile any required target-branch writes, then rerun the proof; do not silently weaken the contract.

## Executable, read-only proof

Requires Git and Node.js, with no npm dependencies, Azure access, or private calendar. From the working repository, use the **recorded full reviewed commit ID**, not an unreviewed `HEAD`:

```powershell
$reviewedCommit = '<full accepted implementation commit ID>'
node .\scripts\check-completion.mjs `
  --reviewed-commit $reviewedCommit --target-branch main `
  --publication remote --remote origin --remote-branch main
if ($LASTEXITCODE -ne 0) { throw 'Git delivery proof failed; work is not delivered.' }
```

Use the agreed branch/remote names when different. `--target-branch` defaults to `main`, but `--publication` is required. Remote mode requires both remote options; it accepts a configured remote **name**, never a URL. For an intermediate local proof or an explicitly agreed local-only handoff, use `--publication local` and omit both remote options.

The command emits one JSON report: stdout/exit **0** for satisfied Git conditions, stderr/exit **1** for failure. It records UTC `checked_at`, `reviewed_commit`, `head_commit`, `target_commit`, `remote_commit`, branch/remote names, `working_tree_clean`, `delivery_state`, `git_contract_satisfied`, and fixed `errors`. Unavailable identities remain null. Only full 40- or 64-character commit IDs are accepted; revisions, missing/non-commit objects, invalid/missing branches, uncommitted tracked or untracked work, and unavailable remote evidence fail explicitly.

Index entries marked `assume-unchanged` or `skip-worktree` can hide tracked edits. The check conservatively fails with `index_visibility_restricted` and `working_tree_clean: null` when either flag is present, including sparse checkouts; it leaves those flags unchanged.

Reachability uses Git's commit graph. Remote mode reads the actual advertised branch with `git ls-remote`; it does not fetch objects, refresh tracking refs, or overwrite `FETCH_HEAD`. Each Git command has a ten-second bound and credential prompts are disabled. Git diagnostics and remote URLs are never printed. Optional index locks, filesystem monitoring, Git tracing, lazy object fetches, and replacement objects are disabled for these reads.

The check never edits files, switches branches, commits, merges, rebases, stashes, pushes, deploys, or closes issues. Necessary writes remain subject to the standing grant and human-only landing boundary. Proof is a timestamped observation, not a lock on the local or remote branch; rerun it after relevant changes.

## Acceptance can advance the frontier

Record implementation acceptance with its full reviewed commit ID, verification/review evidence, and the specific dependency it satisfies. Accepted integration work can unblock **implementation-only** dependencies while its delivery ticket remains open.

After recording acceptance, clear only the satisfied implementation dependency's native blocking edge and leave a pointer to that acceptance on the dependent ticket. For fallback body dependencies, annotate the edge as `Satisfied for implementation at <full commit ID>` with the acceptance link. Frontier selection excludes unsatisfied dependencies, not every still-open delivery ticket. Dependencies that require **delivery** remain blocked until the delivery contract is fulfilled. Keep the existing triage vocabulary; no extra delivery labels are needed.

## Closure and final reporting

1. Record required verification results and review acceptance for the implementation content, including any scope-specific evidence. Tests and deployment evidence supplement, rather than replace, Git proof.
2. A human performs landing/publication to the agreed integration target. A squash or cherry-pick creates a new commit identity: establish acceptance/evidence for that resulting commit instead of pretending the original is reachable.
3. From a clean checkout, run the check for the agreed contract. Record its invocation, exit status, and full JSON proof in the ticket or a linked durable artifact **before** closure and the final report, alongside the contract and verification evidence. Keep credentials, remote URLs, and private runtime inputs out of the record.
4. Close a delivery ticket or report delivery complete only when **every** agreed condition is satisfied. Otherwise report the PR handoff as **ready for review**, or describe the actual remaining blocker if it is not ready, and leave the delivery ticket open. After human landing, name any remaining publication or evidence gate. Use issue references rather than automatic closing keywords until the closure gate has been met.

An Azure activation checklist, when part of the ticket, remains an additional gate. The PR handoff adds no CI/CD, branch protection, application behavior, or deployment step.
