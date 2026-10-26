# Automated Azure and TRMNL delivery design

**Status: owner-confirmed design, 2026-10-25; not implemented or activated.**
This document records the decisions from the CD design interview. It does not
establish that a queue, deployment identity, workflow, or plugin publishing target
exists. No production changes are authorized by this documentation-only task.

The [architectural decision](adr/0002-coordinate-main-triggered-production-releases.md)
records the rationale. The [Git delivery contract](agents/delivery.md) still makes
landing changes on `main` human-only. The existing
[Azure runbook](azure-delivery.md) describes the current operator procedure.

## Authorization and responsibility

The owner's reviewed merge into `main` will authorize unattended deployment of
that commit. CD must not merge PRs, advance `main`, or deploy unreviewed PR code.
The same authorization covers reviewed changes to the infrastructure plan, not
only application code. There is no second per-release production approval.

Pre-merge CI is a separate workstream. This design assumes every commit reaching
`main` has passed CI; implementing or rerunning that validation is not this CD
workstream's responsibility. CD owns release selection, deployment, deployed-service
verification, release records, queue control, and recovery artifacts.

## Azure ownership boundary

All automated Azure mutations must remain inside **`rg-trmnl-calendar`**. Enforce
the boundary through the deployment principal's effective permissions as well as
target checks. CD must not modify other groups or subscription-wide settings, or
delete/recreate the resource group itself.

Within that boundary, a reviewed merge may authorize:

- Application deployment and infrastructure creation or modification.
- New managed resources, changed role assignments, region/capacity changes, and
  revised budget settings within the group.
- Resource replacement or deletion, including destructive changes to persistent
  storage and Key Vault.

The current approved resource plan remains the starting configuration, not an
immutable allowlist for future reviewed infrastructure changes. New capacity and
resources can increase spending. Budget alerts are not a spending cap.

Track which resources CD manages. Removing a previously managed resource from the
reviewed definition must delete that resource, rather than silently leave an
orphan. Preserve resources CD has never managed. Ordinary incremental Bicep
deployment alone does not provide these removal semantics; implementation must
establish and verify managed-resource ownership and deletion behavior.

Bootstrap the deployment identity, permissions, federation/credentials, and
resource-group-level deployment capability separately through an explicitly
approved setup operation. Do not give ordinary CD subscription-wide permissions
to accommodate the existing subscription-scoped deployment entrypoint. Runtime
identities and the deployment identity have different responsibilities.

Destructive changes can permanently lose data. Retaining earlier code packages is
not a storage backup, a secret backup, or an infrastructure rollback.

## TRMNL ownership boundary

Update the **existing** private plugin's production templates and non-secret
plugin definition. Preserve its configured field values, including the Azure
endpoint, function key, and exclusion rules; do not replace them with defaults.
Renaming or removing configured fields requires an explicit migration that
preserves the intended configuration, not silent value loss.

Establish the target plugin identity before enabling publication. The current
`display\src\settings.yml` has no plugin ID. An unattended publisher must fail
without an established target, never create duplicate plugins on each release.

Before activating real-plugin CD, prove the selected publishing method preserves
configured values using a **temporary test plugin with synthetic values**,
including password-style fields. This is a one-time activation prerequisite, not
a permanent staging environment. If preservation cannot be demonstrated, do not
enable real-plugin publication. No real calendar settings or credentials belong
in test fixtures, logs, or retained test artifacts.

## Selecting release targets

Use an explicit, dependency-aware map of production inputs:

| Input category | Deployment consequence |
| --- | --- |
| Function code and production dependencies; Azure infrastructure and deployment inputs | Azure |
| Production Liquid templates and plugin definition/publishing inputs | TRMNL |
| Shared request/response contract or release inputs affecting both targets | Both |
| Known documentation, test-fixture, or local-workbench-only changes | Neither |
| A changed file that cannot be classified safely | Both |

Include build inputs, lockfiles, deployment scripts, and workflow changes where
they affect a released target. Do not reduce detection to application directories
or classify all `display` files as production: that directory also contains local
workbench code and synthetic scenarios.

After skips, failures, or partial releases, account for each target's actual last
successful deployed commit. A skipped release must not be recorded as deployed or
cause its still-relevant changes to disappear from later release selection.

## Coordination and queue semantics

Two deployment paths belong to one coordinated release system. Pin one exact
`main` commit for each release and bind its packages, hashes, and verification
records to that identity.

