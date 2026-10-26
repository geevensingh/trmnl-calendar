# Post-human-merge bookkeeping

Use this path after a human has landed the implementation. The [delivery contract](delivery.md) still governs handoff, acceptance, proof, and closure. This procedure is not permission to synchronize a live target, merge a PR, or change issue state.

## 1. Confirm landing and reuse approval

Read the PR's current merged state/actor, base repository/branch, merge timestamp, full head commit, and full resulting merge/squash commit from GitHub. Confirm human landing and that these match the recorded delivery contract. A ready PR, successful checks, or a remote-tracking ref is not evidence of human landing.

Recover the original full reviewed commit, its explicit reviewed base/range, and immutable review/verification evidence. Record the source of the user's explicit synchronization approval and its repository, existing checkout, target, and remote scope. Permission meanings belong in the user's authoritative guidance or approval, not in a new repository-level grant.

Reuse that approval when its scope and safety conditions still apply. Request only genuinely missing or changed authorization. An inaccessible checkout is a **capability** problem, not expired permission; a dirty or divergent checkout is a stop condition, not permission to repair it. Human merging alone does not supply local-synchronization approval.

## 2. Route to a permitted checkout

Check the current host's workspace restrictions **before accessing another checkout**, including read-only inspection. If this feature-worktree session cannot access the existing target checkout, use host session/repository discovery to identify a permitted session backed by that checkout. Inspect its workspace and current activity; reuse it only without interfering with ongoing work. If the host supports opening a session on the existing checkout without switching its branch, that is another route.

Send only the bounded operation: the contract and approval reference, existing checkout identity, expected current branch, configured remote/branch, the preconditions below, and the required returned evidence. The receiving session must confirm its own host access and applicable approval before acting. Do not substitute a new worktree, switch a shared checkout's branch, or treat session creation as new authorization.

Keep each host's session IDs and tools together. Neither `git -C`, shell directory changes, linked-worktree metadata, alternate paths, nor another agent bypasses a host access restriction. If no authorized host-supported route exists, report the actual restriction, the pending `git pull --ff-only origin main` operation (using agreed names), and the missing capability. Preserve the approval reference rather than asking for the same permission or repeatedly telling the user to run it.

## 3. Synchronize only clean, already-published history

Only the permitted target-checkout session performs these steps. The examples use the normal `main` / `origin` / `main` contract; verify and substitute agreed names rather than assuming them. Check each command's exit status; unavailable observations stop the operation.

1. Confirm the checkout is already on the agreed target with `git symbolic-ref --quiet --short HEAD`. Record its full `HEAD` and target IDs; they must agree. Require a clean index and working tree, including all untracked files:

   ```powershell
   git --no-optional-locks status --porcelain=v1 --untracked-files=all --ignore-submodules=none
   git ls-files -v
   ```

   Status must be empty. Lowercase or `S` index tags mean assume-unchanged/skip-worktree visibility restrictions; stop without changing the flags. Detached HEAD, a different branch, or unavailable status also blocks synchronization.

2. Fetch the already-published branch with `git fetch --no-tags origin main`. Resolve the full fetched commit with `git rev-parse --verify FETCH_HEAD` and independently observe the live remote tip:

   ```powershell
   git ls-remote --exit-code --refs --heads origin refs/heads/main
   ```

   Require exactly the agreed ref and the same full commit ID as the fetch. Tracking refs are not live evidence. A missing/unavailable remote, failed fetch, or inconsistent observations stops the operation. Fetch may update objects and fetch/tracking metadata, but must not update the local target branch.

3. Require local target equality or ancestry: `git merge-base --is-ancestor <full-local-target> <full-fetched-tip>` must exit **0**. Exit **1** means ahead/divergent local history; any other failure means ancestry is unavailable. Stop in either case. Record the relationship and observed tips.

4. Immediately recheck branch identity, unchanged local tip, clean status, and unrestricted index visibility. Then perform only:

   ```powershell
   git pull --ff-only origin main
   ```

   Record its exit status. This can fast-forward to already-published history, never create a landing commit. No integration-target push, PR merge, reset, rebase, stash, force update, branch switch, cleanup, or automatic repair is part of this path.

5. Recheck the branch, clean status/index visibility, full local target/HEAD, and a **new live** `ls-remote` observation. Require target/HEAD equality with that live tip. If another actor changed local state or the remote moved, report the observed state as pending proof; do not roll back or force reconciliation. Applicable approval remains recorded, but a fresh preflight is needed before another attempt.

| Blocker | Outcome |
| --- | --- |
| Staged, tracked, or untracked work; hidden index entries | Preserve all work and flags; no pull |
| Local target ahead or divergent | Preserve branch/history; human reconciliation needed |
| Wrong branch, detached HEAD, or inaccessible checkout | Preserve branch identity; use only a permitted existing-target route |
| Missing/failed fetch, remote, or ancestry observation | No pull and no tracking-ref fallback |
| Changed state or unequal tips after pull | Record actual state and pending evidence; no delivery claim or implicit repair |

