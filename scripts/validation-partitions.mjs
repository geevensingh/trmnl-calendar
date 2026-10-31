import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const partitions = ["d1", "d2", "d3", "d4"];
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const className = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*$/;
const testId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function requireCondition(condition, error) {
  if (!condition) throw new Error(error);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function compilePartitions(manifest) {
  requireCondition(exactKeys(manifest, [
    "schema_version", "id", "partitions", "execution_runners", "max_parallel_collections", "methods"
  ]), "partition_manifest_shape");
  requireCondition(manifest.schema_version === 1 && manifest.id === "full-partitions-v1" &&
    JSON.stringify(manifest.partitions) === JSON.stringify(partitions) &&
    manifest.execution_runners === 5 && manifest.max_parallel_collections === 2,
  "owner_approved_partition_bound_required");
  requireCondition(record(manifest.methods) && Object.keys(manifest.methods).length > 0,
    "partition_methods_required");

  const methods = new Map();
  const scenarios = new Map();
  for (const [type, assignments] of Object.entries(manifest.methods)) {
    requireCondition(className.test(type) && record(assignments) && Object.keys(assignments).length > 0,
      "partition_class_assignment");
    for (const [name, assignment] of Object.entries(assignments)) {
      requireCondition(identifier.test(name), "partition_method_name");
      const canonicalMethod = `${type}.${name}`;
      if (typeof assignment === "string") {
        requireCondition(partitions.includes(assignment), "unknown_partition");
        requireCondition(!methods.has(canonicalMethod), "duplicate_partition_method");
        methods.set(canonicalMethod, { partition: assignment, canonical_method: canonicalMethod, scenarios: null });
      } else {
        requireCondition(exactKeys(assignment, partitions), "scenario_partition_shape");
        for (const partition of partitions) {
          const ids = assignment[partition];
          requireCondition(Array.isArray(ids) && ids.length > 0 &&
            ids.every(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)),
          "scenario_partition_ids");
          const method = `${canonicalMethod}_${partition}`;
          requireCondition(!methods.has(method), "duplicate_partition_method");
          for (const id of ids) {
            const key = `${canonicalMethod}/${id}`;
            requireCondition(!scenarios.has(key), "duplicate_partition_scenario");
            scenarios.set(key, partition);
          }
          methods.set(method, { partition, canonical_method: canonicalMethod, scenarios: [...ids] });
        }
      }
    }
  }
  for (const partition of partitions)
    requireCondition([...methods.values()].some(method => method.partition === partition), "empty_partition");
  return { methods, scenarios };
}

