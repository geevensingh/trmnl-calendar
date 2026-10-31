import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createExecutionPlan, reconcileExecution } from "../../scripts/validation-execution.mjs";
import { describePartitions } from "../../scripts/validation-partitions.mjs";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const ids = ["d1", "d2", "d3", "d4", "node"];
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function fixture() {
  const methods = Object.fromEntries(ids.slice(0, 4).map(id => [`Test_${id}`, id]));
  const inventory = {
    schema_version: 2, xunit: "2.9.3.0", adapter: "3.1.4.0", scenarios: [], scenario_bridges: [],
    methods: Object.keys(methods).map(method => `Synthetic.Rendering.${method}`),
    tests: Object.keys(methods).map((method, index) => ({
      test_id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      name: `${method}(data: complete)`, method: `Synthetic.Rendering.${method}`, scenario: null
    }))
  };
  const partitions = describePartitions({
    schema_version: 1, id: "full-partitions-v1", partitions: ids.slice(0, 4),
    execution_runners: 5, max_parallel_collections: 2, methods: { "Synthetic.Rendering": methods }
  }, inventory);
  const coverage = {
    profile: "OgFirst", policy_id: "og-first-v1", policy_sha256: "a".repeat(64),
    expected: inventory.methods.map(method => ({
      policy: "og-first-v1/OgFirst", method, scenario: null, view: "og/full", variant: "default"
    })),
    omitted: [{
      policy: "og-first-v1/OgFirst", method: inventory.methods[0], scenario: null,
      view: "v2/full", variant: "default"
    }]
  };
  const serial = [
    { id: "prerequisites", name: "Prerequisites", requires: [] },
    ...["format", "build", "syntax"].map(id => ({ id, name: id, requires: ["prerequisites"] })),
    { id: "browser", name: "browser", requires: ["prerequisites", "build"] },
    { id: "node", name: "node", requires: ["prerequisites", "build", "syntax", "browser"] },
    { id: "dotnet", name: "dotnet", requires: ["prerequisites", "format", "build", "syntax", "browser", "node"] },
    { id: "evidence", name: "evidence", requires: [] }
  ];
  const context = {
    run_id: "101", run_attempt: "2", head_commit: "1".repeat(40), base_commit: "2".repeat(40),
    evaluated_commit: "3".repeat(40), evaluated_tree: "4".repeat(40), content_sha256: "b".repeat(64)
  };
  const nodeFiles = ["tests\\delivery\\delivery.test.mjs", "tests\\validation\\execution.test.mjs"];
  const plan = createExecutionPlan(partitions, coverage, serial, context, nodeFiles);
  const reports = componentReports(plan, coverage, context, nodeFiles);
  return { partitions, coverage, serial, context, nodeFiles, plan, reports,
    jobs: Object.fromEntries(ids.map(id => [id, "success"])) };
}

function componentReports(plan, coverage, context, nodeFiles) {
  return plan.components.map((component, index) => {
    const workspace = `D:\\checkouts\\${component.id}`;
    const artifact = `${workspace}\\artifacts\\validation\\component-owned`;
    const evidence = {
      status: "complete", inventory_sha256: "c".repeat(64),
      content_sha256: context.content_sha256,
      component_contract_sha256: component.component_contract_sha256,
      dotnet: null, node: null, phases: null
    };
    if (component.id === "node") {
      evidence.node = {
        summary: {
          tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0, files: nodeFiles
        },
        tests: nodeFiles.map(file => ({
          file, nesting: 0, name: "Complete Node case", type: "test", result: "passed", duration_ms: 10
        }))
      };
    } else {
      evidence.dotnet = {
        count: component.expected_tests.length,
        tests: component.expected_tests.map(({ test_id, name, method }) => ({
          test_id, name, method, result: "Passed", duration_ms: 1_000
        }))
      };
      evidence.phases = {
        inventory: { coverage: structuredClone(coverage) },
        display_coverage: structuredClone(component.expected_coverage)
      };
    }
    return {
      schema_version: 1, scope: "Component", outcome: "passed",
      started_at: `2026-10-30T12:00:0${index}.000Z`,
      finished_at: `2026-10-30T12:01:0${index}.000Z`, duration_ms: 60_000,
      execution: {
        component: component.id, plan_sha256: plan.sha256,
        isolation: {
          host_id: "same-host", workspace_root: workspace,
          artifact_root: artifact, process_root: `${artifact}\\process`,
          build_roots: ["src\\CalendarAgenda", "tests\\CalendarAgenda.Tests"]
            .flatMap(project => ["bin", "obj"].map(kind => `${workspace}\\${project}\\${kind}`))
        }
      },
      provenance: { ...structuredClone(context), working_tree_clean: true },
      content: { started: { sha256: context.content_sha256 }, finished: { sha256: context.content_sha256 }, unchanged: true },
      component_contract_sha256: component.component_contract_sha256,
      components: component.components.map(item => ({
        ...structuredClone(item), outcome: "success", evidence_outcome: null, blocked_by: []
      })),
      evidence
    };
  });
}

test("execution planning retains the real Node browser/build edges and explicitly removes only serial feedback", () => {
  const { plan } = fixture();
  assert.equal(plan.execution_runners, 5);
  assert.equal(plan.max_parallel_collections, 2);
  assert.deepEqual(plan.removed_serial_policy_edges, [{ prerequisite: "node", component: "dotnet" }]);
  for (const component of plan.components) {
    assert.ok(component.components.find(item => item.id === "browser"));
    if (component.id === "node") {
      assert.equal(component.filter, null);
      assert.deepEqual(component.expected_tests, []);
      assert.ok(component.components.find(item => item.id === "node").requires.includes("browser"));
    } else {
      assert.ok(!component.components.some(item => item.id === "node"));
      assert.deepEqual(component.components.find(item => item.id === "dotnet").requires,
        ["prerequisites", "format", "build", "syntax", "browser"]);
      assert.ok(component.filter.startsWith("FullyQualifiedName="));
    }
  }
});

