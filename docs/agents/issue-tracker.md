# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `geevensingh/trmnl-calendar`.

Before accepting implementation dependencies, reporting delivery, or closing delivery issues, follow the [delivery contract](delivery.md).

Use the agent host's dedicated issue-creation tool when available; otherwise use `gh issue create`. Use the `gh` CLI for the other operations below. Run commands from this clone, or pass `--repo geevensingh/trmnl-calendar`.

## Conventions

- **Create an issue**: provide a title and body to the creation tool, or use `gh issue create --title "..." --body "..."`. For a multi-line CLI body, use `--body-file <path>`.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate `--label` and `--state` filters.
- **Link a sub-issue**: `gh api --method POST repos/geevensingh/trmnl-calendar/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`. Obtain the child's database ID with `gh api repos/geevensingh/trmnl-calendar/issues/<child> --jq .id`. Where sub-issues are unavailable, put `Part of #<parent>` at the top of the child body and add the child to a task list in the parent.
- **Comment**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."`.

GitHub shares one number space across issues and PRs. If an item's type is unclear, resolve it with `gh pr view <number>` or `gh issue view <number>`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When enabled, external PRs use the same triage labels and states as issues, with the corresponding `gh pr` operations.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the issue using the operation above.

## Wayfinding operations

Used by `/wayfinder`. The map is a single issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: link it to the map as a sub-issue, using the fallback above when necessary. Use `wayfinder:<type>` labels: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use native issue dependencies: `gh api --method POST repos/geevensingh/trmnl-calendar/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the blocker's database ID with `gh api repos/geevensingh/trmnl-calendar/issues/<blocker> --jq .id`; use the database ID, not the issue number or node ID. Where dependencies are unavailable, put `Blocked by: #<number>, #<number>` at the top of the child body.
- **Frontier**: list the map's open children, exclude assigned tickets and tickets with unsatisfied dependencies, and choose the first remaining ticket in map order. Apply the [delivery contract's acceptance procedure](delivery.md#acceptance-can-advance-the-frontier) before using native `issue_dependencies_summary.blocked_by` counts or fallback body dependencies.
- **Claim**: `gh issue edit <number> --add-assignee @me`, as the session's first write.
- **Resolve**: for answered decision tickets, comment with the answer, close the ticket, and append a brief result and issue link to the map's Decisions-so-far. Execution/delivery tickets follow the [delivery closure gate](delivery.md#closure-and-final-reporting).
