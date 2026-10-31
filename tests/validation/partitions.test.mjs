import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assignCoverage, compilePartitions, describePartitions, reconcileTests
} from "../../scripts/validation-partitions.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scenarioMethod = "Synthetic.Rendering.Scenarios";

function fixture() {
  const manifest = {
    schema_version: 1, id: "full-partitions-v1", partitions: ["d1", "d2", "d3", "d4"],
    execution_runners: 5, max_parallel_collections: 2,
    methods: {
      "Synthetic.Rendering": {
        All_rows: "d1",
        Scenarios: { d1: ["first"], d2: ["second"], d3: ["third"], d4: ["fourth"] }
      },
      "Synthetic.Domain": { All_theory_rows: "d4" }
    }
  };
  const inventory = {
    schema_version: 2, xunit: "2.9.3.0", adapter: "3.1.4.0",
    methods: [...compilePartitions(manifest).methods.keys()],
    scenarios: ["first", "second", "third", "fourth"],
    tests: [...compilePartitions(manifest).methods].map(([method, assignment], index) => ({
      test_id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      name: `${method}(data: complete)`, method, scenario: assignment.scenarios?.[0] ?? null
    }))
  };
  inventory.scenario_bridges = inventory.tests.filter(item => item.scenario !== null).map(actual => ({
    actual, canonical: { ...actual, method: scenarioMethod, name: `${scenarioMethod}(${actual.scenario})` }
  }));
  const coverage = {
    profile: "OgFirst", policy_id: "og-first-v1", policy_sha256: "a".repeat(64), omitted: [],
    expected: inventory.scenarios.flatMap(scenario => ["og/full", "v2/full"].map(view => ({
      policy: "og-first-v1/OgFirst", method: scenarioMethod, scenario, view, variant: "default"
    })))
  };
  return { manifest, inventory, coverage };
}

test("partition planning assigns every discovered method once and retains scenario identities", () => {
  const { manifest, inventory } = fixture();
  const plan = describePartitions(manifest, inventory);
  assert.equal(plan.execution_runners, 5);
  assert.equal(plan.max_parallel_collections, 2);
  assert.match(plan.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.partitions.flatMap(partition => partition.methods.map(method => method.method)).sort(),
    [...inventory.methods].sort());
  assert.equal(plan.partitions[0].filter,
    "FullyQualifiedName=Synthetic.Rendering.All_rows|FullyQualifiedName=Synthetic.Rendering.Scenarios_d1");
  for (const partition of plan.partitions) {
    assert.ok(!partition.filter.includes("~"));
    const method = partition.methods.find(method => method.scenarios);
    assert.equal(method.canonical_method, scenarioMethod);
    assert.equal(method.scenarios.length, 1);
  }
});

test("partition planning conserves every raw theory identity, not only method or row totals", () => {
  const { manifest, inventory } = fixture();
  const first = inventory.tests[0];
  inventory.tests.push({ ...first, name: `${first.method}(data: another)` });
  const plan = describePartitions(manifest, inventory);
  assert.equal(plan.partitions.flatMap(partition => partition.expected_tests).length, inventory.tests.length);
  for (const partition of plan.partitions) {
    const raw = partition.expected_tests.map(({ test_id, name, method }) => ({
      test_id, name, method, outcome: "Passed"
    }));
    assert.deepEqual(reconcileTests(partition, raw), { expected: raw.length, completed: raw.length });
  }
});

test("partition discovery rejects absent, foreign, duplicate and incomplete theory identities", () => {
  for (const mutate of [
    inventory => { delete inventory.tests; },
    inventory => { inventory.tests = []; },
    inventory => { inventory.tests.pop(); },
    inventory => { inventory.tests.push(inventory.tests[0]); },
    inventory => { inventory.tests[0].method = "Synthetic.Foreign.Tests"; },
    inventory => { inventory.tests[0].test_id = "not-a-test-id"; },
    inventory => { inventory.tests[0].name = ""; },
    inventory => { inventory.tests[1].scenario = "foreign"; }
  ]) {
    const { manifest, inventory } = fixture();
    mutate(inventory);
    assert.throws(() => describePartitions(manifest, inventory));
  }
});

