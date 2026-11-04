import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createExecutionPlan, reconcileExecution } from "../../scripts/validation-execution.mjs";
import { describePartitions } from "../../scripts/validation-partitions.mjs";


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
          execution_environment: { kind: "physical-host" },
          artifact_root: artifact, process_root: `${workspace}\\.tools\\run\\${1000 + index}-1`,
          browser_root: `${workspace}\\.tools\\playwright`,
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
    state => { state.reports[1].execution.isolation.process_root =
      `${state.reports[1].execution.isolation.artifact_root}\\process-legacy`; },
    state => { state.reports[1].execution.isolation.browser_root = "D:\\shared-browser"; },
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

function hostedReports(state) {
  const paths = structuredClone(state.reports[0].execution.isolation);
  for (const [index, report] of state.reports.entries()) {
    report.execution.isolation = {
      ...structuredClone(paths), host_id: "runnervmhao91",
      execution_environment: {
        kind: "github-hosted", run_id: state.context.run_id, run_attempt: state.context.run_attempt,
        runner_name: `GitHubActions${1000023469 + index}`
      }
    };
  }
}

test("hosted allocations with distinct runner names may reuse image hostnames and Windows workspace paths", () => {
  const state = fixture();
  hostedReports(state);
  assert.equal(reconcileExecution(state.plan, state.reports, state.jobs).component_set_complete, true);
  state.reports[1].execution.isolation.execution_environment.runner_name =
    state.reports[0].execution.isolation.execution_environment.runner_name;
  assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs), /execution_workspaces_overlap/);
  const separate = fixture();
  for (const report of separate.reports) {
    report.execution.isolation.execution_environment = {
      kind: "github-hosted", run_id: separate.context.run_id, run_attempt: separate.context.run_attempt,
      runner_name: "Hosted Agent"
    };
  }
  assert.equal(reconcileExecution(separate.plan, separate.reports, separate.jobs).component_set_complete, true);
});

test("hosted isolation rejects absent, malformed and cross-run allocation identities", () => {
  for (const mutate of [
    own => { delete own.execution_environment; },
    own => { own.execution_environment.kind = "foreign-hosted"; },
    own => { delete own.execution_environment.runner_name; },
    own => { own.execution_environment.runner_name = ""; },
    own => { own.execution_environment.runner_name = " runner "; },
    own => { own.execution_environment.runner_name = "runner\nforeign"; },
    own => { own.execution_environment.run_id = "100"; },
    own => { own.execution_environment.run_attempt = "1"; },
    own => { own.execution_environment.run_id = "local-not-a-hosted-run"; },
    own => { own.execution_environment.component = "d1"; }
  ]) {
    const state = fixture();
    hostedReports(state);
    mutate(state.reports[0].execution.isolation);
    assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs), /execution_environment/);
  }
  const state = fixture();
  hostedReports(state);
  state.reports[1].execution.isolation.host_id = "different-display-name";
  state.reports[1].execution.isolation.execution_environment =
    structuredClone(state.reports[0].execution.isolation.execution_environment);
  assert.throws(() => reconcileExecution(state.plan, state.reports, state.jobs), /execution_workspaces_overlap/);
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

test("the public worker rejects a shared or linked writable browser cache before creating output", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda worker browser ownership "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  await cp(join(root, "scripts"), join(workspace, "scripts"), { recursive: true });
  const planPath = join(directory, "plan.json");
  await writeFile(planPath, JSON.stringify(fixture().plan));
  await mkdir(join(workspace, "tests"));
  await cp(join(root, "tests", "display-coverage.json"), join(workspace, "tests", "display-coverage.json"));
  const foreign = join(directory, "foreign-browser");
  await mkdir(foreign);
  await writeFile(join(foreign, "debug.log"), "foreign-browser-sentinel");
  const own = join(workspace, ".tools", "playwright");
  await mkdir(own, { recursive: true });
  const invoke = browser => {
    const result = spawnSync("pwsh", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(workspace, "scripts", "validate.ps1"),
      "-Scope", "Full", "-Execution", "Worker", "-Component", "d1", "-ExecutionPlan", planPath
    ], {
      cwd: workspace, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_RUN_ID: "", GITHUB_OUTPUT: "", PLAYWRIGHT_BROWSERS_PATH: browser }
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return result;
  };
  for (const browser of ["", foreign]) {
    await t.test(browser ? "foreign selection with physical owned cache" : "unset selection with physical owned cache", async () => {
      const result = invoke(browser);
      assert.match(result.stderr, /Worker browser cache must be independently prepared at this checkout/);
      assert.doesNotMatch(result.stdout, /Timing report:|== Prerequisites ==/);
      assert.equal(await readFile(join(foreign, "debug.log"), "utf8"), "foreign-browser-sentinel");
    });
  }
  await rm(own, { recursive: true });
  await symlink(foreign, own, "junction");
  const linked = invoke(own);
  assert.match(linked.stderr, /linked directory/);
  assert.doesNotMatch(linked.stdout, /Timing report:|== Prerequisites ==/);
  assert.equal(await readFile(join(foreign, "debug.log"), "utf8"), "foreign-browser-sentinel");
  await unlink(own);
});
