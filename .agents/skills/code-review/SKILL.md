---
name: code-review
description: "Review committed or working-tree changes against an explicit or recorded baseline along separate Standards and Spec axes. Use for branch/PR review, pre-commit implementation review, work in progress, or \"review since X\". Runs both reviews in parallel sub-agents and reports them side by side."
---

Two-axis review against a pinned baseline:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Process

### 1. Pin mode, baseline, and scope

Choose **working-tree** mode for implementation/pre-commit review; choose **committed** mode for an explicitly committed-only branch/PR review. An explicit mode wins. If the intended mode is genuinely unclear, clarify it with the baseline question below rather than silently omitting local work.

Use an explicit baseline first (commit, branch, tag, or revision); otherwise reuse the valid implementation-start baseline recorded in this task's issue/session or handoff. Resolve it once to a **full commit ID** with `git rev-parse --verify --end-of-options '<ref>^{commit}'`. A valid explicit or recorded baseline needs no confirmation. An invalid explicit baseline is an error, not permission to fall back to another basis. If the baseline is missing, ambiguous, or invalid, explain the exact problem and ask **once** for a usable baseline; stop until resolved. Never guess `main`, a moving `HEAD`, or a new start point.

Pin the current head too. Preserve the existing merge-base comparison: resolve `git merge-base <baseline-ID> <head-ID>` to the full **comparison basis** and record it separately from the chosen baseline. A missing/nonunique merge-base must be resolved explicitly, not silently replaced. List relevant commits with `git log <basis-ID>..<head-ID> --format='%H %s' -- <scoped-paths>`.

Inventory committed changes since the basis, `git status --short --untracked-files=all`, staged/unstaged differences, and nonignored untracked files. Record an explicit literal file-path scope covering **every intended task change**, including both sides of renames and deletions. List unrelated local work as excluded, with a reason. Whole-file scope is the default; mixed task/user hunks require an explicit task-only candidate and preserved user content, or clarification before dispatch. Neither review nor snapshot preparation stages unrelated work in the real index.

Read [REVIEW-SCOPE.md](REVIEW-SCOPE.md) and create the immutable snapshot there. **Committed** mode compares the basis with the pinned head tree, excluding local edits. **Working-tree** mode compares the basis with the candidate tree containing pinned-head content plus scoped final working files, including task-related untracked files. Its frozen layer patches also expose committed, staged, and unstaged changes; an empty commit list does not mean an empty implementation.

Before dispatch, record mode, full baseline/basis/head/tree identities, literal scope and exclusions, comparison command, relevant full commit list, and the snapshot location. Verify the scoped candidate diff is nonempty. Invalid inputs, conflicts, or an empty effective change produce an explicit outcome with **no reviewers spawned**. Do not create a commit solely to obtain a diff.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. The implementation's already recorded ticket/spec or an explicit source passed by the caller. Read spec files; for tickets, fetch the full current body and comments through the tracker workflow.
2. Issue references in the pinned commit list (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in the tracker doc.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Freeze the review bundle

Save the snapshot, exclusions, spec body/comments, and standards-source contents outside the checkout in the session artifacts. Record source paths/URLs and content identities. Both axes receive this **same bundle**, including all context sources, even though their briefs differ. The smell baseline remains a Standards heuristic, not an added repo rule.

Recheck head, scope, source context, and candidate content before dispatch. If any changed during preparation, discard the stale snapshot and prepare it again. Reviewers read the frozen patches and tree/blob identities (`git show <tree-ID>:<path>` for full candidate files), not live working files or a newly evaluated `HEAD` diff.

### 5. Spawn both sub-agents in parallel

Issue both sub-agent calls together, in the foreground, and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- The shared frozen bundle: mode, full baseline/basis/head/tree identities, literal scope/exclusions, immutable diff command/patches, full commit list, spec, and standards context.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The identical frozen bundle supplied to Standards, including the originating spec and standards sources.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 6. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

Record both reports against the snapshot identity, with required validation results and any explicit acceptance decision. Passing findings alone does not establish that a later commit was reviewed.

### 7. Bind unchanged content

For committed mode, acceptance identifies the pinned reviewed head commit. For working-tree mode, return the reviewed snapshot to the implementer **before committing**. After the required review/validation gates, follow [REVIEW-SCOPE.md](REVIEW-SCOPE.md#bind-the-resulting-commit) to bind the unchanged candidate to its full implementation commit ID. Recheck before committing and verify the resulting commit afterward. Content, context, or scope changes renew the affected review/verification; they do not inherit acceptance. Keep the delivery contract's separate human landing/publication gates.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