test("raw reconciliation rejects missing, duplicate, foreign, failed and skipped cases", () => {
  for (const mutate of [
    raw => { raw.pop(); },
    raw => { raw.push(raw[0]); },
    raw => { raw[0].test_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"; },
    raw => { raw[0].name += "(foreign row)"; },
    raw => { raw[0].method = "Synthetic.Foreign.Tests"; },
    raw => { raw[0].outcome = "Failed"; },
    raw => { raw[0].outcome = "Skipped"; },
    raw => { raw[0].outcome = "NotExecuted"; }
  ]) {
    const { manifest, inventory } = fixture();
    const partition = describePartitions(manifest, inventory).partitions[0];
    const raw = partition.expected_tests.map(({ test_id, name, method }) => ({
      test_id, name, method, outcome: "Passed"
    }));
    mutate(raw);
    assert.throws(() => reconcileTests(partition, raw));
  }
});

test("scenario wrappers require a complete one-to-one canonical identity bridge", () => {
  for (const mutate of [
    inventory => { delete inventory.scenario_bridges; },
    inventory => { inventory.scenario_bridges.pop(); },
    inventory => { inventory.scenario_bridges.push(inventory.scenario_bridges[0]); },
    inventory => { inventory.scenario_bridges[0].actual = inventory.tests[0]; },
    inventory => { inventory.scenario_bridges[0].canonical.method = "Synthetic.Foreign.Tests"; },
    inventory => { inventory.scenario_bridges[0].canonical.scenario = "foreign"; },
    inventory => { inventory.scenario_bridges[0].canonical.test_id = "not-a-test-id"; },
    inventory => { inventory.scenario_bridges[0].canonical.name = "foreign"; },
    inventory => { inventory.scenario_bridges[0].canonical.result = "Passed"; }
  ]) {
    const { manifest, inventory } = fixture();
    mutate(inventory);
    assert.throws(() => describePartitions(manifest, inventory));
  }
});

test("partition planning rejects unapproved concurrency and arbitrary shard counts", () => {
  for (const mutate of [
    manifest => { manifest.execution_runners = 6; },
    manifest => { manifest.max_parallel_collections = 3; },
    manifest => { manifest.partitions.push("d5"); },
    manifest => { manifest.schema_version = 2; },
    manifest => { manifest.id = "unapproved"; },
    manifest => { manifest.unrecognized = true; }
  ]) {
    const { manifest, inventory } = fixture();
    mutate(manifest);
    assert.throws(() => describePartitions(manifest, inventory));
  }
});

test("partition planning fails closed for missing, extra and duplicated discovered methods", () => {
  for (const mutate of [
    inventory => { inventory.methods.pop(); },
    inventory => { inventory.methods.push("Synthetic.Domain.New_unmapped_test"); },
    inventory => { inventory.methods.push(inventory.methods[0]); },
    inventory => { inventory.methods = []; }
  ]) {
    const { manifest, inventory } = fixture();
    mutate(inventory);
    assert.throws(() => describePartitions(manifest, inventory));
  }
});

test("partition identity derivation requires the verified discovery schema and pinned tools", () => {
  for (const mutate of [
    inventory => { inventory.schema_version = 1; },
    inventory => { inventory.xunit = "3.0.0.0"; },
    inventory => { inventory.adapter = "4.0.0.0"; },
    inventory => { inventory.unknown = true; }
  ]) {
    const { manifest, inventory } = fixture();
    mutate(inventory);
    assert.throws(() => describePartitions(manifest, inventory), /pinned_discovery_schema_required/);
  }
});

test("the pinned real adapter reports two threads with conservative settings and agrees with discovery", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda discovery "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const discoveryPath = join(directory, "discovery.json");
  const result = spawnSync("dotnet", [
    "test", join(root, "tests", "CalendarAgenda.Tests", "CalendarAgenda.Tests.csproj"),
    "--no-build", "--no-restore", "--nologo", "--verbosity", "quiet",
    "--filter", "FullyQualifiedName=CalendarAgenda.Tests.ValidationPartitionTests.Test_case_discovery_materializes_complete_unfiltered_inventory",
    "--settings", join(root, "tests", "validation-partitions.runsettings"),
    "--logger", "trx;LogFileName=discovery.trx", "--results-directory", directory,
    "--", "xUnit.DiagnosticMessages=true"
  ], {
    cwd: root, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
      TRMNL_DISCOVERY_PATH: discoveryPath, TRMNL_TIMING_DIRECTORY: "" }
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  const inventory = JSON.parse(await readFile(discoveryPath, "utf8"));
  const actual = await readFile(join(directory, "discovery.trx"), "utf8");
  const probe = inventory.tests.find(item => item.method ===
    "CalendarAgenda.Tests.ValidationPartitionTests.Test_case_discovery_materializes_complete_unfiltered_inventory");
  assert.ok(probe);
  assert.ok(actual.includes(`testId="${probe.test_id}" testName="${probe.name}"`));
  assert.match(actual, /parallel test collections = on \[2 threads\]/i);
  const settings = await readFile(join(root, "tests", "validation-partitions.runsettings"), "utf8");
  assert.match(settings, /<ParallelAlgorithm>Conservative<\/ParallelAlgorithm>/);
  assert.match(settings, /<ParallelizeAssembly>false<\/ParallelizeAssembly>/);
  assert.match(settings, /<MaxCpuCount>1<\/MaxCpuCount>/);
  assert.equal(inventory.xunit, "2.9.3.0");
  assert.equal(inventory.adapter, "3.1.4.0");
});

test("scenario partitions must be mutually exclusive and cover the complete discovered catalogue", () => {
  for (const mutate of [
    ({ manifest }) => { manifest.methods["Synthetic.Rendering"].Scenarios.d2.push("first"); },
    ({ manifest }) => { manifest.methods["Synthetic.Rendering"].Scenarios.d1 = []; },
    ({ inventory }) => { inventory.scenarios.push("new-unassigned"); },
    ({ inventory }) => { inventory.scenarios.pop(); },
    ({ inventory }) => { inventory.scenarios.push("first"); },
    ({ manifest }) => { manifest.methods["Synthetic.Rendering"].Scenarios.d5 = ["fifth"]; },
    ({ manifest }) => { manifest.methods["Synthetic.Rendering"].Scenarios.d1 = ["../foreign"]; }
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => describePartitions(input.manifest, input.inventory));
  }
});

test("partition filters reject property and expression injection", () => {
  for (const name of ["All_rows|FullyQualifiedName~Other", "All_rows)", "All_rows=Other"]) {
    const { manifest, inventory } = fixture();
    manifest.methods["Synthetic.Rendering"][name] = "d1";
    assert.throws(() => describePartitions(manifest, inventory), /partition_method_name/);
  }
});

test("coverage assignments consume the selected policy inventory without selecting another matrix", () => {
  const { manifest, inventory, coverage } = fixture();
  const plan = describePartitions(manifest, inventory);
  const assigned = assignCoverage(plan, coverage);
  assert.deepEqual(Object.values(assigned).flat(), coverage.expected);
  for (const partition of plan.partitions)
    assert.deepEqual(assigned[partition.id].map(item => item.scenario), [
      partition.methods.find(method => method.scenarios).scenarios[0],
      partition.methods.find(method => method.scenarios).scenarios[0]
    ]);
  assert.deepEqual(coverage.omitted, []);
});

test("coverage assignment rejects duplicates, unknown canonical identities and mismatched profiles", () => {
  for (const mutate of [
    coverage => { coverage.expected.push(coverage.expected[0]); },
    coverage => { coverage.expected[0].method = "Synthetic.Unknown.Test"; },
    coverage => { coverage.expected[0].scenario = "foreign"; },
    coverage => { coverage.expected[0].policy = "og-first-v1/Exhaustive"; },
    coverage => { coverage.expected[0].variant = null; },
    coverage => { coverage.policy_sha256 = "stale"; }
  ]) {
    const { manifest, inventory, coverage } = fixture();
    mutate(coverage);
    assert.throws(() => assignCoverage(describePartitions(manifest, inventory), coverage));
  }
});

test("the public partition planner emits no successful plan for invalid discovery", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda partitions "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { manifest, inventory, coverage } = fixture();
  for (const [name, value] of Object.entries({ manifest, inventory, coverage }))
    await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
  const args = ["manifest", "inventory", "coverage"].flatMap(name => [`--${name}`, join(directory, `${name}.json`)]);
  const run = () => spawnSync(process.execPath, [join(root, "scripts", "validation-partitions.mjs"), ...args],
    { cwd: directory, encoding: "utf8", timeout: 10_000 });
  const success = run();
  assert.equal(success.status, 0, success.stdout + success.stderr);
  const plan = JSON.parse(success.stdout);
  assert.equal(plan.partitions.length, 4);
  assert.equal(plan.partitions.flatMap(partition => partition.expected_coverage).length, coverage.expected.length);
  inventory.methods.push("Synthetic.Unknown.Unassigned");
  await writeFile(join(directory, "inventory.json"), JSON.stringify(inventory));
  const failure = run();
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, "");
  assert.equal(JSON.parse(failure.stderr).partition_plan_succeeded, false);
  assert.equal(await readFile(join(directory, "manifest.json"), "utf8"), JSON.stringify(manifest));
});