test("execution planning rejects a stale Node contract, invalid bindings and coverage overlap", () => {
  for (const mutate of [
    state => { state.serial[5].requires = ["prerequisites", "build", "syntax"]; },
    state => { state.serial[5].requires = ["prerequisites", "syntax", "browser"]; },
    state => { state.serial[6].requires = ["prerequisites", "browser"]; },
    state => { state.serial[1].requires = ["dotnet"]; },
    state => { state.context.run_attempt = "0"; },
    state => { state.context.run_id = "local-not-a-bound-identity"; },
    state => { state.context.run_id = `local-${"a".repeat(32)}`; state.context.run_attempt = "2"; },
    state => { state.context.evaluated_tree = "not-a-tree"; },
    state => { state.context.content_sha256 = null; },
    state => { state.nodeFiles = []; },
    state => { state.nodeFiles.push(state.nodeFiles[0]); },
    state => { state.partitions.partitions[0].filter = "FullyQualifiedName~Synthetic"; },
    state => { state.partitions.partitions[0].expected_tests = []; },
    state => { state.partitions.partitions[1].expected_tests[0].test_id = state.partitions.partitions[0].expected_tests[0].test_id;
      state.partitions.partitions[1].expected_tests[0].name = state.partitions.partitions[0].expected_tests[0].name; },
    state => { state.coverage.omitted.push(state.coverage.expected[0]); },
    state => { state.coverage.omitted.push(state.coverage.omitted[0]); }
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => createExecutionPlan(state.partitions, state.coverage, state.serial,
      state.context, state.nodeFiles));
  }
});

test("local execution identity is distinct from a GitHub run and remains bound across components", () => {
  const state = fixture();
  state.context.run_id = `local-${"a".repeat(32)}`;
  state.context.run_attempt = "1";
  const plan = createExecutionPlan(state.partitions, state.coverage, state.serial, state.context, state.nodeFiles);
  const reports = componentReports(plan, state.coverage, state.context, state.nodeFiles);
  assert.equal(reconcileExecution(plan, reports, state.jobs).component_set_complete, true);
  reports[0].provenance.run_id = `local-${"b".repeat(32)}`;
  assert.throws(() => reconcileExecution(plan, reports, state.jobs), /component_revision_attempt_or_content_mismatch/);
});

test("complete aggregation conserves cases/assertions without claiming job runner minutes or Full success", () => {
  const { plan, reports, jobs } = fixture();
  const result = reconcileExecution(plan, reports, jobs);
  assert.equal(result.component_set_complete, true);
  assert.equal(result.dotnet_tests, 4);
  assert.equal(result.node_tests, 2);
  assert.equal(result.completed_display_assertions, 4);
  assert.equal(result.component_validation_utc_span_ms, 64_000);
  assert.equal(result.summed_component_validation_ms, 300_000);
  assert.equal(result.total_job_runner_minutes, null);
  assert.equal(result.outcome, undefined);
  assert.match(result.timing_semantics, /provisioning.*clock skew.*hosted job timeline/);
});

test("aggregation rejects missing, duplicate, foreign, stale, failed and cancelled components", () => {
  for (const mutate of [
    state => { state.reports.pop(); },
    state => { state.reports[4] = state.reports[0]; },
    state => { state.reports[0].execution.component = "d5"; },
    state => { state.reports[0].execution.plan_sha256 = "d".repeat(64); },
    state => { state.reports[0].outcome = "failed"; },
    state => { state.reports[0].scope = "Full"; },
    state => { state.reports[0].provenance.run_id = "100"; },
    state => { state.reports[0].provenance.run_attempt = "1"; },
    state => { state.reports[0].provenance.evaluated_tree = "5".repeat(40); },
    state => { state.reports[0].provenance.working_tree_clean = false; },
    state => { state.reports[0].content.finished.sha256 = "d".repeat(64); },
    state => { state.reports[0].content.unchanged = false; },
    state => { state.reports[0].component_contract_sha256 = "d".repeat(64); },
    state => { state.reports[0].components.pop(); },
    state => { state.reports[0].components[0].outcome = "blocked"; },
    state => { state.reports[0].components[0].blocked_by = ["foreign"]; },
    state => { state.reports[0].components[0].evidence_outcome = "cancelled"; },
    state => { state.reports[0].evidence.status = "incomplete"; },
    state => { state.reports[0].evidence.component_contract_sha256 = "d".repeat(64); },
    state => { state.jobs.d1 = "failure"; },
    state => { state.jobs.d4 = "cancelled"; },
    state => { state.jobs.node = "skipped"; },
    state => { delete state.jobs.node; },
    state => { state.jobs.foreign = "success"; },
    state => { state.plan.max_parallel_collections = 3; }
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs));
  }
});

test("aggregation rejects incomplete raw theories, wrong policy/variants and fabricated passing summaries", () => {
  for (const mutate of [
    state => { state.reports[0].evidence.dotnet.tests = []; },
    state => { state.reports[0].evidence.dotnet.tests[0].name += "foreign"; },
    state => { state.reports[0].evidence.dotnet.tests[0].result = "Skipped"; },
    state => { state.reports[0].evidence.dotnet.tests[0].duration_ms = -1; },
    state => { state.reports[0].evidence.phases.display_coverage = []; },
    state => { state.reports[0].evidence.phases.display_coverage[0].variant = "foreign"; },
    state => { state.reports[0].evidence.phases.display_coverage[0].result = "passed"; },
    state => { state.reports[0].evidence.phases.inventory.coverage.profile = "Exhaustive"; },
    state => { state.reports[0].evidence.phases.inventory.coverage.policy_sha256 = "d".repeat(64); },
    state => { state.reports[4].evidence.node.summary.tests = 3; },
    state => { state.reports[4].evidence.node.tests.pop(); },
    state => { state.reports[4].evidence.node.tests[0].file = "tests\\foreign.test.mjs"; },
    state => { state.reports[4].evidence.node.tests[0].result = "failed"; },
    state => { state.reports[4].evidence.node.summary.cancelled = 1; },
    state => { state.reports[4].evidence.dotnet = state.reports[0].evidence.dotnet; },
    state => { state.reports[0].evidence.node = state.reports[4].evidence.node; }
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs));
  }
});