These observations are not a lock against concurrent actors. A successful pull alone is not delivery evidence.

## 4. Accept the actual resulting content

Use full immutable identities: original reviewed commit **R**, explicit reviewed base **B**, human landing result **L**, and **L**'s first parent **P** (the pre-landing target). Obtain **L** from the merged PR or the confirmed human cherry-pick record, not the current target tip. Verify the objects and parent identities locally. Missing objects, an ambiguous reviewed range, or unavailable comparison evidence leaves acceptance pending.

For an ordinary merge, record whether **R** is an ancestor of **L**. Even when it is, inspect the merge result: conflict resolution or additional edits can change reviewed content. For a squash/cherry-pick, the new identity need not contain **R**; never assert original-commit reachability or use it to bypass the checker.

Compare the reviewed delta **B..R** with the landed delta **P..L**. For example:

```powershell
git diff --raw --no-abbrev --no-renames -z $reviewedBase $reviewed --
git diff --raw --no-abbrev --no-renames -z $landingParent $result --
git rev-parse "${reviewed}^{tree}" "${result}^{tree}"
```

Record both changed-path sets and compare resulting Git entries for their union: object IDs **and modes/types**, with absence recorded for deletions. Treat renames as deletion/addition (`--no-renames`); retain literal paths and parse NUL-delimited output rather than splitting on whitespace. `git --literal-pathspecs ls-tree -r -z --full-tree <full-commit> -- <paths>` supplies resulting entries. Equal whole-tree IDs are stronger content evidence, but do not replace the reviewed-range and landing-parent record.

If the path sets or resulting entries differ, the implementation content changed: retain the comparison and obtain fresh review acceptance and relevant validation for **L** before proceeding. Original reachability or a passing Git proof does not waive this gate.

If they match, establish acceptance of **L** by reference to **R**'s unchanged implementation, comparison evidence, and original review/validation records. Also compare the **B/P** trees for changed pre-landing context and the **R/L** trees for surrounding resulting differences. Changed inputs on overwritten/deleted paths matter even when the final whole trees match. Carry forward only checks whose inputs are demonstrably unchanged; changed build inputs, dependencies, or integration context require fresh relevant review/validation before accepting **L**, even if the implementation entries match. A matching patch ID or commit message alone is insufficient.

For every check/review, say which full commit it actually ran on, the command/scope, result, and durable evidence link. Distinguish **inherited through content comparison** from **rerun on L**. Never describe original Fast/Full/review results as rerun on the resulting commit. This acceptance establishes the new identity; it does not invent a new review or validation result.

## 5. Prove and record before reporting completion

From the clean synchronized checkout, run the [existing read-only proof](delivery.md#executable-read-only-proof) with **L**, now the full accepted resulting commit ID, and the agreed publication contract. Do not modify the checker or weaken its reachability, clean-checkout, or live local/remote-tip-equality requirements. Capture the command's exit status immediately and retain its complete JSON, including failed results. Exit **0** establishes only the Git conditions, not content acceptance or the other delivery gates.

Before a completion claim or an otherwise-authorized agent ticket closure, write a durable ticket comment or linked artifact containing:

| Evidence | Required record |
| --- | --- |
| Contract and authority | Target/remote names, approval source/reference and scope, executing host/session and permitted checkout identity |
| Human landing and synchronization | PR/human record, merge timestamp, old/new full target IDs, clean/index/branch observations, fetched and live tips, ancestry, bounded pull invocation and exit |
| Result acceptance | Full **B**, **R**, **P**, **L**; ancestry and changed-entry comparison, surrounding-context differences, explicit resulting-commit acceptance |
| Verification/review provenance | Commands/scopes, results, actual run-on identities, immutable links, inherited versus rerun evidence, and any renewed acceptance |
| Final proof | Exact invocation with **L**, exit status, full timestamped JSON, and remaining non-Git gates or blockers |

Keep credentials, remote URLs, private runtime inputs, and machine-private paths out of durable records. If a required record cannot be saved, report the persistence blocker and leave completion pending. A delegated synchronization report supplies evidence to this receipt; a child saying "done" does not replace it.

Only when every agreed condition is met may the report say **published/delivered**. Otherwise name the actual pending gate and leave the delivery ticket open. This implementation task does not itself authorize any live synchronization or issue-state change.

## Disposable walkthroughs

`tests\delivery\completion.test.mjs` exercises this recipe with disposable checkouts and local bare remotes through real Git commands and the unchanged proof. It covers approved synchronization via a simulated permitted target session, ordinary/squash/cherry-pick identities, changed results and context, and preserved blocked states. Host access/approval decisions in those tests are synthetic; they do not prove access or authorize operations on a real shared checkout. The existing Full validation scope discovers these tests automatically.
