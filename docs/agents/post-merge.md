# Post-human-merge bookkeeping

Use this path after a human lands the implementation. The [delivery contract](delivery.md) governs acceptance, proof and closure. Repository delivery and independent workstation synchronization are separate operations.

## 1. Resolve human landing and exact content

Read the merged PR's repository/target, final full head, merge/squash result, merged actor and timestamp. Confirm the actor is an authorized human and cross-check the merge timeline against the exact result. Retain actual review IDs, actors, states, submitted times and reviewed commits. Human merging is default acceptance of the exact final revision, not a claim that a separate approval occurred or that additional requirements passed.

Verify the Git objects, landing tree and parents. For an ordinary merge, the second parent must identify the final head. For a squash, original-head ancestry is not required. Compare the landing tree with the merge of the pre-landing first parent and final head. Missing history, conflicting/unexpected content, ambiguous mappings, automation actors and unavailable provenance keep acceptance pending; a commit message or matching patch ID is insufficient.

## 2. Collect a fresh exact-landing receipt

Use [manual receipt collection](../delivery-receipts.md) for the identified human-merged PR. The workflow must already be human-landed on the default branch before dispatch is available. A newly checked-in workflow or fixture pass is not hosted activation.

The read-only Windows validation job checks out the immutable landing and runs the existing setup and `scripts/validate.ps1 -Scope Full`. Record the actual run-on commit/tree, command, outcome and run/attempt. Every collection requires fresh Full: the PR's synthetic evaluation, another commit's green result, inherited checks and matching-tree reuse are not substitutes.

Trusted orchestration independently checks provenance and Actions run/job evidence, observes live `origin/main`, and proves the landing reachable from that exact full tip. It executes no selected-landing code with comment-write credentials. An older landing can complete after main advances; no workstation checkout is part of this proof.

## 3. Read the persisted assessment before reporting

One automation-owned PR comment contains a readable assessment and embedded essential evidence, including sequential attempt history. Check the latest attempt, not just a historical complete observation. Missing or cancelled Full, unavailable API/remote evidence, invalid ownership, exhausted comment capacity and failed writes remain explicit pending/failure outcomes. If persistence fails, report the failed collection run; do not claim a saved receipt.

Absent declarations mean repository-change scope only. The optional [version-1 declaration](../delivery-receipts.md#author-declaration-v1) names delivery issues and their additional acceptance/review gates; malformed or ambiguous declarations stay pending. Incidental issue mentions do not establish scope. Read the separate repository-change and ticket-scoped assessments, individual source facts/blockers and confirmed pointer IDs. External requirements need scoped attributable human acceptance; green Full or human landing does not replace it. Later evidence is reobserved through sequential manual dispatch with fresh Full and live publication, preserving every historical outcome. Collection posts only declared-issue pointers, edits no PR metadata and closes no issues.

Report delivery only after every agreed condition is satisfied and its evidence is durable. A pending or failed latest attempt is not delivery. Use issue references, not automatic closing keywords, until closure is independently authorized and its gate satisfied.

## Independent workstation synchronization

This is optional machine maintenance, not repository-delivery evidence. It executes an existing explicit approval for a bounded checkout/target/remote operation; it grants none. Human landing does not supply synchronization permission.

### Route to a permitted existing checkout

Record the approval source and its repository, existing checkout, target and remote scope. Reuse applicable recorded approval; request only genuinely missing or changed authority. An inaccessible checkout is a capability problem, not expired permission; dirty or divergent state is a stop condition, not permission to repair.

Check host workspace restrictions **before accessing another checkout**, even read-only. If this session cannot access the existing target checkout, use host-supported session/repository discovery to identify a permitted session backed by it. Inspect its workspace/activity and avoid interfering with ongoing work. Opening a session is not authorization to switch a shared branch or substitute a new worktree.

Delegate only the approval reference, existing checkout identity, expected branch/remote, preconditions below and required evidence. The receiving session must confirm its own host access and approval. Keep provider session IDs/tools together. Alternate paths, `git -C`, linked-worktree metadata and another agent do not bypass host restrictions. If no permitted route exists, report the missing capability and pending bounded operation while preserving the approval reference.

### Synchronize only clean, already-published history

Only the permitted existing-target session performs these steps. Verify agreed names; examples use `main` / `origin` / `main`. Check every exit status; unavailable observations stop the operation.

1. Require the checkout already on the target using `git symbolic-ref --quiet --short HEAD`. Record full HEAD/target IDs; they must agree. Require empty status, including untracked files, and unrestricted index visibility:

   ```powershell
   git --no-optional-locks status --porcelain=v1 --untracked-files=all --ignore-submodules=none
   git ls-files -v
   ```

   Lowercase or `S` index tags indicate assume-unchanged/skip-worktree restrictions; stop without changing flags. Wrong branch, detached HEAD or unavailable status also blocks synchronization.

2. Fetch already-published history with `git fetch --no-tags origin main`, resolve full `FETCH_HEAD`, and independently observe:

   ```powershell
   git ls-remote --exit-code --refs --heads origin refs/heads/main
   ```

   Require exactly the agreed ref and the same full fetched/live tip. Missing remote, failed fetch or inconsistent observations stops the operation. Fetch may update objects and fetch/tracking metadata, not the local target.

3. Require local equality or ancestry: `git merge-base --is-ancestor <full-local-target> <full-fetched-tip>` must exit **0**. Exit **1** means ahead/divergent history; any other failure means unavailable ancestry. Preserve state and stop in either case.

4. Immediately recheck branch, unchanged local tip, clean status and index visibility. Perform only:

   ```powershell
   git pull --ff-only origin main
   ```

   Record its exit status. This advances only to already-published history. It permits no target push, PR merge, reset, rebase, stash, force update, branch switch, cleanup or automatic repair.

5. Recheck branch, clean status/visibility, full HEAD/target and a **new live** observation. Require HEAD/target/live-tip equality. Changed local state or a moving remote is pending synchronization proof; preserve it without rollback or forced reconciliation. Record approval, permitted host/session, old/new IDs, observations, ancestry, invocation and exit durably. A fresh preflight is required before another attempt.

These observations do not lock concurrent actors. Successful synchronization is not a delivery receipt and cannot replace exact-landing Full or live publication evidence.

## Legacy walkthroughs

`tests/delivery/completion.test.mjs` preserves disposable real-Git examples of the former local-target contract and the unchanged `check-completion.mjs`. Its approval/host decisions are synthetic, not permission or capability for any live workstation. New manual receipt/publication regressions live in `tests/delivery/receipt.test.mjs`; existing Full discovery includes both.