test("workers on the same host cannot overlap workspaces, build outputs or owned process roots", () => {
  for (const mutate of [
    state => { state.reports[1].execution.isolation = structuredClone(state.reports[0].execution.isolation); },
    state => { state.reports[1].execution.isolation.workspace_root = "D:\\checkouts"; },
    state => { state.reports[1].execution.isolation.artifact_root = "D:\\foreign"; },
    state => { state.reports[1].execution.isolation.process_root = "D:\\foreign"; },
    state => { state.reports[1].execution.isolation.build_roots[0] = state.reports[0].execution.isolation.build_roots[0]; },
    state => { state.reports[1].execution.isolation.workspace_root = "D:\\checkouts:foreign"; },
    state => { state.reports[1].execution.isolation.workspace_root = "D:\\"; },
    state => { state.reports[1].execution.isolation.host_id = ""; }
  ]) {
    const state = fixture();
    mutate(state);
    assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs));
  }
  const { plan, reports, jobs } = fixture();
  reports[1].execution.isolation = { ...structuredClone(reports[0].execution.isolation), host_id: "different-host" };
  assert.equal(reconcileExecution(plan, reports, jobs).component_set_complete, true);
});

test("the public validator rejects incomplete modes and unused component inputs before any work", () => {
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$cases = @(
    @{ Scope = 'Full'; Execution = 'Plan' }
    @{ Scope = 'Fast'; Execution = 'Worker'; Component = 'd1'; ExecutionPlan = 'not-read.json' }
    @{ Scope = 'Full'; Execution = 'Worker'; Component = 'd1' }
    @{ Scope = 'Full'; Execution = 'Worker'; Component = 'd1'; ExecutionPlan = 'not-read.json'; ReportsDirectory = '' }
    @{ Scope = 'Full'; Execution = 'Aggregate'; ExecutionPlan = 'not-read.json'; JobResults = '{}' }
    @{ Scope = 'Full'; Execution = 'Aggregate'; Component = 'd1'; ExecutionPlan = 'not-read.json'; ReportsDirectory = 'not-read'; JobResults = '{}' }
    @{ Scope = 'Fast'; Execution = 'Serial'; Component = 'node' }
    @{ Scope = 'Fast'; Execution = 'Serial'; ExecutionPlan = '' }
    @{ Scope = 'Fast'; Execution = 'Plan'; JobResults = '' }
)
foreach ($case in $cases) {
    $rejected = $false
    try { & $env:VALIDATION_SCRIPT @case }
    catch {
        if ($_.Exception.Message -notlike 'Invalid execution mode:*') { throw }
        $rejected = $true
    }
    if (!$rejected) { throw 'Invalid public mode unexpectedly executed.' }
}
'All nine invalid public modes were rejected before report creation.'
`], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, VALIDATION_SCRIPT: join(root, "scripts", "validate.ps1") }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All nine invalid public modes/);
  assert.ok(!result.stdout.includes("Timing report:"));
});

test("the public raw reader verifies transferred bytes and assigned subsets before component aggregation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda raw component evidence "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = fixture();
  const policy = "{}";
  state.coverage.policy_sha256 = createHash("sha256").update(policy).digest("hex");
  state.plan = createExecutionPlan(state.partitions, state.coverage, state.serial, state.context, state.nodeFiles);
  const workspace = join(directory, "workspace");
  await mkdir(join(workspace, "tests"), { recursive: true });
  await writeFile(join(workspace, "tests", "display-coverage.json"), policy);
  const run = await rawComponentReader(directory, state);
  const prepared = run("prepare");
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const complete = run("read");
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  const decoded = JSON.parse(await readFile(join(directory, "decoded.json"), "utf8"));
  assert.equal(reconcileExecution(state.plan, decoded, state.jobs).component_set_complete, true);
  assert.equal(decoded[0].evidence.phases.display_coverage.length, 1,
    "A .NET shard validates its assigned subset, not the global four-assertion set");

  const trxPath = join(directory, "d1", "dotnet.trx");
  const original = await readFile(trxPath, "utf8");
  await writeFile(trxPath, original.replace('outcome="Passed"', 'outcome="Skipped"'));
  const damaged = run("read");
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /transfer manifest/);
  assert.equal(run("rehash-d1").status, 0);
  const skipped = run("read");
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /raw component evidence/);
  await writeFile(trxPath, original);
  await writeFile(join(directory, "d1", "coverage-1.jsonl"), "");
  assert.equal(run("rehash-d1").status, 0);
  const missing = run("read");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /raw component evidence/);
});

test("the public aggregate binds source and freshly decoded raw artifacts instead of trusting summaries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda aggregate protocol "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await cp(join(root, "scripts"), join(workspace, "scripts"), { recursive: true });
  for (const name of ["delivery", "validation"]) {
    await mkdir(join(workspace, "tests", name), { recursive: true });
    await writeFile(join(workspace, "tests", name, `${name === "delivery" ? "delivery" : "execution"}.test.mjs`),
      "// Synthetic controller-protocol fixture; never a production test execution.\n");
  }
  const type = "CalendarAgenda.Tests.AdaptiveDisplayTests";
  const scenarioMethod = "Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views";
  const manifest = {
    schema_version: 1, id: "full-partitions-v1", partitions: ids.slice(0, 4),
    execution_runners: 5, max_parallel_collections: 2,
    methods: { [type]: { ...Object.fromEntries(ids.slice(0, 4).map(id => [`Test_${id}`, id])),
      [scenarioMethod]: "d4" } }
  };
  await writeFile(join(workspace, "tests", "validation-partitions.json"), JSON.stringify(manifest));
  await writeFile(join(workspace, "tests", "display-coverage.json"), JSON.stringify({
    version: 1, id: "og-first-v1", scenarios: ["reference"], secondary_scenarios: ["reference"],
    adaptive_families: Object.fromEntries(ids.slice(0, 4).map(id => [`Test_${id}`, "og-full"])),
    title_variants: ["short/timed"], secondary_title_variants: ["short/timed"]
  }));
  await writeFile(join(workspace, ".gitignore"), "artifacts/\n");
  const environment = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty.gitconfig"),
    GITHUB_RUN_ID: "", GITHUB_RUN_ATTEMPT: "", PR_HEAD_COMMIT: "", PR_BASE_COMMIT: "",
    GITHUB_OUTPUT: ""
  });
  for (const args of [
    ["init", "--quiet", "--template="], ["add", "."],
    ["-c", "user.name=Controller fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "-m", "Synthetic controller protocol"]
  ]) {
    const result = spawnSync("git", args, { cwd: workspace, env: environment, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const metadata = join(directory, "metadata.json");
  const initialized = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $env:FIXTURE_ROOT
. (Join-Path $root 'scripts\\validation-scheduling.ps1')
. (Join-Path $root 'scripts\\validation-report.ps1')
$components = @(Get-ValidationComponents 'Full')
New-ValidationReport $root 'Full' $components
$context = [ordered]@{}
foreach ($key in @('run_id', 'run_attempt', 'head_commit', 'base_commit', 'evaluated_commit', 'evaluated_tree')) {
    $context[$key] = $script:validationReport.provenance[$key]
}
$context.run_id = 'local-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$context.run_attempt = '1'
$context.content_sha256 = $script:validationReport.content.started.sha256
[ordered]@{ coverage = Get-DisplayCoverageInventory $root 'OgFirst'; context = $context
    serial = @($components | ForEach-Object { [ordered]@{ id = $_.id; name = $_.name; requires = $_.requires } })
} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $env:FIXTURE_METADATA -Encoding utf8
`], {
    cwd: workspace, encoding: "utf8", timeout: 20_000,
    env: { ...environment, FIXTURE_ROOT: workspace, FIXTURE_METADATA: metadata }
  });
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  const bindings = JSON.parse(await readFile(metadata, "utf8"));
  const inventory = {
    schema_version: 2, xunit: "2.9.3.0", adapter: "3.1.4.0", scenarios: ["reference"], scenario_bridges: [],
    methods: Object.keys(manifest.methods[type]).map(method => `${type}.${method}`)
  };
  inventory.tests = inventory.methods.map((method, index) => ({
    test_id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    name: `${method}(data: complete)`, method,
    scenario: method.endsWith(scenarioMethod) ? "reference" : null
  }));
  const state = {
    ...bindings, partitions: describePartitions(manifest, inventory),
    scenarios: ["reference"], nodeFiles: fixture().nodeFiles, jobs: fixture().jobs
  };
  state.plan = createExecutionPlan(state.partitions, state.coverage, state.serial, state.context, state.nodeFiles);
  state.reports = componentReports(state.plan, state.coverage, state.context, state.nodeFiles);
  const raw = await rawComponentReader(directory, state);
  const prepared = raw("prepare");
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const planDirectory = join(directory, "plan");
  await mkdir(planDirectory);
  const planPath = join(planDirectory, "execution-plan.json");
  await writeFile(planPath, JSON.stringify(state.plan));
  await writeFile(join(planDirectory, "execution-request.json"), JSON.stringify({
    inventory, coverage: state.coverage, serial: state.serial, context: state.context, node_files: state.nodeFiles
  }));
  const incoming = join(directory, "incoming");
  for (const id of ids) {
    await mkdir(join(incoming, id), { recursive: true });
    await rename(join(directory, id), join(incoming, id, "component-fixture"));
  }
  const invoke = (args, env = environment) => spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(workspace, "scripts", "validate.ps1"),
    ...args
  ], { cwd: workspace, env, encoding: "utf8", timeout: 30_000 });
  const run = (jobs = state.jobs) => invoke([
    "-Scope", "Full", "-Execution", "Aggregate", "-ExecutionPlan", planPath,
    "-ReportsDirectory", incoming, "-JobResults", JSON.stringify(jobs)
  ]);
  const complete = run();
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  const reportDirectory = complete.stdout.match(/Timing report: (.+)/)[1].trim();
  const report = JSON.parse(await readFile(join(reportDirectory, "summary.json"), "utf8"));
  assert.equal(report.outcome, "passed");
  assert.equal(report.evidence.dotnet.count, 5);
  assert.equal(report.evidence.phases.display_coverage.length, 10);
  assert.equal(report.execution.components.length, 5);
  assert.equal(report.execution.controller_isolation.tool_environment_policy, "native-inputs-v1");
  assert.equal(await readdir(reportDirectory).then(entries => entries.some(name => name.startsWith("process-"))), false);
  assert.equal(report.provenance.run_source, "local");
  assert.equal(report.provenance.run_id, state.context.run_id);
  assert.deepEqual(report.stages, []);
  assert.equal(report.execution.reconciliation.total_job_runner_minutes, null);
  assert.match(report.timing_semantics, /aggregation duration excludes worker/);
  const validationRoot = join(workspace, "artifacts", "validation");
  const existingReports = await readdir(validationRoot);
  for (const [args, name] of [
    [["-Scope", "Fast", "-Execution", "Plan"], "MSBuildProjectExtensionsPath"],
    [["-Scope", "Full", "-Execution", "Worker", "-Component", "d1", "-ExecutionPlan", planPath], "BaseOutputPath"],
    [["-Scope", "Fast", "-Execution", "Plan"], "GeneratedGlobalUsingsFile"],
    [["-Scope", "Full", "-Execution", "Worker", "-Component", "d1", "-ExecutionPlan", planPath], "GeneratedGlobalUsingsFile"]
  ]) {
    const sentinel = join(directory, "shared-output");
    await writeFile(sentinel, "foreign-sentinel");
    const overridden = invoke(args, { ...environment, [name]: sentinel });
    assert.equal(overridden.status, 1, overridden.stdout + overridden.stderr);
    assert.match(overridden.stderr, /inherited MSBuild output overrides/);
    assert.doesNotMatch(overridden.stdout, /Timing report:|== Prerequisites ==/);
    assert.deepEqual(await readdir(validationRoot), existingReports);
    assert.equal(await readFile(sentinel, "utf8"), "foreign-sentinel");
  }
  const foreignBuild = join(directory, "foreign-build");
  await mkdir(foreignBuild);
  await writeFile(join(foreignBuild, "sentinel"), "unchanged");
  for (const kind of ["bin", "obj"]) {
    const outputRoot = join(workspace, "tests", "CalendarAgenda.Tests", kind);
    await mkdir(outputRoot, { recursive: true });
    const link = join(outputRoot, "Debug");
    await symlink(foreignBuild, link, "junction");
    try {
      for (const args of [
        ["-Scope", "Fast", "-Execution", "Plan"],
        ["-Scope", "Full", "-Execution", "Worker", "-Component", "d1", "-ExecutionPlan", planPath]
      ]) {
        const linked = invoke(args);
        assert.equal(linked.status, 1, linked.stdout + linked.stderr);
        assert.match(linked.stderr, /linked directory descendants/);
        assert.doesNotMatch(linked.stdout, /Timing report:|== Prerequisites ==/);
        assert.deepEqual(await readdir(validationRoot), existingReports);
        assert.deepEqual(await readdir(foreignBuild), ["sentinel"]);
        assert.equal(await readFile(join(foreignBuild, "sentinel"), "utf8"), "unchanged");
      }
    } finally { await unlink(link); }
  }
  const ownedReports = join(directory, "owned-reports");
  const foreignReports = join(directory, "foreign-reports");
  await mkdir(foreignReports);
  await writeFile(join(foreignReports, "sentinel"), "unchanged");
  await rename(validationRoot, ownedReports);
  await symlink(foreignReports, validationRoot, "junction");
  try {
    for (const args of [
      ["-Scope", "Fast", "-Execution", "Plan"],
      ["-Scope", "Full", "-Execution", "Worker", "-Component", "d1", "-ExecutionPlan", planPath],
      ["-Scope", "Full", "-Execution", "Aggregate", "-ExecutionPlan", planPath,
        "-ReportsDirectory", incoming, "-JobResults", JSON.stringify(state.jobs)]
    ]) {
      const linked = invoke(args);
      assert.equal(linked.status, 1, linked.stdout + linked.stderr);
      assert.match(linked.stderr, /linked directory/);
      assert.doesNotMatch(linked.stdout, /Timing report:|== Prerequisites ==/);
      assert.deepEqual(await readdir(foreignReports), ["sentinel"]);
      assert.equal(await readFile(join(foreignReports, "sentinel"), "utf8"), "unchanged");
    }
  } finally {
    await unlink(validationRoot);
    await rename(ownedReports, validationRoot);
  }
  await writeFile(planPath, JSON.stringify({
    ...state.plan, context: { ...state.plan.context, run_id: `local-${"b".repeat(32)}` }
  }));
  const staleContext = run();
  assert.equal(staleContext.status, 1, staleContext.stdout + staleContext.stderr);
  assert.match(staleContext.stdout, /execution plan cannot be reconstructed/);
  await writeFile(planPath, JSON.stringify(state.plan));
  const cancelled = run({ ...state.jobs, d1: "cancelled" });
  assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
  assert.match(cancelled.stdout + cancelled.stderr, /all_execution_jobs_must_succeed/);
  await mkdir(join(incoming, "foreign"));
  const foreign = run();
  assert.equal(foreign.status, 1);
  assert.match(foreign.stdout, /component set contains missing, duplicate or foreign/);
  await rm(join(incoming, "foreign"), { recursive: true });
  await cp(join(incoming, "d1", "component-fixture"), join(incoming, "d1", "component-duplicate"), { recursive: true });
  const duplicate = run();
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /exactly one report directory/);
  await rm(join(incoming, "d1", "component-duplicate"), { recursive: true });
  await writeFile(join(workspace, "tests", "delivery", "delivery.test.mjs"), "// Changed after planning\n");
  const changed = run();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /content or coverage policy does not match/);
});

