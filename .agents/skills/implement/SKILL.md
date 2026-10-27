---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Before implementation, establish the contract in `docs/agents/delivery.md`; use that reference for dependency acceptance, final reporting, and ticket closure.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Before editing, record the full implementation-start commit (`git --no-replace-objects rev-parse --verify 'HEAD^{commit}'`), the originating ticket/spec, and the intended task scope in the session or issue. Reuse a valid baseline already recorded for this implementation. Keep this identity fixed across later commits.

Call the Skill tool with "tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once the implementation is ready, call the Skill tool with "code-review" in **working-tree** mode, passing the recorded baseline, spec, and intended task scope. Review the complete task change, including earlier implementation commits, staged and unstaged edits, and task-related untracked files. Preserve and explicitly exclude unrelated user work; isolate mixed-purpose files/hunks before treating them as task-only.

Satisfy the required validation and separate Standards/Spec review gates **before committing**. Fixes or scope changes invalidate the affected evidence: refresh the snapshot, rerun the affected validation, and renew review of changed content. A commit is not needed to make a review diff nonempty.

Commit only task content to the current feature branch under the delivery contract. Follow `code-review`'s [snapshot and commit-binding procedure](../code-review/REVIEW-SCOPE.md) to verify that the resulting full commit ID contains the unchanged reviewed tree and has the recorded review head as its parent. If all reviewed content was already committed, bind to that reviewed commit without creating another. Record the commit ID alongside the snapshot and review/validation evidence; only then report implementation acceptance.