For a release affecting both targets, deploy and verify Azure first. Start TRMNL
only after Azure succeeds. A single-target release updates only that target.
Breaking contracts are allowed in coordinated releases, with the owner's
acceptance of possible temporary outages. There is no requirement to preserve the
old plugin contract through a staged migration, and no claim of atomic deployment
across Azure and TRMNL.

Queue **every qualifying commit in order**, with one production release active at
a time. Do not coalesce pending commits, silently discard intermediate releases,
or cancel an active deployment because a newer commit arrived. Implementation
must demonstrate durable, no-loss queue behavior rather than assume a workflow
concurrency setting provides these semantics.

A failed release blocks all successors. Resume only after successful recovery of
that release or the owner's explicit decision to skip it. Retries use the
original commit and retained artifacts, not the current tip of `main`. Explicit
skip and retry operations must leave an attributable release record.

## Verification, failure, and visibility

An accepted upload is not sufficient to declare a release successful.

| Target | Required automated deployed-service evidence |
| --- | --- |
| Azure | Expected deployed functions/bindings and the existing redacted HTTP checks against the released service |
| TRMNL | The intended non-secret definition and templates reached the established plugin target |

Verification must not log calendar contents, credentials, private configuration
values, or raw responses containing them. Existing privacy and bounded-request
requirements still apply. Deployment verification is distinct from pre-merge
CI's synthetic rendering checks.

Do not require the owner to inspect the physical device after each release.
Successful service checks do not prove an offline device refreshed, establish
physical-layout acceptance, or guarantee a cold-start latency.

On deployment or verification failure, stop, report which stages and targets
changed, preserve recovery artifacts, and block the queue. Do not automatically
roll back code, templates, or infrastructure. In particular, if Azure succeeds
but TRMNL fails, record that partial state rather than claim the old release is
still intact. Retain the current and previous successful target artifacts and
the evidence needed to investigate failed attempts; keep recovery content
available rather than merely linking to expired artifacts.

Use GitHub Actions summaries and per-target GitHub deployment records for release
status, with GitHub's normal failed-workflow notifications. No external
notification integration is in scope. Personal notification delivery depends on
the owner's GitHub settings. Records must identify the commit, target results,
verification outcomes, recovery artifacts, and blocked-queue state without private
inputs.

## Activation and implementation acceptance

After separately authorized bootstrap and the synthetic TRMNL preservation
check, the initial release deploys **both targets from the current CI-passed
`main` commit**, establishing a known baseline. Do not replay every historical
commit. Subsequent qualifying commits follow the non-coalescing queue.

The implementation must provide evidence for these behaviors before activation:

- Azure authorization cannot mutate outside `rg-trmnl-calendar` or delete the
  group; managed deletions do not sweep unmanaged resources.
- TRMNL publication targets the existing plugin and preserves configured values.
- Target detection includes relevant dependencies and deployment inputs, skips
  known non-production changes, and selects both targets for unknown changes.
- Multiple queued commits are retained and released in order, including when
  the runner/release controller restarts; no newer run replaces a pending commit.
- Azure failure prevents TRMNL publication; any failed release blocks successors
  until successful retry or explicit skip, with truthful partial-state records.
- Retries and recovery artifacts remain bound to the original release commit.
- Deployed-service checks and GitHub release records meet the privacy requirements.

Choosing the queue implementation, managed-resource deletion mechanism, artifact
storage, and secure deployment tooling remains implementation work. Those
mechanisms must satisfy this contract rather than weaken it to fit a default
GitHub Actions example.

## Primary-source tooling references

- [TRMNL CLI publishing and GitHub Actions](https://github.com/usetrmnl/trmnlp):
  documents updating an existing plugin by ID and unattended authentication.
- [TRMNL OpenAPI specification](https://trmnl.com/api-docs/openapi.yaml):
  documents plugin archive/files import. The schema alone is not an explicit
  guarantee that definition changes preserve every configured field value;
  the synthetic activation check remains required.
- [Azure Functions GitHub Actions deployment](https://learn.microsoft.com/en-us/azure/azure-functions/functions-how-to-github-actions)
  and [the Functions action](https://github.com/Azure/functions-action):
  document OIDC and current Flex Consumption support. Reusing the existing
  CLI-based package deployment is also possible; Flex support is not a reason
  to assume the official action is unavailable.
