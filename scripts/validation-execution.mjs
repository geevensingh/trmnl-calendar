import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { assignCoverage, reconcileTests } from "./validation-partitions.mjs";

const componentIds = ["d1", "d2", "d3", "d4", "node"];
const serialIds = ["prerequisites", "format", "build", "syntax", "browser", "node", "dotnet", "evidence"];
const provenanceKeys = [
  "run_id", "run_attempt", "head_commit", "base_commit", "evaluated_commit", "evaluated_tree"
];
const digest = /^[a-f0-9]{64}$/;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function requireCondition(condition, error) {
  if (!condition) throw new Error(error);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function workerGraph(serial, component) {
  const excluded = component === "node" ? "dotnet" : "node";
  const graph = serial.filter(item => item.id !== excluded).map(item => ({
    id: item.id, name: item.name,
    requires: item.requires.filter(dependency => !(item.id === "dotnet" && dependency === "node"))
  }));
  const seen = new Set();
  for (const item of graph) {
    requireCondition(item.requires.every(dependency => seen.has(dependency)), "worker_dependency_was_removed");
    seen.add(item.id);
  }
  return graph;
}

function coverageKey(item) {
  return JSON.stringify([item.policy, item.method, item.scenario, item.view, item.variant]);
}

function windowsPath(value) {
  requireCondition(typeof value === "string" && /^[A-Za-z]:\\/.test(value) &&
    !value.includes("\0") && !value.includes("/") && !value.slice(2).includes(":"),
  "absolute_windows_isolation_path_required");
  return win32.normalize(value).replace(/\\+$/, "").toLowerCase();
}

function contains(parent, child) {
  return child === parent || child.startsWith(`${parent}\\`);
}

function validateIsolation(isolation) {
  requireCondition(isolation && typeof isolation.host_id === "string" &&
    /^[A-Za-z0-9._-]{1,128}$/.test(isolation.host_id), "execution_host_identity_required");
  const workspace = windowsPath(isolation.workspace_root);
  requireCondition(workspace.length > 2, "workspace_drive_root_forbidden");
  const artifacts = windowsPath(isolation.artifact_root);
  const processes = windowsPath(isolation.process_root);
  requireCondition(contains(`${workspace}\\artifacts\\validation`, artifacts) &&
    artifacts !== `${workspace}\\artifacts\\validation` &&
    contains(artifacts, processes) && artifacts !== processes, "owned_artifact_and_process_roots_required");
  const expectedBuildRoots = ["src\\CalendarAgenda", "tests\\CalendarAgenda.Tests"]
    .flatMap(project => ["bin", "obj"].map(kind => windowsPath(`${workspace}\\${project}\\${kind}`)));
  requireCondition(Array.isArray(isolation.build_roots) &&
    same(isolation.build_roots.map(windowsPath).sort(), expectedBuildRoots.sort()),
  "independent_normal_build_layout_required");
  return { host: isolation.host_id.toLowerCase(), workspace };
}

export function createExecutionPlan(partitions, coverage, serial, context, nodeFiles) {
  requireCondition(partitions?.schema_version === 1 && partitions.execution_runners === 5 &&
    partitions.max_parallel_collections === 2 &&
    same(partitions.partitions?.map(item => item.id), componentIds.slice(0, 4)) &&
    digest.test(partitions.manifest_sha256) && digest.test(partitions.inventory_sha256),
  "approved_partition_plan_required");
  const identities = new Set();
  for (const partition of partitions.partitions) {
    requireCondition(Array.isArray(partition.methods) && partition.methods.length > 0 &&
      partition.filter === partition.methods.map(item => `FullyQualifiedName=${item.method}`).join("|") &&
      Array.isArray(partition.expected_tests) && partition.expected_tests.length > 0,
    "complete_exact_partition_filter_required");
    const methods = new Set(partition.methods.map(item => item.method));
    const executedMethods = new Set();
    for (const item of partition.expected_tests) {
      const key = JSON.stringify([item.test_id, item.name]);
      requireCondition(methods.has(item.method) && !identities.has(key), "duplicate_or_foreign_planned_case");
      identities.add(key);
      executedMethods.add(item.method);
    }
    requireCondition(executedMethods.size === methods.size, "planned_method_has_no_cases");
    reconcileTests(partition, partition.expected_tests.map(({ test_id, name, method }) => ({
      test_id, name, method, outcome: "Passed"
    })));
  }
  requireCondition(Array.isArray(serial) && same(serial.map(item => item.id), serialIds),
    "complete_serial_component_contract_required");
  const known = new Set();
  for (const component of serial) {
    requireCondition(component && typeof component.name === "string" && component.name.length > 0 &&
      Array.isArray(component.requires) && new Set(component.requires).size === component.requires.length &&
      component.requires.every(dependency => known.has(dependency)), "serial_component_dependency_contract");
    known.add(component.id);
  }
  const node = serial.find(item => item.id === "node");
  requireCondition(["prerequisites", "build", "syntax", "browser"].every(id => node.requires.includes(id)),
    "complete_node_build_and_browser_dependencies_required");
  requireCondition(serial.find(item => item.id === "dotnet").requires.includes("node"),
    "explicit_serial_feedback_edge_required");
  requireCondition(context && typeof context.run_id === "string" && /^[1-9]\d*$/.test(context.run_id) &&
    typeof context.run_attempt === "string" && /^[1-9]\d*$/.test(context.run_attempt) &&
    digest.test(context.content_sha256) &&
    ["head_commit", "evaluated_commit", "evaluated_tree"].every(key => objectId.test(context[key])) &&
    (context.base_commit === null || objectId.test(context.base_commit)), "execution_revision_and_attempt_required");
  requireCondition(Array.isArray(nodeFiles) && nodeFiles.length > 0 && nodeFiles.length <= 1_000 &&
    new Set(nodeFiles).size === nodeFiles.length && nodeFiles.every(file =>
      typeof file === "string" && /^tests\\(?:delivery|validation)\\[^\\/]+\.test\.mjs$/.test(file)),
  "complete_node_file_inventory_required");
  const expectedCoverage = assignCoverage(partitions, coverage);
  assignCoverage(partitions, { ...coverage, expected: coverage.omitted, omitted: [] });
  requireCondition(coverage.expected.length > 0, "complete_coverage_inventory_required");
  const selected = new Set(coverage.expected.map(coverageKey));
  requireCondition(coverage.omitted.every(item => !selected.has(coverageKey(item))),
    "selected_and_omitted_coverage_overlap");
  const contract = serial.map(({ id, name, requires }) => ({ id, name, requires }));
  const plan = {
    schema_version: 1,
    kind: "isolated-validation-execution",
    context: Object.fromEntries([...provenanceKeys, "content_sha256"].map(key => [key, context[key]])),
    execution_runners: 5,
    max_parallel_collections: 2,
    partition_manifest_sha256: partitions.manifest_sha256,
    discovery_inventory_sha256: partitions.inventory_sha256,
    serial_component_contract_sha256: hash(contract),
    coverage: { profile: coverage.profile, policy_id: coverage.policy_id, policy_sha256: coverage.policy_sha256 },
    removed_serial_policy_edges: [{ prerequisite: "node", component: "dotnet" }],
    components: componentIds.map(id => {
      const partition = partitions.partitions.find(item => item.id === id);
      const components = workerGraph(contract, id);
      return {
        id, components, component_contract_sha256: hash(components),
        filter: partition?.filter ?? null,
        expected_tests: partition?.expected_tests ?? [],
        expected_coverage: expectedCoverage[id] ?? [],
        node_files: id === "node" ? [...nodeFiles].sort() : []
      };
    })
  };
  return { ...plan, sha256: hash(plan) };
}

function reconcileCoverage(expected, actual) {
  requireCondition(Array.isArray(actual) && actual.length === expected.length,
    "partition_coverage_incomplete");
  const wanted = new Set(expected.map(coverageKey));
  const seen = new Set();
  for (const item of actual) {
    requireCondition(item && same(Object.keys(item).sort(), ["method", "policy", "scenario", "variant", "view"]),
      "partition_coverage_case_shape");
    const key = coverageKey(item);
    requireCondition(wanted.has(key) && !seen.has(key), "partition_coverage_foreign_or_duplicate");
    seen.add(key);
  }
}

function reconcileNode(expectedFiles, evidence) {
  const summary = evidence?.summary;
  const tests = evidence?.tests;
  requireCondition(summary && Number.isSafeInteger(summary.tests) && summary.tests > 0 &&
    summary.passed === summary.tests &&
    ["failed", "cancelled", "skipped", "todo"].every(key => summary[key] === 0) &&
    Array.isArray(summary.files) && same([...summary.files].sort(), expectedFiles) &&
    Array.isArray(tests) && tests.length > 0 && tests.length <= 100_000,
  "complete_node_evidence_required");
  const files = new Set();
  for (const item of tests) {
    requireCondition(item && item.result === "passed" && expectedFiles.includes(item.file) &&
      typeof item.name === "string" && item.name.length > 0 &&
      ["suite", "test"].includes(item.type) && Number.isSafeInteger(item.nesting) && item.nesting >= 0 &&
      Number.isFinite(item.duration_ms) && item.duration_ms >= 0, "node_test_not_complete");
    files.add(item.file);
  }
  requireCondition(tests.filter(item => item.type !== "suite").length === summary.tests &&
    same([...files].sort(), expectedFiles), "node_raw_file_or_case_inventory_incomplete");
  return summary.tests;
}

// Reports must be freshly decoded from raw artifacts by the authoritative reader, not trusted summary claims.
export function reconcileExecution(plan, reports, jobResults) {
  const { sha256, ...unsigned } = plan;
  requireCondition(digest.test(sha256) && hash(unsigned) === sha256 &&
    plan.kind === "isolated-validation-execution", "execution_plan_hash_mismatch");
  requireCondition(jobResults && same(Object.keys(jobResults).sort(), [...componentIds].sort()) &&
    Object.values(jobResults).every(result => result === "success"), "all_execution_jobs_must_succeed");
  requireCondition(Array.isArray(reports) && reports.length === 5, "complete_component_set_required");
  const completed = new Set();
  const isolation = [];
  let dotnetCount = 0;
  let nodeCount = 0;
  let coverageCount = 0;
  let summedDuration = 0;
  const starts = [];
  const finishes = [];
  for (const report of reports) {
    const id = report?.execution?.component;
    const expected = plan.components.find(component => component.id === id);
    requireCondition(expected && !completed.has(id), "foreign_or_duplicate_component");
    completed.add(id);
    requireCondition(report.schema_version === 1 && report.scope === "Component" && report.outcome === "passed" &&
      report.execution.plan_sha256 === sha256 &&
      report.component_contract_sha256 === expected.component_contract_sha256,
    "successful_bound_component_required");
    requireCondition(report.provenance?.working_tree_clean === true &&
      provenanceKeys.every(key => report.provenance[key] === plan.context[key]) &&
      report.content?.started?.sha256 === plan.context.content_sha256 &&
      report.content?.finished?.sha256 === plan.context.content_sha256 &&
      report.content.unchanged === true, "component_revision_attempt_or_content_mismatch");
    requireCondition(Array.isArray(report.components) &&
      same(report.components.map(({ id, name, requires }) => ({ id, name, requires })), expected.components) &&
      report.components.every(component => component.outcome === "success" &&
        Array.isArray(component.blocked_by) && component.blocked_by.length === 0 &&
        (component.evidence_outcome === null || component.evidence_outcome === "success")),
    "component_contract_or_outcome_incomplete");
    const own = validateIsolation(report.execution.isolation);
    requireCondition(isolation.every(other => other.host !== own.host ||
      (!contains(other.workspace, own.workspace) && !contains(own.workspace, other.workspace))),
    "execution_workspaces_overlap");
    isolation.push(own);
    const evidence = report.evidence;
    requireCondition(evidence?.status === "complete" && digest.test(evidence.inventory_sha256) &&
      evidence.content_sha256 === plan.context.content_sha256 &&
      evidence.component_contract_sha256 === expected.component_contract_sha256,
    "complete_bound_raw_evidence_required");
    if (id === "node") {
      requireCondition(!evidence.dotnet && !evidence.phases, "node_component_contains_dotnet_partition_results");
      nodeCount = reconcileNode(expected.node_files, evidence.node);
    } else {
      requireCondition(!evidence.node && evidence.dotnet && Array.isArray(evidence.dotnet.tests) &&
        Array.isArray(evidence.phases?.display_coverage), "dotnet_component_evidence_required");
      const raw = evidence.dotnet.tests;
      requireCondition(evidence.dotnet.count === raw.length &&
        raw.every(item => Number.isFinite(item.duration_ms) && item.duration_ms >= 0),
        "dotnet_duration_invalid");
      reconcileTests(expected, raw.map(({ test_id, name, method, result }) => ({
        test_id, name, method, outcome: result
      })));
      const coverage = evidence.phases.inventory?.coverage;
      requireCondition(coverage && coverage.profile === plan.coverage.profile &&
        coverage.policy_id === plan.coverage.policy_id &&
        coverage.policy_sha256 === plan.coverage.policy_sha256, "partition_coverage_policy_mismatch");
      reconcileCoverage(expected.expected_coverage, evidence.phases.display_coverage);
      dotnetCount += raw.length;
      coverageCount += evidence.phases.display_coverage.length;
    }
    const start = Date.parse(report.started_at);
    const finish = Date.parse(report.finished_at);
    requireCondition(Number.isFinite(start) && Number.isFinite(finish) && finish >= start &&
      Number.isFinite(report.duration_ms) && report.duration_ms >= 0, "component_intervals_invalid");
    starts.push(start);
    finishes.push(finish);
    summedDuration += report.duration_ms;
  }
  return {
    component_set_complete: true,
    execution_plan_sha256: sha256,
    dotnet_tests: dotnetCount,
    node_tests: nodeCount,
    completed_display_assertions: coverageCount,
    component_validation_utc_span_ms: Math.max(...finishes) - Math.min(...starts),
    summed_component_validation_ms: summedDuration,
    total_job_runner_minutes: null,
    timing_semantics: "Component validation excludes provisioning, queues and aggregate/gate jobs. UTC spans can include host clock skew. Whole-job occupied runner time requires the completed hosted job timeline."
  };
}
