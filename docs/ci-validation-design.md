# Required CI and manual local validation

**Status: implementation prepared; owner-authorized protection configured and read back; hosted Full success and behavioral enforcement acceptance pending.** This implements the design agreed on 2026-10-25 and specified in [#39](https://github.com/geevensingh/trmnl-calendar/issues/39). A checked-in workflow or a settings readback is not proof of successful Full execution or actual failing/stale-PR rejection. The [local validation documentation](../README.md#local-validation) describes current commands and the explicit hook migration.

## Validation and enforcement are separate

[`.github/workflows/full-validation.yml`](../.github/workflows/full-validation.yml) runs the existing `scripts\validate.ps1 -Scope Full` on PR creation, head updates, reopening and base-ref retargeting. Draft and documentation-only PR commits are included. It listens for `opened`, `synchronize`, `reopened` and `edited`, but admits an `edited` event to Full only when `changes.base.ref.from` is nonempty. A base retarget changes the evaluated merge revision without necessarily changing the head SHA, so ignoring every `edited` event would violate #39's evaluated-revision requirement. Body/title edits do not submit new content; draft/readiness activities are not triggers. There are no path or target-branch exemptions, and no admitted revision substitutes a smaller suite or successful skip for Full.

The workflow checks out the event-pinned PR **head** with complete history, then uses `scripts\prepare-ci.mjs` to construct and verify a detached evaluation commit from the event-pinned **base and head**, before selecting manifest-based .NET/Ruby tooling or running setup and Full. It does not trust GitHub's mutable `refs/pull/<number>/merge`: the #51 retarget probe proved that ref can still describe the old base after a qualifying new-base event starts. It never uses `pull_request_target`.

Workflow name **Full validation** and job ID **full** are stable. There is one non-matrix job with one shared validation implementation. For admitted events its job/check name is exactly **Full validation**; configure that actual check-run context, produced by **GitHub Actions**, as required. For rejected title/body-only events the job is skipped under a distinct, non-required name. The expression's intended metadata label is **PR metadata only (not validation)**, but #51's actual skipped check carried the **unexpanded name expression**, not that friendly label. Crucially neither equals the exact required context. This name separation is essential: GitHub can treat a skipped required check as successful, so a rejected event must never create a skipped/success substitute called `Full validation`. Do not require the metadata check, a setup-step name, a workflow-file path, a concatenated display label or an unrelated check with a similar name. Changing the admitted check identity requires a coordinated protection change.

Setup and Full execute in that same admitted job with default failure propagation and a 45-minute timeout. A failed action, setup command, missing prerequisite, blocked component or nonzero validation exits unsuccessfully. No `continue-on-error` or successful fallback permits an incomplete Full run to appear successful. Cancellation is job-level, after event admission, not workflow-level: qualifying events share a per-PR concurrency group so newer content or a base retarget supersedes obsolete validation. Rejected metadata events also have a run-unique metadata group as a fail-safe against interfering with admitted jobs, independent of scheduler evaluation order. Metadata-only edits therefore neither replace the required check nor restart/cancel expensive validation of unchanged content. A dispatch run is diagnostic evidence, not a substitute for the required check on the PR revision.

CI is validation, not landing. Humans still merge; no auto-merge, merge queue, reviewer-approval quota or permission for agents to advance `main` is introduced. Full remains available manually; Fast is optional early feedback, not a replacement required check. Contributors who skip local checks learn of failures after pushing instead of blocking a feature-branch backup on their local toolchain.

### Event-pinned evaluated revision

`prepare-ci.mjs --head-commit <full-event-head-sha> --base-commit <full-event-base-sha>` is CI checkout preparation, **not another validation entrypoint**. It resolves only exact existing commit objects, requires complete history and a clean detached checkout with no hidden index entries, and uses Git **2.38+** `merge-tree --write-tree` without updating branches or protected refs. Conflicts, missing history/objects, invalid pins or failed verification terminate the required job unsuccessfully before Full; an old merge ref is never a fallback.

The local synthetic commit has the event base as its first parent and head as its second (one parent when the pins are identical), with deterministic identity/timestamps. Preparation verifies the recorded parents and merge tree, then the detached checkout's HEAD, index tree and clean state. Its JSON output records the exact `head_commit`, `base_commit`, `evaluated_commit`, `evaluated_tree` and actual `evaluated_parents`. All Git subprocesses have a 30-second bound and remove inherited `GIT_*` selectors/configuration. Checkout uses a command-local empty hooks directory; it neither executes nor changes installed hooks or on-disk Git configuration. Only the disposable CI checkout and local Git objects change; no synthetic commit is pushed, and no token write permission or extra check implementation is introduced.

The real disposable-Git/public-process regression starts with a stale advertised PR merge against the old base and an absent new-base sentinel, then verifies both submitted head content and the new-base sentinel after preparation, exact parents/tree, detached HEAD, unchanged named refs and repeatability. Further cases cover conflicts, incomplete history, invalid/missing pins, dirty/attached/hidden-index checkouts, foreign hooks and byte-for-byte preservation of a foreign owner under inherited Git selectors. These tests join Full through its existing Node discovery. Dispatch remains diagnostic: it evaluates its selected revision without pretending to be a PR merge.

## Runner provisioning and preserved coverage

The **windows-2025** GitHub-hosted image supplies PowerShell 7, Git, Azure CLI and native Windows support for the existing process interfaces. The workflow explicitly selects Node **22**, installs the SDK selected by **global.json** and the .NET **8** SDK/runtime needed by Functions tooling alongside the selected .NET/ASP.NET Core **10** runtime, and selects Ruby **4.0** with RubyInstaller's compatible MSYS2/Devkit through `ruby/setup-ruby`. Bundler comes from **Gemfile.lock** (**4.0.20**); action-level bundle restoration/caching is disabled so the existing setup owns worktree-local state.

Explicit provisioning installs Functions Core Tools **v4**, verifies the runner's Azure CLI and installs/verifies its local Bicep compiler. This does not log in or compile/deploy live resources. As before, those tool families have no narrower repository version pin. Provisioning failure is fatal; runner-image drift must be repaired, not bypassed by dropping checks.

Only then does `scripts\setup-display.ps1` restore frozen gems, including `trmnl-liquid` **0.8.2**, compile/load a native extension, acquire framework **3.4.3** and referenced fonts, restore/build the harness and install the Chromium revision selected by Microsoft.Playwright **1.56.0**. Existing SDK roll-forward, dependency constraints, runtime selection and asset pins remain unchanged. Setup acquires prerequisites; validation never installs/restores them as a fallback. Both suppress SDK certificate generation before the first SDK invocation.

Full includes complete read-only formatting, Fast build/syntax checks, the **unfiltered** production .NET suite using the real local Functions host, Liquid, framework/fonts and pinned Chromium, and all delivery/guardrail Node tests. Hook tests now exercise retirement/migration rather than obsolete installation/publication rules. Unrelated rendering, delivery, process-error and Git-isolation regressions remain in Full.

The job has only `contents: read` token permission, does not persist checkout credentials, references no repository/production secrets and needs no Azure login, private calendar or TRMNL account. Inputs are synthetic, storage/HTTP substitutes are local and Git fixtures use disposable repositories/bare remotes. It performs no deployment or live Azure mutations. Live Azure/private-source/device acceptance and the [delivery contract](agents/delivery.md) remain independent gates.

## Explicit hook migration

Automatic repository-managed `pre-commit`, `pre-merge-commit` and `pre-push` installation is retired. `scripts\git-hooks.ps1 -Action Install` fails with manual-validation and migration guidance without writing hooks/configuration. The command remains as a **Status/Remove migration interface** so deleting tracked tooling cannot strand old installed hooks.

Coordinate with linked-worktree users, then run from a checkout containing this migration:

```powershell
.\scripts\git-hooks.ps1 -Action Status
.\scripts\git-hooks.ps1 -Action Remove
```

Status is read-only. Removal recognizes only exact historical generated v1 bytes and is repeatable when hooks are absent. It removes unchanged hooks from Git's **common default hooks directory**, affecting every linked worktree using that directory, including older branches. It preserves foreign/edited hooks, unrelated files, linked entries/directories, effective `core.hooksPath` settings and all configured destinations without changing Git configuration. A preserved target produces explicit nonzero partial-removal failure, not a successful migration claim. Custom validation invocations require their owner's manual decision. Neither checkout, CI nor setup silently migrates a contributor's real hooks.

## Owner-authorized protection configuration

Settings changes require separate explicit human authorization; code/feature-branch permission does not authorize them. The initial implementation-time read on **2026-10-26 UTC** returned `404 Branch not protected` and an empty repository ruleset list. Later that day, the owner separately authorized the coordinator to configure protection. A subsequent independent read of `branches/main/protection` confirmed:

| Setting | Observed value |
| --- | --- |
| Required PR | Non-null `required_pull_request_reviews`, zero required approvals |
| Required check/source | `Full validation`, GitHub Actions `app_id: 15368` |
| Branch freshness | `required_status_checks.strict: true` |
| Administrator enforcement | `enforce_admins.enabled: true` |
| Additional review quota | No code-owner or last-push approval requirement |
| Force pushes/deletions | Both disabled |
| Standing bypass allowances | None configured; personal-repository response omits organization-only allowance fields |

The implementation child did not change settings. Genuine hosted Full success and corrected evaluated-revision acceptance remain pending. The initial [run 40272218917](https://github.com/geevensingh/trmnl-calendar/actions/runs/40272218917) was cancelled when a PR-body edit triggered [replacement run 40273825259](https://github.com/geevensingh/trmnl-calendar/actions/runs/40273825259) at the same `bb991313fab3230d5fd59a3e88b3e10d9bbc48db` revision. That is an orchestration cancellation, not a test failure. The subsequent #51 probe observed correct event admission and metadata isolation but exposed the stale merge-ref defect described below.

### Observed event boundary and wrong-base checkout

The coordinator's [closed, unmerged #51 probe report](https://github.com/geevensingh/trmnl-calendar/pull/51#issuecomment-6409133451) records actual GitHub behavior, not a YAML snapshot:

| Event | Observed outcome |
| --- | --- |
| Open/title edit | [Creation run 40275227660](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275227660) stayed active after a title-only edit. [Metadata run 40275265599](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275265599) contained only a skipped check named by the raw expression, distinct from `Full validation`. |
| Draft/readiness | Toggling these states created no runs. |
| Documentation-only commit | Head `24103fb45bb5b98c3183ef2d589cff4521f2bcb0` triggered [run 40275493244](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275493244) and correctly superseded obsolete validation. |
| Base retarget, unchanged head | Retargeting from main `80062fd2a27de65ea1424599f71d6b8be2770b30` to synthetic base `a58dedef4dd221650751bc3a1f7b0022f92d4fe1` admitted genuine Full [run 40275569916](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275569916) and canceled the prior run. **Checkout was wrong:** GitHub still supplied merge `558e2d5c0b7553edfd2ae965f9978ffb8fe25f36` with old base/head parents and tree `606cae4904a9c23a2a3576ecf73a1a32fd3bd546`; the new-base sentinel was absent. The coordinator canceled after capturing checkout evidence, not because a production test failed. |

This violates #39's requirement to bind the check to **"the revision GitHub evaluates for the PR, not an unrelated job or an earlier green revision."** Admitting the retarget event is insufficient if Full still validates the old base. Pinned preparation addresses that cause locally; the corrected workflow must still pass a new live retarget probe. Never integrate #51's disposable marker head or synthetic base commits into delivery content.

### Observed negative enforcement gates

The coordinator recorded these observations on **2026-10-26 UTC**; they establish negative evidence, not a successful Full run or completed delivery:

| Probe | Observed evidence |
| --- | --- |
| Failed required Full | [#50's durable probe report](https://github.com/geevensingh/trmnl-calendar/pull/50#issuecomment-6408958965): normal setup passed, deliberate removal of generated `plugins.js` made the unchanged shared Full prerequisites fail, all six dependents were `BLOCKED`, and the process exited 1. [Run 40274033178](https://github.com/geevensingh/trmnl-calendar/actions/runs/40274033178) failed in 4m46s; actual `Full validation` check `121412847257`, app `15368`, concluded `failure`. The non-draft, conflict-free, up-to-date probe was `BLOCKED` with that sole failed check. The PR is closed **unmerged**. Never integrate its intentional-fault commit `ee6e59a1c63bbf76040e2a7fa4d5689de334c608`. |
| Missing required check | [#40](https://github.com/geevensingh/trmnl-calendar/pull/40) was non-draft and reported `BLOCKED` with no checks; the coordinator confirmed its branch was fresh. |
| Stale branch | [#37](https://github.com/geevensingh/trmnl-calendar/pull/37) was non-draft and reported `BEHIND`. Updating a stale branch and observing fresh Full success remains outstanding. |

These probes neither merged into `main` nor disabled protection to test rejection. Recheck settings and evaluated identities when collecting further evidence; observations are time-bound.

For a new installation or separately authorized repair, use **Settings > Branches > Add branch protection rule** (classic protection) for the exact pattern **`main`**:

1. Enable **Require a pull request before merging**. Do not add an approval quota, code-owner review requirement, last-push approval requirement or PR-bypass actor.
2. Enable **Require status checks to pass before merging**, select **Full validation** from **GitHub Actions**, and enable **Require branches to be up to date before merging**.
3. Enable **Do not allow bypassing the above settings** so administrators are included. Leave force pushes and deletions disallowed. Do not add standing bypass allowances. Save, then independently inspect effective settings and mergeability.

The intended classic REST configuration has `required_status_checks.strict: true`, one check with `context: "Full validation"` and `app_id` equal to the **observed GitHub Actions app ID**, `enforce_admins.enabled: true`, and a non-null `required_pull_request_reviews` object with `required_approving_review_count: 0` and no PR-bypass allowances. Force pushes/deletions remain disabled. Personal repositories reject organization-only fields such as `bypass_pull_request_allowances`, even when their actor lists are empty; omit unsupported fields rather than adding an exemption. Preserve any other existing protections; do not replace live settings blindly with a partial payload. For a ruleset instead, use **Active** enforcement, target only `refs/heads/main`, require PRs, the same app-bound check and strict freshness, and leave the **entire bypass list empty**, including administrators. Check overlapping rules/rulesets as well.

Public repositories support protection on GitHub Free; private visibility or plan changes can alter availability. A forbidden/unavailable API, unsupported plan, inability to bind the source app, bypass exemption or missing separate authorization is an **enforcement blocker**, never permission to weaken the requirement. Administrators can deliberately edit policy in an emergency, but that is a separate human-controlled policy change, not a permanent bypass.

## Hosted execution and enforcement acceptance (pending)

Record full implementation/event-head/event-base/prepared-commit/prepared-tree identities, verified parents, UTC observation time and run/check URLs for each observation. Keep GitHub's advertised test-merge/check-head SHA separately: it can differ from the prepared evaluation commit and can be stale after retargeting. Local or substituted-process tests do not prove runner readiness. A green hosted run does not prove protection.

1. **Bootstrap on the existing integration PR.** The coordinator integrates the implementation into the feature branch of [PR #38](https://github.com/geevensingh/trmnl-calendar/pull/38) through its authorized review/integration process. A PR head update with the workflow present triggers `pull_request` even before the workflow lands on `main`. Inspect the evaluated revision and verify every provisioning/setup step and actual **Full** execution completes successfully on `windows-2025`; save its component summary, unfiltered .NET/Node totals and run URL. Do not mark this gate met with substitute tools.
2. **Bootstrap constraints.** Pushing a child implementation branch without a PR does not trigger this PR-only workflow. `workflow_dispatch` is also provided for diagnostics, but GitHub requires the workflow to exist on the default branch before it can be dispatched by name with `--ref`. Do not bypass that by pushing to `main`, altering Actions settings or creating extra credentials. If Actions policy, fork approval, runner capacity, downloads or toolchain provisioning blocks execution, record that blocker and keep hosted acceptance pending.
3. **Content, metadata and base-retarget regression.** Repeat #51's admitted-event/noninterference observations on the corrected implementation using an authorized disposable PR, not delivery PR #38. Observe creation and a docs-only head update; ensure a genuine `Full validation` check evaluates each revision and newer content supersedes obsolete work. During Full, edit only title/body and confirm the active run stays uncancelled with no skipped/success replacement under the exact required name; inspect the actual raw skipped-job name rather than assuming expansion. Toggle draft/readiness and confirm no run from those activities. Retarget unchanged head to a synthetic feature base with a known sentinel absent from the old base. Confirm a new genuine Full job supersedes obsolete validation and preparation logs the **event-pinned new base/head**, actual parents in that order, evaluated commit/tree and success. In the disposable probe only, add read-only assertions immediately after preparation that inspect `HEAD^1`, `HEAD^2`, `HEAD^{tree}` and the literal sentinel content from `HEAD`; these must fail on #51's stale checkout. Do not trust the advertised PR merge ref, mutate `main`, weaken/replace Full, or integrate fixture commits. Record the preparation and subsequent actual Full outcomes separately. This exercises GitHub's actual event/name/concurrency/checkout boundary; a YAML snapshot or local process substitute cannot prove it. Fork-workflow approvals remain human-controlled.
4. **Failure propagation.** On an authorized disposable feature/test PR, introduce a deliberate C# formatting violation (or equivalent real Full failure) without changing the workflow/check contract. Confirm Full exits nonzero, its check concludes failure and merging cannot satisfy the requirement. Repair the change and confirm a new successful run on the new revision. Never merge or push this fixture to `main`.
5. **Required-check evidence.** Inspect protection and all effective rulesets. Verify PR requirement, strict freshness, the exact Actions app-bound check, administrator inclusion and absence of standing bypasses. Preserve the observed failed/missing/stale evidence above and confirm pending/cancelled validation cannot satisfy mergeability. A skipped/neutral check is not acceptable Full evidence even if GitHub would accept that conclusion; rejected metadata jobs must use only their separate non-required name, never `Full validation`. Verify this naming behavior on GitHub rather than assuming the expression was expanded on a skipped job.
6. **Freshness.** Use two authorized disposable PRs and an already-authorized **human** base update. Observe that a previously passing PR becomes stale and cannot merge, update its branch from current `main`, and verify Full runs again and the fresh passing revision becomes eligible. Do not land code, manufacture base changes, disable protections or invoke a privileged merge as an enforcement test.
7. **Delivery.** Keep #39 open until genuine hosted success, failure/docs-only/creation evidence, effective required-check/freshness/no-bypass acceptance, two-axis review, human landing/publication and the existing delivery proof are all recorded. Successful feature-branch backup or implementation acceptance alone is not delivery.

Read-only evidence commands (replace the example PR number for a disposable PR when appropriate):

```powershell
gh api repos/geevensingh/trmnl-calendar/pulls/38 `
  --jq '{head: .head.sha, base: .base.sha, test_merge: .merge_commit_sha, mergeable, mergeable_state}'
gh pr checks 38 --repo geevensingh/trmnl-calendar
gh run list --repo geevensingh/trmnl-calendar --workflow full-validation.yml --event pull_request
# Inspect the advertised test-merge and PR head where GitHub associates checks.
# The locally prepared evaluation commit is recorded in the job log, not pushed.
gh api repos/geevensingh/trmnl-calendar/commits/<github-check-head-sha>/check-runs `
  --jq '.check_runs[] | {name, head_sha, status, conclusion, details_url, app_id: .app.id, app_slug: .app.slug}'
gh api repos/geevensingh/trmnl-calendar/branches/main/protection
gh api repos/geevensingh/trmnl-calendar/rulesets
gh api repos/geevensingh/trmnl-calendar/rules/branches/main
```

Inspect individual ruleset IDs and their bypass actors when present. PR `mergeable`/`mergeable_state` can initially be unknown; reread after GitHub recomputes. Correlate `Full validation` with `app.slug: "github-actions"`, its GitHub check-head SHA and the prepared pins/parents/tree in the successful run's logs; select that observed app in protection rather than hardcoding an unverified ID. If metadata access or an unrelated gate prevents observing rejection for the intended reason, record the limitation instead of claiming enforcement.