async function rawComponentReader(directory, state) {
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  const nativeViews = ["og/full", "og/half_horizontal", "og/half_vertical",
    "v2/full", "v2/half_horizontal", "v2/half_vertical"];
  for (const [index, component] of state.plan.components.entries()) {
    const report = state.reports[index];
    report.execution.plan_sha256 = state.plan.sha256;
    if (component.id === "node") report.node_files = state.nodeFiles;
    const output = join(directory, component.id);
    await mkdir(output);
    await writeFile(join(output, "summary.json"), JSON.stringify(report));
    if (component.id === "node") {
      await writeFile(join(output, "node.jsonl"), [
        ...report.evidence.node.tests.map(item => JSON.stringify({ kind: "test", ...item })),
        JSON.stringify({ kind: "summary", ...report.evidence.node.summary })
      ].join("\n") + "\n");
    } else {
      const definitions = component.expected_tests.map(item => `<UnitTest id="${item.test_id}">` +
        `<TestMethod className="${item.method.slice(0, item.method.lastIndexOf("."))}" ` +
        `name="${item.method.slice(item.method.lastIndexOf(".") + 1)}"/></UnitTest>`).join("");
      const results = component.expected_tests.map(item => `<UnitTestResult testId="${item.test_id}" ` +
        `testName="${item.name}" outcome="Passed" duration="00:00:01"/>`).join("");
      await writeFile(join(output, "dotnet.trx"), `<TestRun><TestDefinitions>${definitions}</TestDefinitions>` +
        `<Results>${results}</Results><ResultSummary outcome="Completed"><Counters total="${component.expected_tests.length}" ` +
        `executed="${component.expected_tests.length}"/></ResultSummary></TestRun>`);
      await writeFile(join(output, "inventory-1.json"), JSON.stringify({
        scenarios: state.scenarios ?? ["fixture"], views: nativeViews, coverage: state.coverage
      }));
      await writeFile(join(output, "coverage-1.jsonl"), component.expected_coverage.map(JSON.stringify).join("\n") + "\n");
      const phases = ["browser.create", "browser.launch", "ruby.startup", "ruby.render",
        "screenshot", "png.decode", "png.inspect"].map(phase => ({ phase, scenario: "fixture" }))
        .concat(nativeViews.map(view => ({ phase: "render.view", scenario: `fixture/${view}` })),
          (state.scenarios ?? ["fixture"]).map(scenario => ({ phase: "scenario.load", scenario })));
      await writeFile(join(output, "phases-1.jsonl"), phases.flatMap((item, index) => {
        const common = { id: String(index), ...item };
        return [JSON.stringify({ ...common, kind: "start" }),
          JSON.stringify({ ...common, kind: "end", result: "passed", duration_ms: 1 })];
      }).join("\n") + "\n");
    }
  }
  const probe = join(directory, "raw-reader.ps1");
  await writeFile(probe, `
param([string]$SourceRoot, [string]$Directory, [string]$Mode)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $SourceRoot 'scripts\\validation-scheduling.ps1')
. (Join-Path $SourceRoot 'scripts\\validation-report.ps1')
$state = Get-Content -Raw -LiteralPath (Join-Path $Directory 'state.json') | ConvertFrom-Json
$script:coveragePlan = Get-Content -Raw -LiteralPath (Join-Path $Directory 'state.json') | ConvertFrom-Json -AsHashtable |
    ForEach-Object { $_.coverage }
$script:validationRoot = Join-Path $Directory 'workspace'
if ($Mode -eq 'prepare') {
    foreach ($component in $state.plan.components) {
        $script:validationDirectory = Join-Path $Directory $component.id
        $summary = Join-Path $script:validationDirectory 'summary.json'
        $script:validationReport = Get-Content -Raw -LiteralPath $summary | ConvertFrom-Json -AsHashtable
        $script:validationReport.unavailable = [Collections.Generic.List[string]]::new()
        $script:workerExpected = $component
        $script:coverageSubset = @($component.expected_coverage)
        $ready = if ($component.id -eq 'node') { Read-ValidationEvidence -NodeOnly -Component }
            else { Read-ValidationEvidence -DotnetOnly }
        if (!$ready) { throw "Synthetic component raw evidence could not initialize: $($component.id)" }
        $script:validationReport | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summary -Encoding utf8
        Write-ValidationRawManifest $script:validationDirectory
    }
} elseif ($Mode -eq 'rehash-d1') {
    Write-ValidationRawManifest (Join-Path $Directory 'd1')
} else {
    $coverage = $script:coveragePlan
    $reports = @(foreach ($component in $state.plan.components) {
        Read-ValidationComponentArtifact $script:validationRoot (Join-Path $Directory $component.id) $component $coverage
    })
    $reports | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $Directory 'decoded.json') -Encoding utf8
}
`);
  const run = mode => spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", probe,
    "-SourceRoot", root, "-Directory", directory, "-Mode", mode
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  return run;
}

