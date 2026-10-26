# Required CI and manual local validation

**Status: agreed design; not implemented.** This document records the design agreed on 2026-10-25. It does not add a workflow, remove or uninstall hooks, or change GitHub protection settings. The [local validation documentation](../README.md#local-validation) remains the source of truth for current commands and behavior.

## Current state and rationale

The repository has a shared validation entrypoint, `scripts\validate.ps1`, and opt-in Git hooks that run Fast on commit and Full on push. There is no checked-in project CI workflow. During the design discussion, GitHub exposed a dynamic Copilot workflow, but not project validation; the branch-protection API reported `main` as unprotected, and the ruleset query returned no rulesets. Those observations are subject to API visibility and are not permanent proof of configuration.

Validation and merge enforcement are different responsibilities. Hooks provide early local feedback, but contributors can omit or bypass them. They cannot establish a centrally enforced PR requirement. Required CI provides independent, visible evidence for a revision and can prevent merging when validation fails.

Keeping lightweight hooks would be reasonable for earlier feedback, but the agreed choice is to remove repository-managed automatic hooks. Manual validation retains that feedback option without hook-installation maintenance, duplicate local Full runs, or blocking a feature-branch backup on the local toolchain. The trade-off is that contributors who skip local checks learn of failures after pushing.

## Agreed behavior

| Area | Required future behavior |
| --- | --- |
| CI execution | GitHub Actions runs the existing Full validation scope on every PR update, including documentation-only changes. No path-based exemption weakens the required gate. |
| Shared checks | CI and manual local use invoke `scripts\validate.ps1`; do not introduce an independently maintained list of checks. |
| Coverage | Full includes its Fast checks, complete formatting, production .NET/rendering tests, and delivery/guardrail tests. Removing hooks must not silently reduce unrelated coverage. |
| Local feedback | Keep manual Fast and Full commands available. Remove repository-managed automatic hook execution rather than requiring local checks before a commit or push. |
| Merge requirement | `main` requires a PR and a passing Full CI check. Failed, blocked, missing, or unfinished validation is not sufficient to merge. |
| Freshness | Require the PR branch to be up to date with `main`. After another PR changes `main`, a stale PR must incorporate that change and pass again before merging. |
| Bypasses | Apply the PR, required-check, and freshness requirements to administrators too, with no standing bypass exemption. An emergency policy change remains an explicit human-controlled action. |
| Landing | A human performs the merge. Add no auto-merge, merge queue, or permission for agents to advance `main`. |

The implementation must select a stable required-check identity and verify that it corresponds to actual successful Full validation. A workflow existing or a run appearing green does not establish that GitHub enforces the check.

## CI setup and acceptance boundaries

Full validation uses synthetic fixtures and local substitutes. CI must not require the owner's private calendar or production credentials, mutate Azure resources, or deploy the application.

Full has a substantial toolchain, including the selected .NET SDK, PowerShell, Node.js, Ruby/Bundler and native tooling, pinned framework/fonts and Chromium, Functions Core Tools, and Azure CLI/Bicep. Runner selection and provisioning must demonstrate that the existing setup and Full entrypoint work together; toolchain difficulty is not permission to replace Full with a smaller suite or successful skips. Preserve existing version pins and explicit setup/readiness failures.

Live Azure behavior, private-source checks, and physical-device acceptance remain separate, human-controlled evidence where required by the existing delivery contract. Neither a local Full pass nor a green required CI check establishes deployment or delivery completion. This design adds no deployment automation or reviewer-approval quota.

## Hook migration

Retiring repository-managed hooks requires a migration for hooks already installed in Git's shared common hooks directory. Deleting the installer or checked-in script alone does not uninstall those hooks and can leave linked worktrees calling missing tooling.

The implementation must document removal using the existing managed-hook removal mechanism before its supporting tooling becomes unavailable. Preserve edited or foreign hooks, unrelated hooks, and effective `core.hooksPath` configuration; report incomplete removal rather than deleting them. Explain that managed-hook removal from one linked worktree affects other worktrees using the same common hooks directory. Do not silently uninstall hooks as part of this documentation change.

## Implementation and enforcement still pending

This agreement authorizes documentation only. A later implementation must:

1. Provision a suitable GitHub Actions runner and demonstrate successful Full validation through the shared entrypoint.
2. Add PR validation without production credentials or deployment behavior.
3. Retire automatic repository-managed hooks with the migration above, updating directly related documentation and tests without removing unrelated checks.
4. Establish GitHub's required PR, Full-check, freshness, and no-standing-bypass enforcement for `main`, subject to repository feature availability and explicit settings authorization.
5. Verify both successful validation and actual enforcement, including that a failing check or stale branch cannot satisfy the merge gate. Do not land a PR merely to demonstrate enforcement.

Until the workflow and GitHub settings are applied and verified, describe this as an agreed future design, not a protected or CI-enforced repository.