export function describePartitions(manifest, inventory) {
  const compiled = compilePartitions(manifest);
  requireCondition(exactKeys(inventory, [
    "schema_version", "methods", "scenarios", "tests", "scenario_bridges", "xunit", "adapter"
  ]) && inventory.schema_version === 2 && inventory.xunit === "2.9.3.0" &&
    inventory.adapter === "3.1.4.0", "pinned_discovery_schema_required");
  requireCondition(Array.isArray(inventory.methods) &&
    inventory.methods.length > 0 && inventory.methods.length <= 10_000 &&
    inventory.methods.every(method => typeof method === "string") &&
    new Set(inventory.methods).size === inventory.methods.length, "discovered_methods_required");
  const discovered = new Set(inventory.methods);
  requireCondition(discovered.size === compiled.methods.size &&
    [...compiled.methods.keys()].every(method => discovered.has(method)), "partition_method_inventory_mismatch");
  const scenarioMethods = new Set([...compiled.methods.values()]
    .filter(method => method.scenarios).map(method => method.canonical_method));
  if (scenarioMethods.size > 0) {
    requireCondition(Array.isArray(inventory.scenarios) && inventory.scenarios.length > 0 &&
      inventory.scenarios.every(id => typeof id === "string") &&
      new Set(inventory.scenarios).size === inventory.scenarios.length, "discovered_scenarios_required");
    for (const method of scenarioMethods) {
      const actual = [...compiled.scenarios.keys()].filter(key => key.startsWith(`${method}/`));
      requireCondition(actual.length === inventory.scenarios.length &&
        inventory.scenarios.every(id => compiled.scenarios.has(`${method}/${id}`)),
      "partition_scenario_inventory_mismatch");
    }
  }
  const plan = {
    schema_version: 1,
    id: manifest.id,
    manifest_sha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    execution_runners: manifest.execution_runners,
    max_parallel_collections: manifest.max_parallel_collections,
    partitions: partitions.map(partition => {
      const methods = [...compiled.methods].filter(([, value]) => value.partition === partition)
        .map(([method, value]) => ({ method, ...value })).sort((a, b) => a.method.localeCompare(b.method, "en"));
      return {
        id: partition,
        methods,
        filter: methods.map(method => `FullyQualifiedName=${method.method}`).join("|")
      };
    })
  };
  const assignedTests = assignTests(plan, inventory);
  for (const partition of plan.partitions) partition.expected_tests = assignedTests[partition.id];
  requireCondition(Array.isArray(inventory.scenario_bridges), "scenario_identity_bridges_required");
  const scenarioTests = plan.partitions.flatMap(partition =>
    partition.expected_tests.filter(item => partition.methods.find(method =>
      method.method === item.method).scenarios !== null));
  const bridged = new Set();
  const canonicalCases = new Set();
  const canonicalScenarios = new Set();
  for (const bridge of inventory.scenario_bridges) {
    requireCondition(exactKeys(bridge, ["actual", "canonical"]) &&
      exactKeys(bridge.canonical, ["test_id", "name", "method", "scenario"]), "scenario_bridge_shape");
    const actual = scenarioTests.find(item => caseKey(item) === caseKey(bridge.actual));
    const owner = actual && plan.partitions.flatMap(partition => partition.methods)
      .find(method => method.method === actual.method);
    requireCondition(actual && JSON.stringify(actual) === JSON.stringify(bridge.actual) &&
      !bridged.has(caseKey(actual)) && bridge.canonical.method === owner.canonical_method &&
      bridge.canonical.scenario === actual.scenario && testId.test(bridge.canonical.test_id) &&
      typeof bridge.canonical.name === "string" && bridge.canonical.name.startsWith(`${owner.canonical_method}(`) &&
      !canonicalCases.has(caseKey(bridge.canonical)) &&
      !canonicalScenarios.has(JSON.stringify([bridge.canonical.method, bridge.canonical.scenario])),
    "scenario_bridge_identity_mismatch");
    bridged.add(caseKey(actual));
    canonicalCases.add(caseKey(bridge.canonical));
    canonicalScenarios.add(JSON.stringify([bridge.canonical.method, bridge.canonical.scenario]));
  }
  requireCondition(bridged.size === scenarioTests.length, "scenario_identity_bridges_incomplete");
  plan.scenario_bridges = inventory.scenario_bridges;
  plan.inventory_sha256 = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  return plan;
}

function caseKey(item) {
  return JSON.stringify([item.test_id, item.name]);
}

export function assignTests(plan, inventory) {
  requireCondition(Array.isArray(inventory.tests) && inventory.tests.length > 0 &&
    inventory.tests.length <= 100_000, "discovered_test_cases_required");
  const result = Object.fromEntries(plan.partitions.map(partition => [partition.id, []]));
  const methods = new Map(plan.partitions.flatMap(partition =>
    partition.methods.map(method => [method.method, { ...method, partition: partition.id }])));
  const cases = new Set();
  const discoveredScenarios = new Map();
  for (const item of inventory.tests) {
    requireCondition(exactKeys(item, ["test_id", "name", "method", "scenario"]) &&
      testId.test(item.test_id) && typeof item.name === "string" && item.name.length > 0 &&
      (item.scenario === null || typeof item.scenario === "string"), "discovered_test_case_shape");
    const owner = methods.get(item.method);
    requireCondition(owner !== undefined, "unassigned_discovered_test_case");
    requireCondition(owner.scenarios === null || owner.scenarios.includes(item.scenario),
      "discovered_test_scenario_partition_mismatch");
    const key = caseKey(item);
    requireCondition(!cases.has(key), "duplicate_discovered_test_case");
    cases.add(key);
    result[owner.partition].push(item);
    if (!discoveredScenarios.has(item.method)) discoveredScenarios.set(item.method, new Set());
    discoveredScenarios.get(item.method).add(item.scenario);
  }
  for (const [method, assignment] of methods) {
    const scenarios = discoveredScenarios.get(method);
    requireCondition(scenarios !== undefined, "discovered_method_has_no_cases");
    if (assignment.scenarios !== null)
      requireCondition(scenarios.size === assignment.scenarios.length &&
        assignment.scenarios.every(scenario => scenarios.has(scenario)),
      "discovered_scenario_cases_incomplete");
  }
  return result;
}

