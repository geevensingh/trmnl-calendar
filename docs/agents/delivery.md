# Git delivery contract

This is the authoritative completion workflow for implementation, dependency acceptance, delivery reports, and delivery-ticket closure. An accepted integration commit, successful deployment, or green test suite is not proof of delivery.

## Agree before implementation

Record the contract in the issue or session and confirm it before implementation starts:

| Field | Agreement to record |
| --- | --- |
| Target | The local target branch. Normally `main`, regardless of the current integration branch. |
| Publication | Normally **remote**, to `origin` branch `main`. Confirm the configured remote name and branch explicitly. A local-only handoff must be explicitly requested; call it locally landed, not published. |
| Verification | The exact existing validation commands/selectors, required outcomes, review, and any scope-specific evidence. Use the [existing local checks](../azure-delivery.md#local-checks-and-package); no new validation entrypoint or live calendar is needed for this workflow. |
| Git writes | Which branch/worktree operations, commits, merges/rebases, pushes, and cleanup are authorized. Permission for one operation does not grant the others. |

After review, record the full accepted implementation commit ID and bind verification evidence to that content. If review precedes committing, identify the resulting commit of the unchanged reviewed content. A moving branch name is not a reviewed commit identity.

Unspecified merge or push permission means **ready-to-land**, not permission to write. State the pending operation and request approval; keep the delivery ticket open. Deployment permission does not imply permission to merge or push.

## Delivery states

| State | Git evidence |
| --- | --- |
| **Integrated** | The reviewed implementation commit exists, but is not reachable from the agreed local target. It may satisfy an implementation dependency. |
| **Landed locally** | The reviewed commit is reachable from the local target branch. It need not be the target's tip: an ordinary merge is supported. |
| **Published** | The reviewed commit is locally landed and the **live** agreed remote branch tip equals the local target tip. A local tracking reference is not remote proof. |

These describe Git position, not the whole completion contract. Dirty work or missing verification can still prevent completion. A local check cannot discharge a remote-publication contract. Normal repository delivery requires publication; an explicitly agreed local-only handoff is a different, limited outcome.

The publication check deliberately requires equal target tips. A remote that is behind, ahead, or divergent fails, even if it might contain the reviewed commit. Reconcile the intended target using separately authorized operations and rerun the proof; do not silently weaken the contract.

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

Reachability uses Git's commit graph. Remote mode reads the actual advertised branch with `git ls-remote`; it does not fetch objects, refresh tracking refs, or overwrite `FETCH_HEAD`. Each Git command has a ten-second bound and credential prompts are disabled. Git diagnostics and remote URLs are never printed. Optional index locks, filesystem monitoring, Git tracing, lazy object fetches, and replacement objects are disabled for these reads.

The check never edits files, switches branches, commits, merges, rebases, stashes, pushes, deploys, or closes issues. Perform any necessary writes separately, with approval. Proof is a timestamped observation, not a lock on the local or remote branch; rerun it after relevant changes.

## Acceptance can advance the frontier

Record implementation acceptance with its full reviewed commit ID, verification/review evidence, and the specific dependency it satisfies. Accepted integration work can unblock **implementation-only** dependencies while its delivery ticket remains open.

After recording acceptance, clear only the satisfied implementation dependency's native blocking edge and leave a pointer to that acceptance on the dependent ticket. For fallback body dependencies, annotate the edge as `Satisfied for implementation at <full commit ID>` with the acceptance link. Frontier selection excludes unsatisfied dependencies, not every still-open delivery ticket. Dependencies that require **delivery** remain blocked until the delivery contract is fulfilled. Keep the existing triage vocabulary; no extra delivery labels are needed.

## Closure and final reporting

1. Record required verification results and review acceptance for the implementation content, including any scope-specific evidence. Tests and deployment evidence supplement, rather than replace, Git proof.
2. Perform only authorized landing/publication operations. A squash or cherry-pick creates a new commit identity: establish acceptance/evidence for that resulting commit instead of pretending the original is reachable.
3. From a clean checkout, run the check for the agreed contract. Record its invocation, exit status, and full JSON proof in the ticket or a linked durable artifact **before** closure and the final report, alongside the contract and verification evidence. Keep credentials, remote URLs, and private runtime inputs out of the record.
4. Close a delivery ticket or report delivery complete only when **every** agreed condition is satisfied. Otherwise report integrated or locally landed work as **ready-to-land**, naming the remaining permission, publication, or evidence gate, and leave the delivery ticket open. Use issue references rather than automatic closing keywords until the closure gate has been met.

An Azure activation checklist, when part of the ticket, remains an additional gate. This workflow adds no CI/CD, PR requirement, branch protection, application behavior, or deployment step.
