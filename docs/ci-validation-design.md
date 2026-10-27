# Required CI and manual local validation

**Status: implementation prepared; owner-authorized protection configured and read back. [#39](https://github.com/geevensingh/trmnl-calendar/issues/39) issue comments are the live acceptance ledger; [PR #38](https://github.com/geevensingh/trmnl-calendar/pull/38) identifies the reviewed/current head and required genuine Full result.** Do not edit PR metadata to publish status: every admitted edit now restarts Full under the user-selected policy below. This implements the design agreed on 2026-10-25 with that subsequent policy decision. The checkpoint observations below are historical evidence, not a substitute for current-head acceptance. A checked-in workflow, settings readback or diagnostic pass alone does not prove successful Full execution or delivery. The [local validation documentation](../README.md#local-validation) describes current commands and the explicit hook migration.

## Agreed CI performance plan (2026-10-26)

**Status: agreed plan only, not implemented.** The owner confirmed the decisions below after reviewing the timing investigation. This section does not change the current workflow, required checks, branch protection, or validation entrypoint. The existing behavior documented in the following sections remains in effect until the corresponding implementation and acceptance checkpoints are complete. Saving this plan does not authorize starting CI experiments or changing protection settings.

### Observed baseline

Six successful first-attempt Full runs on October 26 averaged **41m01s** end to end:

| Stage | Average | Observed range |
| --- | --- | --- |
| Runner/job start delay | 52s | 4s-1m31s |
| Toolchain and dependency setup | 4m38s | 3m41s-6m28s |
| Formatting, build, syntax and browser readiness | 23s | 15s-30s |
| .NET production and rendering tests | 30m45s | 24m13s-34m25s |
| Node delivery and guardrail tests | 4m12s | 2m50s-5m10s |
| Remaining orchestration and cleanup | About 12s | Not separately characterized |
| Total | 41m01s | 32m11s-44m59s |

Tests account for approximately **85%** of elapsed time. The [44m59s run](https://github.com/geevensingh/trmnl-calendar/actions/runs/40393338105) spent 34m25s in .NET tests and 5m10s in Node tests; the [32m11s run](https://github.com/geevensingh/trmnl-calendar/actions/runs/40411295985) spent 24m13s and 2m50s respectively. The other sampled run IDs are `40408213302`, `40405457438`, `40383087134`, and `40375484009`.

These runs cover different revisions and test inventories, not a controlled before/after experiment. Existing logs establish stage durations but do not identify individual .NET test costs. Browser startup, Ruby startup/rendering, and PNG decoding/inspection are profiling hypotheses, not proven allocations of those minutes.

### Agreed boundaries

- Use standard GitHub-hosted runners. Larger paid runners and self-hosted infrastructure are outside this plan.
- Choose the elapsed-time target only after profiling. Increased total runner minutes may be considered, but the owner must approve the acceptable budget before adopting parallel execution.
- Preserve the complete current suite, assertions, Git-selector cases, and all six native views for every non-Markdown-only PR. Do not introduce selective code tests, a sampled rendering matrix, or reuse of earlier Full evidence.
- Classify Markdown-only eligibility using the complete evaluated PR diff against its event-pinned base, not the latest commit. A code PR followed by a README-only commit still requires Full.
- **Every Markdown-only PR avoids Full, regardless of path.** This includes `README.md`, `AGENTS.md`, agent/process Markdown, and `docs/agenda-contract.md`. The owner explicitly chose this minimal-impact policy despite the README assertions and the local workbench's executable consumption of the agenda contract; do not silently restore a narrower allowlist.
- The Markdown-only path performs pinned-revision preparation and verified change classification only: no Fast, Full, application tests, or new Markdown lint/link tooling. Renames must account for both paths; unavailable or ambiguous change evidence must not certify Markdown-only eligibility.
- Title/body-only edits should not cancel or restart otherwise valid work. Head changes and base retargets still require evaluation of the new pinned revision and its applicable policy path.
- Optimize time to useful failure feedback as well as time to green. Early failures, blocked components, missing results, and cancellations must never become successful Full evidence.
- Keep `scripts\validate.ps1` the authoritative validation implementation. Local Full must continue to represent complete coverage; CI scheduling must not create a second, drifting command list.
- Retain compact timing/test-result artifacts for seven days. Upload heavier screenshots/browser traces only on failure. Use synthetic inputs and exclude credentials, private calendar data, and raw environment dumps.
- Deliver small, independently reviewable and reversible checkpoints, measuring each optimization before adding the next. Implementation, GitHub protection changes, and human landing remain separate actions.

### Checkpoint 1: instrument the existing Full path

Add per-test/class .NET result timings and a compact summary of the existing Node timings. Separate browser creation/startup, Ruby process startup/rendering, screenshot production, and PNG decoding/pixel inspection sufficiently to distinguish their costs. Timers must not change capture readiness, production deadlines, assertion thresholds, or process-failure propagation.

Bind measurements to the head, base and evaluated commit identities, the test inventory, runner image/tool versions, and known cache state. Keep reports compact and machine-readable, with test-result artifacts for drill-down; do not replace the real rendering path with a benchmark substitute.

The initial profiling budget is **two total Full run attempts on the same instrumented revision**, counting any automatically triggered run toward those two. Failed or cancelled profiling attempts consume that allowance; review incomplete evidence rather than retrying until two successes. Schedule no additional profiling-only runs without owner approval. Two successful observations can locate hotspots; they do not establish stable percentile performance or prove an improvement. Saving this plan does not start either run.

Acceptance: the complete suite remains intact, instrumentation reconciles with overall stage time, and the reports reveal the dominant tests and subprocess phases rather than merely repeating the existing Full duration.

### Checkpoint 2: review evidence and set targets

Review the two runs before committing to an optimization design. Agree on the elapsed-time target, acceptable total runner-minute increase, additional experiment budget, and the matched-run evidence needed to accept a speedup. Account for the observed runner variability rather than using one unusually fast result.

Report elapsed time, total runner time across jobs, and failure latency separately. Distinguish cold-cache and warm-cache observations when caching becomes available. Do not promise a numeric completion time, choose a shard count, or adopt extra runner expenditure before this checkpoint.

### Checkpoint 3: dependency caches

Evaluate caches as an independent, reversible change. Candidate inputs are the NuGet package store, locked worktree-local Ruby gems, the Playwright-selected browser binaries, and pinned framework assets/fonts. Keys must include the relevant dependency/lock identity, tool/runtime version, and OS/architecture or native Ruby ABI where applicable. Respect cache trust boundaries and restore into the current worktree's owned destinations.

Do not treat `bin`, `obj`, test results, screenshots, credentials, or worktree-specific Bundler/environment configuration as reusable dependency caches. Continue the existing restore/setup and readiness checks after restoration; a cache hit is not proof of usable dependencies. Keep cache misses, invalidations, and failures visible, and do not weaken frozen restore, asset completeness, native-gem loading, or browser usability checks.

Acceptance: exercise cold misses, warm hits, relevant version/lock changes, and incomplete or unusable cached state. Record cache transfer/save overhead and total setup improvement. Preserve current-worktree ownership and shared-cache/tool-selection behavior. Roll back by removing the new cache wiring or changing its namespace, not by deleting unrelated shared state.

### Checkpoint 4: measured rendering-harness improvements

Use the profile to select changes, not a predetermined rewrite. Candidates include sharing a browser process while creating fresh test contexts, reducing repeated Ruby startup, batching equivalent work, or making PNG decoding/inspection cheaper without changing its meaning. A persistent renderer or a new helper abstraction is justified only by measured benefit and a tested lifecycle.

Preserve production Liquid/framework/fonts, strict rendering errors, native capture-readiness checks, physical dimensions, geometry, escaping, and raster assertions. DOM-only checks or fabricated images are not substitutes for the current pixel evidence. Isolate test state and output names before introducing sharing; bound subprocess work and terminate only owned processes.

Acceptance: retain the complete intended scenario/view/assertion inventory, demonstrate unchanged rendering and failure semantics, and measure the targeted phase and end-to-end benefit independently. Reject changes that buy speed through lost coverage, state leakage, orphaned processes, or increased flakiness. Keep each change separately reversible.

### Checkpoint 5: failure feedback and bounded scheduling

Surface inexpensive formatting/build/tooling failures before the long rendering tail where dependencies permit. Evaluate separate jobs or shards only after profiling and budget approval. Use separate workspaces/build outputs or equivalent verified isolation; do not concurrently mutate a shared process environment or rely on fixed artifact filenames remaining collision-free.

Keep complete coverage in the shared validator while making component boundaries explicit enough for CI to schedule them safely. The aggregate must verify that every expected component for the selected policy path actually succeeded, rather than treating an absent or skipped component as a pass. Local Full must remain available as one complete invocation.

The Node isolation matrices are a specific candidate: preserve all standard/linked owner and selector cases, while evaluating less repeated fixture/test-runner startup or bounded concurrency with independently owned fixtures. Do not remove adversarial cases merely because they are slow.

Acceptance: prove complete component coverage and isolation; exercise failed, blocked, cancelled, and missing-result paths; compare elapsed time, runner-minute totals, and failure feedback with the accepted baseline. Choose concurrency from those observations and the approved budget, not the runner's apparent CPU count alone. Rollback restores the serial shared Full path.

### Checkpoint 6: admission policy and required-check migration

Introduce **Required validation** as the required policy gate. Reserve **Full validation** for the complete suite. Markdown-only success must be explicitly identified as the reduced policy path, not a skipped or success-shaped Full substitute.

Manual Full validation and diagnostic dispatch remain genuine Full paths. An invocation without a classifiable PR diff is not evidence for the Markdown-only shortcut.

Test classification against the pinned evaluated change set, including mixed changes, multiple commits, additions/deletions/renames, and Markdown paths that are also tooling inputs. Preserve event-pinned merge preparation and freshness semantics. Metadata handling must distinguish title/body edits from changes that require reevaluation; merely adding a same-name skipped job is not acceptable.

Use a disposable PR to observe GitHub's actual required-check behavior for metadata edits during active, successful, and failed validation, as well as head changes, base retargets, Markdown-only PRs, and transitions to mixed changes. No probe is merged, and the probe itself does not change branch protection. Passing local classifier/workflow tests is not live eligibility proof.

Prepare the new check before a separately owner-approved protection migration. Keep protection in force throughout; do not remove the old requirement before the replacement is established. Read back the final required context/source and retained freshness/enforcement settings, then verify actual PR eligibility under that final contract. A pre-migration diagnostic alone cannot prove the replacement required gate works.

Provide a rollback sequence that restores both the previous genuine-Full workflow behavior and its required-check contract without an unprotected interval. Settings changes and human landing remain outside an ordinary feature-branch implementation grant.

### Evidence and deferred decisions

For each checkpoint, record the exact content identity, correctness/coverage evidence, measurement conditions, elapsed and total runner times, failure behavior, and rollback path. Compare equivalent workloads and distinguish cache/setup gains from test-execution gains. Additional benchmark samples and live probes need an agreed run budget; do not quietly exceed the initial profiling allowance.

Explicitly deferred until profiling: the numeric performance target, acceptable runner-minute increase, further sample sizes, exact harness interventions, component/shard boundaries, and concurrency. The Markdown policy and required-gate intent above are settled, but their implementation and live acceptance are not complete. An open review or passing CI is not delivery; follow the existing [delivery contract](agents/delivery.md).

## Validation and enforcement are separate

[`.github/workflows/full-validation.yml`](../.github/workflows/full-validation.yml) runs the existing `scripts\validate.ps1 -Scope Full` on every admitted `opened`, `synchronize`, `reopened` and `edited` event, plus diagnostic `workflow_dispatch`. Draft and documentation-only PR commits are included. **Every edit, including title/body edits and base retargets, executes genuine Full.** This is the user's selected policy after #53 demonstrated loss of merge eligibility following a metadata-only skipped run. Draft/readiness activities remain excluded. There are no path or target-branch exemptions, metadata admission guards, smaller suites or successful skip substitutes.

The workflow checks out the event-pinned PR **head** with complete history, then uses `scripts\prepare-ci.mjs` to construct and verify a detached evaluation commit from the event-pinned **base and head**, before selecting manifest-based .NET/Ruby tooling or running setup and Full. It does not trust GitHub's mutable `refs/pull/<number>/merge`: the #51 retarget probe proved that ref can still describe the old base after a qualifying new-base event starts. It never uses `pull_request_target`.

Workflow name **Full validation**, job ID **full** and literal job/check name **Full validation** are stable. There is one non-matrix job with one shared validation implementation and no job-level skip condition or dynamic metadata name. Configure that actual check-run context, produced by **GitHub Actions**, as required. Do not require a setup-step name, workflow-file path, concatenated display label or unrelated check with a similar name. A skipped/success substitute is not Full evidence. Changing the check identity requires a coordinated protection change.

Setup and Full execute in that same job with default failure propagation and a finite **60-minute timeout**. The former 45-minute cap cancelled run 40375647648 after the shared Full process had passed; 60 minutes provides headroom for observed setup/runner variability without reducing coverage. A failed action, setup command, missing prerequisite, blocked component or nonzero validation exits unsuccessfully. No `continue-on-error` or successful fallback permits an incomplete Full run to appear successful. Job-level concurrency uses one per-PR/ref group with `cancel-in-progress: true`: **title/body edits now cancel/supersede active Full just like head updates and base retargets**, even when content is unchanged. Expect roughly **40-45 minutes per admitted event**, not a guaranteed completion time. Use issue comments, not PR metadata edits, for acceptance/progress reporting. A dispatch run is diagnostic evidence, not a substitute for the required check on the PR revision.

CI is validation, not landing. Humans still merge; no auto-merge, merge queue, reviewer-approval quota or permission for agents to advance `main` is introduced. Full remains available manually; Fast is optional early feedback, not a replacement required check. Contributors who skip local checks learn of failures after pushing instead of blocking a feature-branch backup on their local toolchain.

### Event-pinned evaluated revision

`prepare-ci.mjs --head-commit <full-event-head-sha> --base-commit <full-event-base-sha>` is CI checkout preparation, **not another validation entrypoint**. It resolves only exact existing commit objects, requires complete history and a clean detached checkout with no hidden index entries, and uses Git **2.38+** `merge-tree --write-tree` without updating branches or protected refs. Conflicts, missing history/objects, invalid pins or failed verification terminate the required job unsuccessfully before Full; an old merge ref is never a fallback.

The local synthetic commit has the event base as its first parent and head as its second (one parent when the pins are identical), with deterministic identity/timestamps. Preparation verifies the recorded parents and merge tree, then the detached checkout's HEAD, index tree and clean state. Its JSON output records the exact `head_commit`, `base_commit`, `evaluated_commit`, `evaluated_tree` and actual `evaluated_parents`. All Git subprocesses have a 30-second bound and remove inherited `GIT_*` selectors/configuration. Normal on-disk system/global/repository configuration remains effective so status and checkout use the original checkout's line-ending normalization; disabling it can misclassify a clean Windows CRLF checkout as dirty. The bounded `checkout_state` booleans distinguish a nonempty status from hidden index flags without logging file contents, environment values or credentials. Checkout uses a command-local empty hooks directory; it neither executes nor changes installed hooks or on-disk Git configuration. It also uses `--no-overwrite-ignore`: a tracked incoming path colliding with an ignored foreign hook or other ignored file fails explicitly rather than overwriting that file. Only the disposable CI checkout and local Git objects change; no synthetic commit is pushed, and no token write permission or extra check implementation is introduced.

The real disposable-Git/public-process regression starts with a stale advertised PR merge against the old base and an absent new-base sentinel, then verifies both submitted head content and the new-base sentinel after preparation, exact parents/tree, detached HEAD, unchanged named refs and repeatability. Further cases cover conflicts, incomplete history, invalid/missing pins, dirty/attached/hidden-index checkouts, ignored configured-hook collisions, native CRLF checkout under a synthetic on-disk global configuration (including rejection and preservation of real tracked edits), and byte-for-byte preservation of a foreign owner under inherited Git selectors. These tests join Full through its existing Node discovery. Dispatch remains diagnostic: it evaluates its selected revision without pretending to be a PR merge.

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

The implementation child did not change settings. At the initial `bb991313fab3230d5fd59a3e88b3e10d9bbc48db` checkpoint, hosted Full success and evaluated-revision acceptance had not been established. [Run 40272218917](https://github.com/geevensingh/trmnl-calendar/actions/runs/40272218917) was cancelled when a PR-body edit triggered [replacement run 40273825259](https://github.com/geevensingh/trmnl-calendar/actions/runs/40273825259) at that same revision. That was an orchestration cancellation, not a test failure. The first #51 probe then observed correct event admission and metadata isolation but exposed the stale merge-ref defect described below; the corrected probe subsequently passed.

### Historical event boundary and wrong-base checkout

The metadata-skip isolation observations in this subsection describe the earlier policy, **superseded** by the user-selected every-edit Full policy after #53. They do not establish current metadata-check eligibility.

The coordinator's [closed, unmerged #51 probe report](https://github.com/geevensingh/trmnl-calendar/pull/51#issuecomment-6409133451) records actual GitHub behavior, not a YAML snapshot:

| Event | Observed outcome |
| --- | --- |
| Open/title edit | [Creation run 40275227660](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275227660) stayed active after a title-only edit. [Metadata run 40275265599](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275265599) contained only a skipped check named by the raw expression, distinct from `Full validation`. |
| Draft/readiness | Toggling these states created no runs. |
| Documentation-only commit | Head `24103fb45bb5b98c3183ef2d589cff4521f2bcb0` triggered [run 40275493244](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275493244) and correctly superseded obsolete validation. |
| Base retarget, unchanged head | Retargeting from main `80062fd2a27de65ea1424599f71d6b8be2770b30` to synthetic base `a58dedef4dd221650751bc3a1f7b0022f92d4fe1` admitted genuine Full [run 40275569916](https://github.com/geevensingh/trmnl-calendar/actions/runs/40275569916) and canceled the prior run. **Checkout was wrong:** GitHub still supplied merge `558e2d5c0b7553edfd2ae965f9978ffb8fe25f36` with old base/head parents and tree `606cae4904a9c23a2a3576ecf73a1a32fd3bd546`; the new-base sentinel was absent. The coordinator canceled after capturing checkout evidence, not because a production test failed. |

That historical checkout violated #39's requirement to bind the check to **"the revision GitHub evaluates for the PR, not an unrelated job or an earlier green revision."** Admitting the retarget event was insufficient while Full still selected the old base. The [corrected #51 acceptance report](https://github.com/geevensingh/trmnl-calendar/pull/51#issuecomment-6409705567) supersedes that failure for reviewed candidate `5f6bc0950c974002f4a409e6a5e01adf9c84a910`: actual hosted assertions verified event-pinned parents/tree/index and literal sentinel presence on the synthetic base, then sentinel absence after a same-head retarget to main. Reopened/content/base events admitted genuine Full jobs and superseded obsolete work; metadata/readiness did not interfere or create a same-name skipped Full substitute. This establishes bounded event/preparation acceptance, **not a completed Full-suite pass**: fixture runs were cancelled after assertions. Never integrate #51's disposable marker head, assertion or synthetic base commits into delivery content.

The subsequent `82c1a604bd3955872b017e4e77770d0629fb4b14` [run 40277587809](https://github.com/geevensingh/trmnl-calendar/actions/runs/40277587809) failed **during preparation, before provisioning or Full**, with `clean_visible_checkout_required`. That original log did not distinguish the two cleanliness predicates. A native disposable-Git checkout with normal on-disk `core.autocrlf=true` reproduces the same rejection: disabling normal configuration makes status nonempty despite ordinary Git reporting a clean checkout, with no hidden index flags. Preparation now retains that normalization context without accepting inherited Git selectors or relaxing either guard. The regression also rejects a real tracked CRLF edit and preserves its bytes. The subsequent hosted run below passed preparation; bounded predicate evidence remains available for future diagnostics.

### Hosted production coverage and fixture portability

At `5f6bc0950c974002f4a409e6a5e01adf9c84a910`, genuine [Full run 40278556733](https://github.com/geevensingh/trmnl-calendar/actions/runs/40278556733) finished in **37m41s**, within that checkpoint's **45-minute** job budget. Preparation, provisioning, prerequisites, formatting, build, syntax and pinned Chromium passed. The unfiltered production/rendering suite passed **644/644**, **zero skipped**, in **27m15s**. Overall Full nevertheless **failed**: Node reported **161 passed / 36 failed / 197 total**, zero skipped, in **235.205s**. This is not hosted Full success.

The complete failure log accounts for all 36 Node failures: direct completion-path identity (1), 24 nested completion-isolation cases plus their parent (25), Ruby-selection fixture alias (1), display project destinations (1), legacy-hook invocation path (1), setup command paths (1), four setup failure-stage cases plus their parent (5), and validation bundle destination (1). Native Git/PowerShell reported the long `runneradmin` directory while fixtures constructed expectations and synthetic executable aliases from the short `RUNNER~1` temporary path. The synthetic local `ruby.exe` consequently missed its PowerShell alias and was incorrectly attempted as a real executable; real Ruby setup and all 644 production cases had already passed.

The affected fixture roots now resolve the newly created directory's real filesystem identity before deriving paths, registering synthetic commands or invoking public processes. Exact path, command, configuration and isolation assertions remain unchanged; production Ruby selection/fallback, shared validation and the job timeout are untouched. A public-process regression runs the affected assertions under an owned temporary-directory alias (a Windows junction), sets temporary-directory variables only in its child process, and cleans up its disposable workspace. It reproduces the identity failure before the fix without changing user/global TEMP.

The [closed, unmerged #52 diagnostic report](https://github.com/geevensingh/trmnl-calendar/pull/52#issuecomment-6410450468) confirms native hosted portability for reviewed candidate `2192d0f7edd96b961c27ef7fa743ba30540c35a3`. [Run 40283780588](https://github.com/geevensingh/trmnl-calendar/actions/runs/40283780588) passed Fast and all **198/198 Node tests**, zero skips, with scripts/tests byte-identical to that candidate; only the disposable workflow differed. Both Node `tmpdir()` and `realpath()` of that root reported `C:\Users\RUNNER~1\AppData\Local\Temp`, so this observation does **not** establish an expanded root spelling. The check was distinctly named **Node portability diagnostic (not Full validation)**; no production .NET suite or genuine Full was invoked. Never integrate its fixture commit. Current-head genuine Full acceptance remains a separate requirement tracked in #39/PR #38, not discharged by this diagnostic.

At docs checkpoint `ade3ead20e129546a6b19565b164987836773a64`, genuine [Full run 40285474870](https://github.com/geevensingh/trmnl-calendar/actions/runs/40285474870) finished **failed**, not timed out, in **44m17s**. Preparation/setup/readiness passed and Node passed **198/198**, zero skips/failures/cancellations. Production completed **644 cases: 643 passed, one failed, zero skipped**, in **34m1s**. The sole failure was the source-preflight test fixture writing stdin after the CLI correctly rejected unauthorized access and closed its pipe (`IOException: The pipe is being closed`). Enlarging that fixture payload reproduced the exact exception locally. The two pre-input rejection tests now await the exact exit/error/redaction results with stdin still open and no bytes or EOF supplied, proving rejection does not wait for protected input while removing the invalid concurrent write. Authorized-input tests retain their existing write/close path; that fixture correction left production authorization, exception handling, assertions, coverage and the then-45-minute job budget unchanged. Current-head Full acceptance remains in the live ledger.

### Controlled #53 eligibility transition and selected policy

The [closed, unmerged #53 report](https://github.com/geevensingh/trmnl-calendar/pull/53#issuecomment-6423031570) records a pristine-workflow causal probe based on reviewed source `39138e2336103c7ea5f3d13f8af8a323a3bd2646`, with only a disposable README marker added. Genuine [Full run 40361989543](https://github.com/geevensingh/trmnl-calendar/actions/runs/40361989543) passed all seven shared components, **644/644 production cases** and **198/198 Node tests**, zero skips/failures, in **42m20s**. The exact `Full validation` check `121709589596` came from GitHub Actions app `15368`. Before any edit, the non-draft, conflict-free, fresh PR was `CLEAN` with actual no-bypass squash merge requirements **MERGEABLE, 7/7 conditions passed**.

A single title-only edit then created [metadata run 40368945435](https://github.com/geevensingh/trmnl-calendar/actions/runs/40368945435), whose only check was skipped under the raw dynamic-name expression. The original successful Full check/head/app/conclusion remained unchanged, but actual eligibility became persistently **BLOCKED / UNMERGEABLE**, with the sole failed rule stating `Required status check "Full validation" is expected.` That state persisted through the final observation **5m47s after the edit**. The `requiredStatusChecks` convenience field was already `EXPECTED` at the eligible baseline; it is **not alone proof of blocking**. The decisive evidence is the positive-to-negative actual merge-requirements transition. This bounds the observed title-edit/newer-skipped-run path, not GitHub's internal mechanism or every workflow.

After that evidence the user selected **"Run genuine Full on every admitted edit (Recommended)"**, accepting metadata-driven cancellation and the then-observed approximately 43 minutes per event rather than another experimental metadata job. The current workflow implements that decision with a literal required name, no job admission guard and one per-PR/ref concurrency group. Corrected actual-event execution and required-check/merge-eligibility acceptance on the reviewed/current head must still be established in the live ledger; #53's older-policy Full pass does not prove the correction. Neither #53's marker commit `f524f85748476e2ad2fec65f233e2a2a4939aba1` nor any earlier probe commits may be integrated. Main, protections and the delivery PR were not changed by this child.

### Measured enclosing-job timeout and finite headroom

On `b21d6a2a64958358a36bbb0acb633e0e14c74faa`, [run 40375647648](https://github.com/geevensingh/trmnl-calendar/actions/runs/40375647648) completed all **644 production .NET cases and 198 Node tests**, zero failures/skips/cancellations, with all seven components and the shared process reporting **Full validation PASSED**. The shared Full step succeeded from **18:16:49 to 18:57:28 UTC** (**40m39s**), including .NET **35m30s** and Node **274.7s**. Setup/preparation before that step took **4m25s**.

The enclosing job started **18:12:24 UTC**, completed **18:57:40 UTC** (**45m16s**), and received `exceeded maximum execution time 45m0s`; the run/job API conclusion is **cancelled**, not success and not a test failure. Earlier 37/42/44-minute runs fit the old cap, but this measured run disproved its sufficiency once setup and job overhead were included. The workflow now has a finite **60-minute job cap**; typical observed execution remains roughly 40-45 minutes, not a runtime guarantee. No executable checks, suite filters, provisioning, versions, permissions, event policy or concurrency changed with this correction. A fresh **successful enclosing job on the final reviewed/current head** is still required after integration; this process pass inside a cancelled job is not required-check acceptance.

### Observed negative enforcement gates

The coordinator recorded these observations on **2026-10-26 UTC**; they establish negative evidence, not a successful Full run or completed delivery:

| Probe | Observed evidence |
| --- | --- |
| Failed required Full | [#50's durable probe report](https://github.com/geevensingh/trmnl-calendar/pull/50#issuecomment-6408958965): normal setup passed, deliberate removal of generated `plugins.js` made the unchanged shared Full prerequisites fail, all six dependents were `BLOCKED`, and the process exited 1. [Run 40274033178](https://github.com/geevensingh/trmnl-calendar/actions/runs/40274033178) failed in 4m46s; actual `Full validation` check `121412847257`, app `15368`, concluded `failure`. The non-draft, conflict-free, up-to-date probe was `BLOCKED` with that sole failed check. The PR is closed **unmerged**. Never integrate its intentional-fault commit `ee6e59a1c63bbf76040e2a7fa4d5689de334c608`. |
| Missing required check | [#40](https://github.com/geevensingh/trmnl-calendar/pull/40) was non-draft and reported `BLOCKED` with no checks; the coordinator confirmed its branch was fresh. |
| Stale branch | [#37](https://github.com/geevensingh/trmnl-calendar/pull/37) was non-draft and reported `BEHIND`. This checkpoint observation alone does not establish fresh Full success after a branch update; consult #39/PR #38 for subsequent acceptance evidence. |

These probes neither merged into `main` nor disabled protection to test rejection. Recheck settings and evaluated identities when collecting further evidence; observations are time-bound.

For a new installation or separately authorized repair, use **Settings > Branches > Add branch protection rule** (classic protection) for the exact pattern **`main`**:

1. Enable **Require a pull request before merging**. Do not add an approval quota, code-owner review requirement, last-push approval requirement or PR-bypass actor.
2. Enable **Require status checks to pass before merging**, select **Full validation** from **GitHub Actions**, and enable **Require branches to be up to date before merging**.
3. Enable **Do not allow bypassing the above settings** so administrators are included. Leave force pushes and deletions disallowed. Do not add standing bypass allowances. Save, then independently inspect effective settings and mergeability.

The intended classic REST configuration has `required_status_checks.strict: true`, one check with `context: "Full validation"` and `app_id` equal to the **observed GitHub Actions app ID**, `enforce_admins.enabled: true`, and a non-null `required_pull_request_reviews` object with `required_approving_review_count: 0` and no PR-bypass allowances. Force pushes/deletions remain disabled. Personal repositories reject organization-only fields such as `bypass_pull_request_allowances`, even when their actor lists are empty; omit unsupported fields rather than adding an exemption. Preserve any other existing protections; do not replace live settings blindly with a partial payload. For a ruleset instead, use **Active** enforcement, target only `refs/heads/main`, require PRs, the same app-bound check and strict freshness, and leave the **entire bypass list empty**, including administrators. Check overlapping rules/rulesets as well.

Public repositories support protection on GitHub Free; private visibility or plan changes can alter availability. A forbidden/unavailable API, unsupported plan, inability to bind the source app, bypass exemption or missing separate authorization is an **enforcement blocker**, never permission to weaken the requirement. Administrators can deliberately edit policy in an emergency, but that is a separate human-controlled policy change, not a permanent bypass.

## Hosted execution and enforcement acceptance procedure

This checklist defines the acceptance procedure, not a list of currently unmet gates. Record satisfied gates and remaining requirements in **#39 issue comments**, with PR #38 identifying the exact reviewed/current head. Do not edit PR title/body to update a status ledger: that admits another Full run. A genuine successful hosted Full run on the current head is required; earlier-head successes, cancelled runs and Node-only diagnostics cannot substitute.

Record full implementation/event-head/event-base/prepared-commit/prepared-tree identities, verified parents, UTC observation time and run/check URLs for each observation. Keep GitHub's advertised test-merge/check-head SHA separately: it can differ from the prepared evaluation commit and can be stale after retargeting. Local or substituted-process tests do not prove runner readiness. A green hosted run does not prove protection.

1. **Bootstrap on the existing integration PR.** The coordinator integrates the implementation into the feature branch of [PR #38](https://github.com/geevensingh/trmnl-calendar/pull/38) through its authorized review/integration process. A PR head update with the workflow present triggers `pull_request` even before the workflow lands on `main`. Inspect the evaluated revision and verify every provisioning/setup step and actual **Full** execution completes successfully on `windows-2025`; save its component summary, unfiltered .NET/Node totals and run URL. Do not mark this gate met with substitute tools.
2. **Bootstrap constraints.** Pushing a child implementation branch without a PR does not trigger this PR-only workflow. `workflow_dispatch` is also provided for diagnostics, but GitHub requires the workflow to exist on the default branch before it can be dispatched by name with `--ref`. Do not bypass that by pushing to `main`, altering Actions settings or creating extra credentials. If Actions policy, fork approval, runner capacity, downloads or toolchain provisioning blocks execution, record that blocker and keep hosted acceptance pending.
3. **Content, metadata and base-retarget regression.** Use an authorized disposable PR, not delivery PR #38. Observe creation and a docs-only head update; ensure genuine `Full validation` evaluates each revision and newer events supersede active work. Under the user-selected policy, a title/body-only edit must admit another genuine Full job with the exact literal required name, cancel/supersede active Full, and complete the unchanged suite; no skipped metadata job or successful substitute is permitted. Observe actual merge requirements before/after the event and after genuine Full success, distinguishing temporarily pending validation from persistent missing-check eligibility as in #53. Toggle draft/readiness and confirm no run from those activities. Preserve #51's pinned-base coverage: retarget unchanged head to a synthetic feature base with a known sentinel absent from the old base, verify a genuine Full job supersedes obsolete validation and evaluates the exact event base/head, actual parents/tree/index and literal sentinel content. Do not trust the advertised PR merge ref, mutate `main`, weaken/replace Full, or integrate fixture commits. Record preparation and actual Full outcomes separately. GitHub's actual event/check/concurrency/eligibility boundary, not a YAML snapshot or fake scheduler, supplies acceptance. Fork-workflow approvals remain human-controlled.
4. **Failure propagation.** On an authorized disposable feature/test PR, introduce a deliberate C# formatting violation (or equivalent real Full failure) without changing the workflow/check contract. Confirm Full exits nonzero, its check concludes failure and merging cannot satisfy the requirement. Repair the change and confirm a new successful run on the new revision. Never merge or push this fixture to `main`.
5. **Required-check evidence.** Inspect protection and all effective rulesets. Verify PR requirement, strict freshness, the exact Actions app-bound check, administrator inclusion and absence of standing bypasses. Preserve the observed failed/missing/stale evidence above and confirm pending/cancelled validation cannot satisfy mergeability. Every admitted edit must execute the literal-name genuine Full job; a skipped/neutral check is not acceptable Full evidence. Verify actual merge requirements as well as check identities; #53 showed that a successful old check and a convenience `EXPECTED` field alone do not determine eligibility.
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
