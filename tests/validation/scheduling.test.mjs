import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("hosted Full schedules only the approved isolated five-job execution and fails closed at the stable check", () => {
  const parsed = spawnSync(process.env.TRMNL_RUBY || "ruby", ["-ryaml", "-rjson", "-e",
    'w = YAML.load_file(ARGV.fetch(0)); w["on"] ||= w.delete(true); puts JSON.generate(w)',
    join(root, ".github", "workflows", "full-validation.yml")
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(parsed.status, 0, `${parsed.error ?? ""}\n${parsed.stdout}\n${parsed.stderr}`);
  const workflow = JSON.parse(parsed.stdout);
  const { plan, execute, full, required } = workflow.jobs;
  assert.ok(plan, "Full needs an independently bound plan before execution");
  assert.ok(plan.steps.some(step => step.run?.includes("validate.ps1 -Scope Fast -Execution Plan")));
  assert.equal(execute.needs, "plan");
  assert.equal(execute.strategy["fail-fast"], false);
  assert.equal(execute.strategy["max-parallel"], 5);
  assert.deepEqual(execute.strategy.matrix.component, ["d1", "d2", "d3", "d4", "node"]);
  assert.equal(execute["runs-on"], "windows-2025");
  assert.equal(execute.env.PLAYWRIGHT_BROWSERS_PATH, "${{ github.workspace }}\\.tools\\playwright");
  const worker = execute.steps.find(step => step.id === "worker");
  assert.match(worker.run, /validate\.ps1 -Scope Full -Execution Worker/);
  assert.match(worker.run, /-Component "\$env:VALIDATION_COMPONENT"/);
  const upload = execute.steps.find(step => step.with?.name?.startsWith("validation-component-"));
  assert.equal(upload.with.name,
    "validation-component-${{ matrix.component }}-${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(full.name, "Full validation");
  assert.deepEqual(full.needs, ["plan", "execute"]);
  assert.equal(full.if, "${{ always() }}");
  assert.equal(full.outputs.preparation, "${{ needs.plan.outputs.preparation }}");
  const aggregate = full.steps.find(step => step.run?.includes("validate.ps1 -Scope Full -Execution Aggregate"));
  assert.equal(aggregate.if, "${{ always() }}", "Failed workers must not skip raw aggregation");
  assert.equal(aggregate.env.EXECUTION_RESULT, "${{ needs.execute.result }}");
  for (const transfer of full.steps.filter(step => step.uses === "actions/download-artifact@v4"))
    assert.equal(transfer.if, "${{ always() }}", "Available failure evidence must still be collected");
  assert.equal(required.needs, "full");
  assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened", "edited"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  assert.ok(workflow.concurrency.group.includes("full-validation-"));
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(!job["continue-on-error"]);
    assert.ok(job.steps.every(step => !step["continue-on-error"] && !step.with?.["restore-keys"]));
  }
  assert.ok(!workflow.on.pull_request_target);
});