test("the public worker lifecycle scopes scratch/environment and terminates an owned timed-out process tree", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda worker lifecycle "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const report = join(workspace, "artifacts", "validation", "component-test");
  await mkdir(report, { recursive: true });
  const shims = join(directory, "shims");
  await mkdir(shims);
  await writeFile(join(shims, "readiness.cmd"), "@echo off\r\necho owned-shim-ok\r\nexit /b 0\r\n");
  await writeFile(join(shims, "readiness"), "not the selected Windows launcher\n");
  const child = join(directory, "child.ps1");
  await writeFile(child, `
param([string]$PidFile, [switch]$ExitEarly)
$child = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -PassThru
[IO.File]::WriteAllText($PidFile, "$($child.Id)")
if ($ExitEarly) { exit 0 }
Start-Sleep -Seconds 30
`);
  const probe = join(directory, "probe.ps1");
  await writeFile(probe, `
param([string]$Module, [string]$Root, [string]$Report, [string]$Child)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $Module
$trace = Join-Path (Split-Path $Root -Parent) 'caller-trace.nettrace'
[IO.File]::WriteAllText($trace, 'preserve-foreign-trace')
$env:DOTNET_EnableEventPipe = '1'
$env:DOTNET_EventPipeOutputPath = $trace
$names = @('TEMP', 'TMP', 'TMPDIR', 'TRMNL_TIMING_DIRECTORY', 'TRMNL_DISCOVERY_PATH', 'BUNDLE_PATH',
    'GeneratedMSBuildEditorConfigFile',
    'DOTNET_EnableEventPipe', 'DOTNET_EventPipeOutputPath',
    'DOTNET_CLI_HOME', 'DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER', 'MSBUILDDISABLENODEREUSE', 'UseSharedCompilation',
    'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO',
    'BUNDLE_USER_HOME', 'BUNDLE_USER_CACHE', 'PATH', 'AZURE_CONFIG_DIR',
    'NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH', 'NUGET_SCRATCH',
    'AZURE_BICEP_USE_BINARY_FROM_PATH', 'AZURE_EXTENSION_USE_DYNAMIC_INSTALL')
$before = @{}
foreach ($name in $names) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$state = Enter-ValidationWorkerEnvironment $Root $Report
$pidFile = Join-Path $state.isolation.process_root 'child.pid'
$pwsh = (Get-Command pwsh).Source
$exitPreserved = $false
$timeoutPreserved = $false
$childGone = $false
$orphanGone = $false
$argumentsPreserved = $false
$shimPreserved = $false
try {
    if ($env:TEMP -cne $state.isolation.process_root -or $env:TMP -cne $env:TEMP -or
        $env:TMPDIR -cne $env:TEMP -or $env:TRMNL_TIMING_DIRECTORY -cne $Report -or
        (Test-Path Env:TRMNL_DISCOVERY_PATH) -or
        $env:DOTNET_CLI_HOME -cne (Join-Path $state.isolation.process_root 'dotnet-home') -or
        $env:DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER -cne '1' -or
        $env:MSBUILDDISABLENODEREUSE -cne '1' -or $env:UseSharedCompilation -cne 'false' -or
        $env:DOTNET_CLI_TELEMETRY_OPTOUT -cne '1' -or $env:DOTNET_NOLOGO -cne '1' -or
        $env:NUGET_HTTP_CACHE_PATH -cne (Join-Path $state.isolation.process_root 'nuget-http') -or
        $env:NUGET_PLUGINS_CACHE_PATH -cne (Join-Path $state.isolation.process_root 'nuget-plugins') -or
        $env:NUGET_SCRATCH -cne (Join-Path $state.isolation.process_root 'nuget-scratch') -or
        $env:BUNDLE_USER_HOME -cne (Join-Path $state.isolation.process_root 'bundler') -or
        $env:BUNDLE_USER_CACHE -cne (Join-Path $env:BUNDLE_USER_HOME 'cache') -or
        $env:AZURE_CONFIG_DIR -cne (Join-Path $state.isolation.process_root 'azure') -or
        $env:AZURE_BICEP_USE_BINARY_FROM_PATH -cne 'true' -or
        $env:AZURE_EXTENSION_USE_DYNAMIC_INSTALL -cne 'no') {
        throw 'Worker environment was not scoped.'
    }
    $env:PATH = "$(Join-Path (Split-Path $Child -Parent) 'shims');$env:PATH"
    $shim = @(Invoke-ValidationOwnedTool readiness @('--version') $Root 20)
    $shimPreserved = $shim -contains 'owned-shim-ok'
    if ($state.isolation.tool_environment_policy -cne 'native-inputs-v1' -or
        'GeneratedMSBuildEditorConfigFile' -notin $state.isolation.omitted_inherited_variables -or
        'DOTNET_EnableEventPipe' -notin $state.isolation.omitted_inherited_variables -or
        'DOTNET_EventPipeOutputPath' -notin $state.isolation.omitted_inherited_variables) {
        throw 'Arbitrary inherited MSBuild properties were not identified.'
    }
    Invoke-ValidationOwnedTool (Get-Command node).Source @('-e',
        'if (["GeneratedMSBuildEditorConfigFile", "DOTNET_EnableEventPipe", "DOTNET_EventPipeOutputPath"].some(name => name in process.env) || !process.env.PATH || !process.env.TRMNL_TIMING_DIRECTORY?.length) process.exit(9);') $Root 20
    Invoke-ValidationOwnedTool $pwsh @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::WriteLine("owned stdout"); [Console]::Error.WriteLine("owned stderr")') $Root 20
    $argumentFile = Join-Path $state.isolation.process_root 'arguments.json'
    $values = @('', 'space words', 'quote"literal', 'trailing\\', '$notAnExpression; & no-command')
    Invoke-ValidationOwnedTool (Get-Command node).Source (@('-e',
        'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))',
        $argumentFile) + $values) $Root 20
    $argumentsPreserved = ([IO.File]::ReadAllText($argumentFile) | ConvertFrom-Json -NoEnumerate | ConvertTo-Json -Compress) -ceq
        (ConvertTo-Json -InputObject $values -Compress)
    try { Invoke-ValidationOwnedTool $pwsh @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 7') $Root 20 }
    catch { $exitPreserved = $_.Exception.Data['tool_exit_code'] -eq 7 }
    try { Invoke-ValidationOwnedTool $pwsh @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Child, $pidFile) $Root 6 }
    catch { $timeoutPreserved = $_.Exception -is [TimeoutException] }
    $childId = [int][IO.File]::ReadAllText($pidFile)
    for ($index = 0; $index -lt 100; $index++) {
        if (!(Get-Process -Id $childId -ErrorAction SilentlyContinue)) { $childGone = $true; break }
        Start-Sleep -Milliseconds 20
    }
    if (!$childGone) {
        Stop-Process -Id $childId -Force
        throw 'Owned descendant survived timeout cleanup.'
    }
    Invoke-ValidationOwnedTool $pwsh @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $Child, $pidFile, '-ExitEarly') $Root 20
    $orphanId = [int][IO.File]::ReadAllText($pidFile)
    $orphanGone = !(Get-Process -Id $orphanId -ErrorAction SilentlyContinue)
    if (!$orphanGone) {
        Stop-Process -Id $orphanId -Force
        throw 'Owned descendant survived an exited launcher.'
    }
}
finally { Exit-ValidationWorkerEnvironment $state }
foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $before[$name]) { throw "Caller environment changed: $name" }
}
if (Test-Path -LiteralPath $state.isolation.process_root) { throw 'Owned scratch was not removed.' }
if ([IO.File]::ReadAllText($trace) -cne 'preserve-foreign-trace') { throw 'An owned managed child wrote outside its tracing boundary.' }
$foreign = Enter-ValidationWorkerEnvironment $Root $Report
$marker = Join-Path $foreign.isolation.process_root '.validation-owner'
[IO.File]::WriteAllText($marker, 'foreign-owner')
$foreignPreserved = $false
try { Exit-ValidationWorkerEnvironment $foreign }
catch { $foreignPreserved = (Test-Path -LiteralPath $marker) -and [IO.File]::ReadAllText($marker) -ceq 'foreign-owner' }
foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $before[$name]) { throw "Failure cleanup changed caller environment: $name" }
}
$foreignDirectory = Join-Path $Root 'foreign-directory'
New-Item -ItemType Directory -Path $foreignDirectory | Out-Null
$sentinel = Join-Path $foreignDirectory 'sentinel'
[IO.File]::WriteAllText($sentinel, 'preserve-foreign')
$link = Join-Path (Split-Path $Report -Parent) 'component-linked'
New-Item -ItemType Junction -Path $link -Target $foreignDirectory | Out-Null
$linkRejected = $false
try { $null = Enter-ValidationWorkerEnvironment $Root $link }
catch { $linkRejected = $_.Exception.Message -like '*linked directory*' -and [IO.File]::ReadAllText($sentinel) -ceq 'preserve-foreign' }
$buildLinkRejected = $true
foreach ($relative in @('src', 'tests', 'vendor', '.tools',
    'src\\CalendarAgenda\\bin', 'src\\CalendarAgenda\\obj',
    'tests\\CalendarAgenda.Tests\\bin', 'tests\\CalendarAgenda.Tests\\obj',
    'src\\CalendarAgenda\\bin\\Debug', 'src\\CalendarAgenda\\obj\\Debug',
    'tests\\CalendarAgenda.Tests\\bin\\Debug\\net10.0', 'tests\\CalendarAgenda.Tests\\obj\\Debug\\net10.0',
    '.bundle', 'vendor\\bundle', '.tools\\framework')) {
    $buildLink = Join-Path $Root $relative
    New-Item -ItemType Directory -Path (Split-Path $buildLink -Parent) -Force | Out-Null
    New-Item -ItemType Junction -Path $buildLink -Target $foreignDirectory | Out-Null
    $rejected = $false
    try { $null = Enter-ValidationWorkerEnvironment $Root $Report }
    catch { $rejected = $_.Exception.Message -like '*linked directory*' -and [IO.File]::ReadAllText($sentinel) -ceq 'preserve-foreign' }
    $buildLinkRejected = $buildLinkRejected -and $rejected
    [IO.Directory]::Delete($buildLink)
}
$fileLink = Join-Path $Root 'src\\CalendarAgenda\\bin\\shared.dll'
New-Item -ItemType HardLink -Path $fileLink -Target $sentinel | Out-Null
$fileLinkRejected = $false
try { $null = Enter-ValidationWorkerEnvironment $Root $Report }
catch { $fileLinkRejected = $_.Exception.Message -like '*linked directory*' -and [IO.File]::ReadAllText($sentinel) -ceq 'preserve-foreign' }
[IO.File]::Delete($fileLink)
$overridesRejected = $true
foreach ($name in @('BaseOutputPath', 'OutputPath', 'OutDir', 'BaseIntermediateOutputPath',
    'IntermediateOutputPath', 'MSBuildProjectExtensionsPath', 'ArtifactsPath', 'UseArtifactsOutput',
    'CompilerGeneratedFilesOutputPath', 'GeneratedAssemblyInfoFile', 'GeneratedGlobalUsingsFile', 'TargetPath',
    'DocumentationFile', 'PublishDir', 'PackageOutputPath',
    'CreateHardLinksForCopyFilesToOutputDirectoryIfPossible',
    'CreateSymbolicLinksForCopyFilesToOutputDirectoryIfPossible')) {
    $previous = [Environment]::GetEnvironmentVariable($name, 'Process')
    try {
        [Environment]::SetEnvironmentVariable($name, $foreignDirectory, 'Process')
        $rejected = $false
        try { $null = Enter-ValidationWorkerEnvironment $Root $Report }
        catch { $rejected = $_.Exception.Message -like '*inherited MSBuild output overrides*' }
        $overridesRejected = $overridesRejected -and $rejected -and
            [Environment]::GetEnvironmentVariable($name, 'Process') -ceq $foreignDirectory
    } finally { Restore-ValidationWorkerVariables @{ $name = $previous } }
}
foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $before[$name]) { throw "Rejected output changed caller environment: $name" }
}
@{ exit_preserved = $exitPreserved; timeout_preserved = $timeoutPreserved; child_gone = $childGone;
   arguments_preserved = $argumentsPreserved;
   shim_preserved = $shimPreserved;
   exited_launcher_child_gone = $orphanGone;
   foreign_preserved = $foreignPreserved; linked_output_rejected = $linkRejected;
   linked_build_rejected = $buildLinkRejected;
   linked_file_rejected = $fileLinkRejected;
   output_overrides_rejected = $overridesRejected;
   roots = $state.isolation } | ConvertTo-Json -Depth 5 -Compress
`);
  const result = spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", probe,
    "-Module", join(root, "scripts", "validation-scheduling.ps1"),
    "-Root", workspace, "-Report", report, "-Child", child
  ], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, TRMNL_TIMING_DIRECTORY: "caller-timing-sentinel",
      GeneratedMSBuildEditorConfigFile: "caller-output-property-sentinel",
      TRMNL_DISCOVERY_PATH: "caller-discovery-sentinel", BUNDLE_PATH: "caller-bundle-sentinel" }
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /owned stdout/);
  assert.match(result.stdout, /owned stderr/);
  const outcome = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(outcome.exit_preserved, true);
  assert.equal(outcome.arguments_preserved, true);
  assert.equal(outcome.shim_preserved, true);
  assert.equal(outcome.output_overrides_rejected, true);
  assert.equal(outcome.linked_file_rejected, true);
  assert.equal(outcome.timeout_preserved, true);
  assert.equal(outcome.child_gone, true);
  assert.equal(outcome.exited_launcher_child_gone, true);
  assert.equal(outcome.foreign_preserved, true);
  assert.equal(outcome.linked_output_rejected, true);
  assert.equal(outcome.linked_build_rejected, true);
  assert.equal(outcome.roots.build_roots.length, 4);
  assert.equal(outcome.roots.workspace_root, workspace);
  await assert.rejects(readFile(join(outcome.roots.process_root, ".validation-owner"), "utf8"), { code: "ENOENT" });
});
