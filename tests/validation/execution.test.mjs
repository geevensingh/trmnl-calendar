import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    schema_version: 1, xunit: "2.9.3.0", adapter: "3.1.4.0", scenarios: [],
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
  const reports = plan.components.map((component, index) => {
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
  return { partitions, coverage, serial, context, nodeFiles, plan, reports,
    jobs: Object.fromEntries(ids.map(id => [id, "success"])) };
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

test("the public worker lifecycle scopes scratch/environment and terminates an owned timed-out process tree", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda worker lifecycle "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const report = join(workspace, "artifacts", "validation", "component-test");
  await mkdir(report, { recursive: true });
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
$names = @('TEMP', 'TMP', 'TMPDIR', 'TRMNL_TIMING_DIRECTORY', 'BUNDLE_PATH')
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
try {
    if ($env:TEMP -cne $state.isolation.process_root -or $env:TMP -cne $env:TEMP -or
        $env:TMPDIR -cne $env:TEMP -or $env:TRMNL_TIMING_DIRECTORY -cne $Report) { throw 'Worker environment was not scoped.' }
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
foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, 'Process') -cne $before[$name]) { throw "Rejected output changed caller environment: $name" }
}
@{ exit_preserved = $exitPreserved; timeout_preserved = $timeoutPreserved; child_gone = $childGone;
   arguments_preserved = $argumentsPreserved;
   exited_launcher_child_gone = $orphanGone;
   foreign_preserved = $foreignPreserved; linked_output_rejected = $linkRejected;
   linked_build_rejected = $buildLinkRejected;
   roots = $state.isolation } | ConvertTo-Json -Depth 5 -Compress
`);
  const result = spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", probe,
    "-Module", join(root, "scripts", "validation-scheduling.ps1"),
    "-Root", workspace, "-Report", report, "-Child", child
  ], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, TRMNL_TIMING_DIRECTORY: "caller-timing-sentinel", BUNDLE_PATH: "caller-bundle-sentinel" }
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /owned stdout/);
  assert.match(result.stdout, /owned stderr/);
  const outcome = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(outcome.exit_preserved, true);
  assert.equal(outcome.arguments_preserved, true);
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