export function reconcileTests(partition, actual) {
  requireCondition(Array.isArray(actual) && actual.length > 0, "raw_partition_tests_required");
  const expected = new Map(partition.expected_tests.map(item => [caseKey(item), item]));
  const completed = new Set();
  for (const item of actual) {
    requireCondition(exactKeys(item, ["test_id", "name", "method", "outcome"]) &&
      item.outcome === "Passed", "partition_test_not_passed");
    const key = caseKey(item);
    const wanted = expected.get(key);
    requireCondition(wanted !== undefined && wanted.method === item.method,
      "unexpected_partition_test");
    requireCondition(!completed.has(key), "duplicate_partition_test");
    completed.add(key);
  }
  requireCondition(completed.size === expected.size, "partition_tests_incomplete");
  return { expected: expected.size, completed: completed.size };
}

export function assignCoverage(plan, coverage) {
  requireCondition(record(coverage) && typeof coverage.policy_id === "string" &&
    /^[a-f0-9]{64}$/.test(coverage.policy_sha256 ?? "") &&
    ["OgFirst", "Exhaustive"].includes(coverage.profile) &&
    Array.isArray(coverage.expected) && Array.isArray(coverage.omitted), "coverage_policy_inventory_required");
  const result = Object.fromEntries(plan.partitions.map(partition => [partition.id, []]));
  const cases = new Set();
  for (const item of coverage.expected) {
    requireCondition(exactKeys(item, ["policy", "method", "scenario", "view", "variant"]) &&
      item.policy === `${coverage.policy_id}/${coverage.profile}` &&
      typeof item.method === "string" && (item.scenario === null || typeof item.scenario === "string") &&
      typeof item.view === "string" && typeof item.variant === "string", "coverage_case_shape");
    const key = JSON.stringify([item.policy, item.method, item.scenario, item.view, item.variant]);
    requireCondition(!cases.has(key), "duplicate_expected_coverage_case");
    cases.add(key);
    const owners = plan.partitions.filter(partition => partition.methods.some(method =>
      method.canonical_method === item.method &&
      (method.scenarios === null || method.scenarios.includes(item.scenario))));
    requireCondition(owners.length === 1, "coverage_case_partition_mismatch");
    result[owners[0].id].push(item);
  }
  return result;
}

export async function readPartitionJson(path) {
  const content = await readFile(path);
  requireCondition(content.length <= 10 * 1024 * 1024, "partition_inventory_size_limit");
  return JSON.parse(content.toString("utf8"));
}

async function main() {
  const { values } = parseArgs({
    options: {
      manifest: { type: "string" }, inventory: { type: "string" }, coverage: { type: "string" }
    }
  });
  requireCondition(typeof values.inventory === "string", "partition_inventory_argument_required");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = await readPartitionJson(values.manifest ?? join(root, "tests", "validation-partitions.json"));
  const plan = describePartitions(manifest, await readPartitionJson(values.inventory));
  if (values.coverage) {
    const coverage = await readPartitionJson(values.coverage);
    const assignments = assignCoverage(plan, coverage);
    plan.coverage = {
      policy_id: coverage.policy_id, policy_sha256: coverage.policy_sha256, profile: coverage.profile
    };
    for (const partition of plan.partitions) partition.expected_coverage = assignments[partition.id];
  }
  console.log(JSON.stringify(plan));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ partition_plan_succeeded: false, error: error.message }));
    process.exitCode = 1;
  });
}
