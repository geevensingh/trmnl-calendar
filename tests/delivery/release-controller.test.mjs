import assert from "node:assert/strict";
import test from "node:test";
import {
  admitMainCommits,
  activateReleaseBaseline,
  artifactIdentity,
  classifyPaths,
  listReleaseStatus,
  recoverInterruptedRelease,
  retryFailedRelease,
  runNextRelease,
  skipFailedRelease
} from "../../scripts/release-controller.mjs";
import * as controller from "../../scripts/release-controller.mjs";
import { AzureBlobLedger } from "../../scripts/azure-blob-ledger.mjs";

const commit = letter => letter.repeat(40);
const releaseArtifact = (sha, references = { azure: `packages/${sha}.zip` }, metadata = {}) => {
  const digests = Object.fromEntries(Object.keys(references).map(target => [target, "b".repeat(64)]));
  return {
    commit: sha,
    identity: artifactIdentity(sha, references, digests, metadata),
    references,
    digests,
    metadata
  };
};

function memoryLedger() {
  let state = null;
  let locked = false;
  return {
    async withExclusive(operation) {
      assert.equal(locked, false, "release operations must use a single non-reentrant lock");
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(next) {
      state = structuredClone(next);
    },
    async replace(next) {
      state = structuredClone(next);
    }
  };
}

async function activatedLedger() {
  const ledger = memoryLedger();
  await activateReleaseBaseline({
    ledger,
    commit: commit("a"),
    actor: "owner",
    reason: "Authorized initial baseline",
    azureBootstrapVerified: true,
    trmnlBackupRecoveryAccepted: true,
    services: {
      async prepare(head, targets) {
        return releaseArtifact(head, Object.fromEntries(targets.map(target =>
          [target, `${target}/${head}`])));
      },
      async deployAndVerifyAzure() { return { verified: true }; },
      async publishAndVerifyTrmnl() { return { verified: true }; }
    }
  });
  return ledger;
}

test("explicit activation repair publishes the corrected TRMNL artifact without retargeting Azure or losing failure evidence", async () => {
  const ledger = memoryLedger();
  const original = commit("a");
  const corrected = commit("c");
  const invalidArchive = releaseArtifact(original, { azure: "azure/original", trmnl: "trmnl/invalid" });
  const correctedArchive = releaseArtifact(corrected, {
    trmnl: `releases/${corrected}/trmnl-${"c".repeat(64)}.tar`
  });
  correctedArchive.digests.trmnl = "c".repeat(64);
  correctedArchive.identity = artifactIdentity(corrected, correctedArchive.references, correctedArchive.digests, {});
  const publications = [];
  let azureDeployments = 0;
  const services = {
    async prepare() { return invalidArchive; },
    async deployAndVerifyAzure() { azureDeployments += 1; return { verified: true }; },
    async publishAndVerifyTrmnl(source, artifact) {
      publications.push({ source, artifact });
      if (source === original) throw Object.assign(new Error(), { code: "trmnl_push_http_422" });
      return { verified: true };
    },
    async verifyArtifact() { return true; },
    async prepareTrmnlActivationRepair(artifact, source) {
      assert.deepEqual(artifact, invalidArchive);
      assert.equal(source, corrected);
      return correctedArchive;
    }
  };
  const options = {
    ledger, commit: original, actor: "owner", reason: "Synthetic baseline",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true, services
  };
  assert.equal((await activateReleaseBaseline(options)).status, "failed");
  const failed = await ledger.read();
  assert.equal(typeof controller.repairActivationTrmnl, "function");
  const result = await controller.repairActivationTrmnl({
    ...options, correctedCommit: corrected, previousMutationStopped: true,
    reason: "Previous publisher stopped; reviewed description correction"
  });
  assert.equal(result.status, "succeeded");
  assert.equal(azureDeployments, 1);
  assert.deepEqual(publications, [
    { source: original, artifact: invalidArchive },
    { source: corrected, artifact: correctedArchive }
  ]);
  const state = await ledger.read();
  assert.equal(state.activation.commit, original);
  assert.deepEqual(state.activation.artifact, invalidArchive);
  assert.deepEqual(state.activation.first_failure, failed.activation.first_failure);
  assert.deepEqual(state.activation.trmnl_repair.original_failure, failed.activation.failure);
  assert.deepEqual(state.activation.trmnl_repair.artifact, correctedArchive);
  const status = await listReleaseStatus({ ledger });
  assert.equal(status.checkpoint, original);
  assert.deepEqual(status.baselines, { azure: original, trmnl: corrected });
  assert.equal(status.activation.trmnl_repair.commit, corrected);
  assert.equal(status.activation.trmnl_repair.artifact.identity, correctedArchive.identity);
  assert.deepEqual(status.pending_reconciliation, { azure: false, trmnl: false });
  assert.equal(status.activation.recovery_confirmation_required, false);
  assert.doesNotMatch(JSON.stringify(status), /Previous publisher stopped; reviewed description correction/);
});

async function failedTrmnlActivation() {
  const ledger = memoryLedger();
  const original = commit("a");
  const corrected = commit("c");
  const options = {
    ledger, commit: original, actor: "owner", reason: "Synthetic baseline",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true,
    services: {
      async prepare() { return releaseArtifact(original, { azure: "azure/original", trmnl: "trmnl/invalid" }); },
      async deployAndVerifyAzure() { return { verified: true }; },
      async publishAndVerifyTrmnl() { throw Object.assign(new Error(), { code: "trmnl_push_http_422" }); },
      async verifyArtifact() { return true; }
    }
  };
  await activateReleaseBaseline(options);
  const artifact = releaseArtifact(corrected, {
    trmnl: `releases/${corrected}/trmnl-${"b".repeat(64)}.tar`
  });
  artifact.digests.trmnl = "c".repeat(64);
  artifact.references.trmnl = `releases/${corrected}/trmnl-${artifact.digests.trmnl}.tar`;
  artifact.identity = artifactIdentity(corrected, artifact.references, artifact.digests, {});
  options.services.prepareTrmnlActivationRepair = async () => artifact;
  options.services.publishAndVerifyTrmnl = async () => ({ verified: true });
  return { ...options, correctedCommit: corrected, previousMutationStopped: true, artifact };
}

test("repair rejects mismatched archive provenance without retaining or publishing the candidate", async () => {
  for (const change of [
    artifact => { artifact.commit = commit("d"); },
    artifact => { artifact.references.trmnl = "trmnl/unbound"; },
    artifact => { artifact.references.azure = "azure/unrequested"; artifact.digests.azure = "c".repeat(64); },
    artifact => { artifact.digests.trmnl = "b".repeat(64); },
    artifact => { artifact.identity = "sha256:forged"; }
  ]) {
    const options = await failedTrmnlActivation();
    const original = await options.ledger.read();
    const invalid = structuredClone(options.artifact);
    change(invalid);
    if (invalid.identity !== "sha256:forged") {
      invalid.identity = artifactIdentity(invalid.commit, invalid.references, invalid.digests, invalid.metadata);
    }
    options.services.prepareTrmnlActivationRepair = async () => invalid;
    options.services.publishAndVerifyTrmnl = async () => assert.fail("Invalid replacement must not publish");
    const result = await controller.repairActivationTrmnl(options);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "artifact_identity_invalid");
    const state = await options.ledger.read();
    assert.equal(state.activation.trmnl_repair.artifact, null);
    assert.deepEqual(state.activation.artifact, original.activation.artifact);
    assert.deepEqual(state.activation.first_failure, original.activation.first_failure);
    assert.equal(state.active, false);
  }
});

test("repair is restricted to the failed initial TRMNL validation target and requires explicit evidence", async () => {
  for (const [change, error] of [
    [options => { options.previousMutationStopped = false; }, "previous_mutation_stop_confirmation_required"],
    [options => { options.actor = ""; }, "attribution_required"],
    [options => { options.reason = ""; }, "attribution_required"],
    [options => { options.azureBootstrapVerified = false; }, "activation_evidence_required"],
    [options => { options.trmnlBackupRecoveryAccepted = false; }, "activation_evidence_required"],
    [options => { options.commit = commit("d"); }, "activation_trmnl_repair_not_applicable"],
    [options => { options.correctedCommit = options.commit; }, "activation_trmnl_repair_not_applicable"]
  ]) {
    const options = await failedTrmnlActivation();
    const before = await options.ledger.read();
    change(options);
    await assert.rejects(controller.repairActivationTrmnl(options), { message: error });
    assert.deepEqual(await options.ledger.read(), before);
  }
  for (const change of [
    state => { delete state.activation; },
    state => { state.active = true; },
    state => { state.checkpoint = commit("a"); },
    state => { state.baselines.azure = commit("a"); },
    state => { state.activation.target_results.azure = "failed"; },
    state => { state.pending_reconciliation.azure = true; },
    state => { state.activation.target_results.trmnl = "verified"; },
    state => { state.activation.failure.code = "trmnl_field_migration_required"; }
  ]) {
    const options = await failedTrmnlActivation();
    const before = await options.ledger.read();
    change(before);
    await options.ledger.replace(before);
    await assert.rejects(controller.repairActivationTrmnl(options));
    assert.deepEqual(await options.ledger.read(), before);
  }
});

for (const interruption of ["prepare", "artifact_saved", "publish", "verified_saved"]) {
  test(`repair resumes the same corrected artifact after interruption at ${interruption}`, async () => {
    const options = await failedTrmnlActivation();
    const { ledger, services } = options;
    const original = await ledger.read();
    let prepares = 0;
    let publications = 0;
    const abort = new AbortController();
    const withExclusive = ledger.withExclusive;
    const write = ledger.write;
    ledger.withExclusive = operation => withExclusive(() => operation(abort.signal));
    ledger.write = async state => {
      await write(state);
      if ((interruption === "artifact_saved" && state.activation.trmnl_repair?.artifact) ||
        (interruption === "verified_saved" && state.activation.target_results.trmnl === "verified")) {
        abort.abort(new Error("synthetic_lease_lost"));
      }
    };
    services.prepareTrmnlActivationRepair = async () => {
      prepares += 1;
      if (interruption === "prepare") abort.abort(new Error("synthetic_lease_lost"));
      return options.artifact;
    };
    services.deployAndVerifyAzure = async () => assert.fail("Azure was already verified");
    services.publishAndVerifyTrmnl = async (commit, artifact, { signal }) => {
      assert.equal(commit, options.correctedCommit);
      assert.deepEqual(artifact, options.artifact);
      assert.equal(signal, abort.signal);
      publications += 1;
      if (interruption === "publish") abort.abort(new Error("synthetic_lease_lost"));
      return { verified: true };
    };
    await assert.rejects(controller.repairActivationTrmnl(options), { message: "synthetic_lease_lost" });
    ledger.withExclusive = withExclusive;
    ledger.write = write;
    const interrupted = await ledger.read();
    assert.equal(interrupted.activation.status, "running");
    assert.equal(interrupted.active, false);
    await assert.rejects(activateReleaseBaseline(options), { message: "activation_repair_operation_required" });
    await assert.rejects(controller.repairActivationTrmnl({
      ...options, correctedCommit: commit("d")
    }), { message: "activation_repair_commit_conflict" });
    await assert.rejects(controller.repairActivationTrmnl({
      ...options, previousMutationStopped: false
    }), { message: "previous_mutation_stop_confirmation_required" });
    assert.deepEqual(await ledger.read(), interrupted, "rejected recovery cannot clear the barrier");
    const detected = await controller.repairActivationTrmnl(options);
    assert.equal(detected.code, "interrupted_uncertain");
    assert.equal(publications, ["publish", "verified_saved"].includes(interruption) ? 1 : 0);
    services.prepareTrmnlActivationRepair = async () => { prepares += 1; return options.artifact; };
    services.publishAndVerifyTrmnl = async (commit, artifact) => {
      assert.equal(commit, options.correctedCommit);
      assert.deepEqual(artifact, options.artifact);
      publications += 1;
      return { verified: true };
    };
    assert.equal((await controller.repairActivationTrmnl(options)).status, "succeeded");
    assert.equal(prepares, interruption === "prepare" ? 2 : 1);
    assert.equal(publications, interruption === "publish" ? 2 : 1);
    const state = await ledger.read();
    assert.deepEqual(state.activation.artifact, original.activation.artifact);
    assert.deepEqual(state.activation.first_failure, original.activation.first_failure);
    assert.deepEqual(state.activation.trmnl_repair.original_failure, original.activation.failure);
    assert.equal(state.activation.trmnl_repair.attempts.length, 2);
    assert.equal(state.activation.trmnl_repair.attempts[0].failure.code, "interrupted_uncertain");
    assert.equal(state.activation.trmnl_repair.attempts[1].result, "succeeded");
    assert.deepEqual(state.baselines, { azure: options.commit, trmnl: options.correctedCommit });
  });
}

test("repair cannot publish when its mutation barrier fails the leased conditional write", async () => {
  const options = await failedTrmnlActivation();
  let state = await options.ledger.read();
  let etag = 1;
  const calls = [];
  const ledger = new AzureBlobLedger({
    account: "syntheticrepair", container: "release-control",
    getToken: async () => "synthetic-token",
    fetchImpl: async (_url, request) => {
      const action = request.headers["x-ms-lease-action"];
      calls.push(action ?? request.method);
      if (action === "acquire") {
        return new Response("", { status: 201, headers: { "x-ms-lease-id": "repair-lease" } });
      }
      if (action === "release") return new Response("", { status: 200 });
      if (request.method === "GET") return Response.json(state, { headers: { etag: `"${etag}"` } });
      assert.equal(request.headers["x-ms-lease-id"], "repair-lease");
      assert.equal(request.headers["If-Match"], `"${etag}"`);
      const candidate = JSON.parse(request.body);
      if (candidate.activation.stage === "trmnl_deploy") return new Response("", { status: 412 });
      state = candidate;
      etag += 1;
      return new Response("", { status: 201, headers: { etag: `"${etag}"` } });
    }
  });
  options.services.publishAndVerifyTrmnl = async () => assert.fail("Unpersisted mutation cannot start");
  await assert.rejects(controller.repairActivationTrmnl({ ...options, ledger }), { code: "storage_http_412" });
  assert.equal(state.activation.status, "running");
  assert.deepEqual(state.activation.trmnl_repair.artifact, options.artifact);
  assert.equal(state.activation.target_results.azure, "verified");
  assert.equal(state.active, false);
  assert.ok(calls.includes("acquire"));
  assert.equal(calls.at(-1), "release");
});

for (const mode of ["repair", "activation"]) {
  test(`${mode} final-save failure stays readable and resumes without repeating verified targets`, async () => {
    const options = await failedTrmnlActivation();
    const { ledger, services } = options;
    const original = await ledger.read();
    const operation = mode === "repair" ? controller.repairActivationTrmnl : activateReleaseBaseline;
    const write = ledger.write;
    let failCompletion = true;
    ledger.write = async state => {
      if (failCompletion && state.active && state.activation.status === "succeeded") {
        failCompletion = false;
        throw Object.assign(new Error(), { code: "synthetic_completion_write_failed" });
      }
      await write(state);
    };
    services.deployAndVerifyAzure = async () => assert.fail("Azure was already verified");
    const failed = await operation(options);
    assert.equal(failed.code, "synthetic_completion_write_failed");
    const status = await listReleaseStatus({ ledger });
    assert.equal(status.active, false);
    assert.equal(status.checkpoint, null);
    assert.deepEqual(status.baselines, { azure: null, trmnl: null });
    assert.deepEqual(status.activation.target_results, { azure: "verified", trmnl: "verified" });
    assert.deepEqual(status.pending_reconciliation, { azure: false, trmnl: false });
    assert.equal(status.activation.recovery_confirmation_required, false);
    assert.deepEqual(status.activation.first_failure, original.activation.first_failure);
    services.publishAndVerifyTrmnl = async () => assert.fail("TRMNL was durably verified before completion failed");
    services.prepareTrmnlActivationRepair = async () => assert.fail("Reuse the persisted corrected archive");
    assert.equal((await operation(options)).status, "succeeded");
    const recovered = await listReleaseStatus({ ledger });
    assert.equal(recovered.active, true);
    assert.equal(recovered.checkpoint, options.commit);
    assert.deepEqual(recovered.baselines, {
      azure: options.commit, trmnl: mode === "repair" ? options.correctedCommit : options.commit
    });
    assert.deepEqual((await ledger.read()).activation.artifact, original.activation.artifact);
  });
}

test("classification selects only affected production targets and defaults unknown paths to both", () => {
  assert.deepEqual(classifyPaths(["src/CalendarAgenda/AgendaFunction.cs"]), ["azure"]);
  assert.deepEqual(classifyPaths(["display/src/views/standard.liquid"]), ["trmnl"]);
  assert.deepEqual(classifyPaths(["docs/agenda-contract.md"]), ["azure", "trmnl"]);
  assert.deepEqual(classifyPaths(["scripts/publish-trmnl.mjs"]), ["azure", "trmnl"]);
  assert.deepEqual(classifyPaths(["tests/CalendarAgenda.Tests/AgendaHttpTests.cs"]), ["azure"]);
  assert.deepEqual(classifyPaths(["display/workbench/preview.mjs", "README.md"]), []);
  assert.deepEqual(classifyPaths(["scripts/agenda-workbench.mjs", "display/render.rb"]), []);
  assert.deepEqual(classifyPaths(["display/timing.rb"]), []);
  assert.deepEqual(classifyPaths(["scripts/setup-display.ps1", "scripts/display-toolchain.ps1"]), []);
  for (const script of [
    "azure-cli.ps1", "deploy-azure.ps1", "deploy-release-infrastructure.ps1",
    "package-function.ps1", "prune-deployment-packages.ps1", "smoke-delivery.mjs"
  ]) assert.deepEqual(classifyPaths([`scripts/${script}`]), ["azure"]);
  for (const script of ["new-unclassified-helper.mjs", "new-unclassified-helper.ps1", "git-environment.mjs"]) {
    assert.deepEqual(classifyPaths([`scripts/${script}`]), ["azure", "trmnl"]);
  }
  assert.deepEqual(classifyPaths(["new-and-unclassified/file.txt"]), ["azure", "trmnl"]);
});

for (const target of ["azure", "trmnl"]) {
  test(`recovery preserves a verified ${target} outcome after its success save`, async () => {
    const ledger = await activatedLedger();
    await admitMainCommits({
      ledger, commits: [{
        commit: commit("b"), parent: commit("a"), paths: ["docs/agenda-contract.md"]
      }], through: commit("b"), isAncestor: async () => false
    });
    const abort = new AbortController();
    const withExclusive = ledger.withExclusive;
    const write = ledger.write;
    ledger.withExclusive = operation => withExclusive(() => operation(abort.signal));
    ledger.write = async state => {
      await write(state);
      if (state.queue[0].target_results?.[target] === "verified") {
        abort.abort(new Error("runner_stopped_after_success_save"));
      }
    };
    const mutations = [];
    let preparations = 0;
    const services = {
      async changedPaths(base, head) { return base === head ? [] : ["docs/agenda-contract.md"]; },
      async prepare(head, targets) {
        preparations += 1;
        return releaseArtifact(head, Object.fromEntries(targets.map(name => [name, `${name}/${head}`])));
      },
      async deployAndVerifyAzure() { mutations.push("azure"); return { verified: true }; },
      async publishAndVerifyTrmnl() { mutations.push("trmnl"); return { verified: true }; },
      async verifyArtifact() { return true; }
    };
    await assert.rejects(runNextRelease({ ledger, services }), {
      message: "runner_stopped_after_success_save"
    });
    ledger.withExclusive = withExclusive;
    ledger.write = write;
    const persisted = await ledger.read();
    assert.equal(persisted.queue[0].status, "running");
    assert.equal(persisted.queue[0].attempts.at(-1).stage, `${target}_deploy`);
    assert.equal(persisted.queue[0].target_results[target], "verified");
    assert.equal(persisted.baselines[target], commit("b"));
    assert.equal(persisted.pending_reconciliation[target], false);
    await recoverInterruptedRelease({ ledger });
    const recovered = await listReleaseStatus({ ledger });
    assert.equal(recovered.queue[0].target_results[target], "verified");
    assert.equal(recovered.pending_reconciliation[target], false);
    assert.equal(recovered.queue[0].recovery_confirmation_required, false);
    await retryFailedRelease({
      ledger, services, actor: "owner", reason: "Resume after persisted target verification"
    });
    assert.equal((await runNextRelease({ ledger, services })).status, "succeeded");
    assert.deepEqual(mutations, ["azure", "trmnl"]);
    assert.equal(preparations, 1);
    assert.deepEqual((await listReleaseStatus({ ledger })).baselines, {
      azure: commit("b"), trmnl: commit("b")
    });
  });
}

for (const target of ["azure", "trmnl"]) {
  test(`skipping an unverified ${target} mutation forces reconciliation even when the next commit reverts`, async () => {
    const ledger = await activatedLedger();
    const path = target === "azure" ? "src/CalendarAgenda/AgendaFunction.cs" : "display/src/full.liquid";
    await admitMainCommits({
      ledger, commits: [
        { commit: commit("b"), parent: commit("a"), paths: [path] },
        { commit: commit("c"), parent: commit("b"), paths: [path] }
      ], through: commit("c"), isAncestor: async () => false
    });
    const mutations = [];
    const mutate = async head => {
      mutations.push(head);
      return { verified: head === commit("c") };
    };
    const services = {
      async changedPaths(_base, head) { return head === commit("b") ? [path] : []; },
      async prepare(head, targets) {
        assert.deepEqual(targets, [target]);
        return releaseArtifact(head, { [target]: `${target}/${head}` });
      },
      deployAndVerifyAzure: mutate,
      publishAndVerifyTrmnl: mutate
    };
    assert.equal((await runNextRelease({ ledger, services })).status, "failed");
    assert.equal((await listReleaseStatus({ ledger })).pending_reconciliation[target], true);
    await skipFailedRelease({
      ledger, actor: "owner", reason: "Previous mutation stopped; skip failed verification",
      previousMutationStopped: true
    });
    assert.equal((await listReleaseStatus({ ledger })).baselines[target], commit("a"));
    assert.equal((await listReleaseStatus({ ledger })).pending_reconciliation[target], true);
    const legacy = await ledger.read();
    delete legacy.pending_reconciliation;
    await ledger.replace(legacy);
    assert.equal((await listReleaseStatus({ ledger })).pending_reconciliation[target], true);
    assert.deepEqual(await runNextRelease({ ledger, services }), {
      started: true, release: commit("c"), targets: [target], status: "succeeded"
    });
    assert.deepEqual(mutations, [commit("b"), commit("c")]);
    assert.equal((await listReleaseStatus({ ledger })).pending_reconciliation[target], false);
    assert.equal((await listReleaseStatus({ ledger })).baselines[target], commit("c"));
  });
}

test("target selection uses only the corresponding target baseline after alternating commits", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger,
    commits: [
      { commit: commit("b"), parent: commit("a"), paths: ["display/src/full.liquid"] },
      { commit: commit("c"), parent: commit("b"), paths: ["src/CalendarAgenda/AgendaFunction.cs"] }
    ],
    through: commit("c"),
    isAncestor: async () => false
  });
  const deployed = [];
  const services = {
    async changedPaths(base, head) {
      if (head === commit("b")) return ["display/src/full.liquid"];
      return base === commit("a")
        ? ["display/src/full.liquid", "src/CalendarAgenda/AgendaFunction.cs"]
        : ["src/CalendarAgenda/AgendaFunction.cs"];
    },
    async prepare(head, targets) {
      return releaseArtifact(head, Object.fromEntries(targets.map(target => [target, `${target}/${head}`])));
    },
    async deployAndVerifyAzure(head) { deployed.push(["azure", head]); return { verified: true }; },
    async publishAndVerifyTrmnl(head) { deployed.push(["trmnl", head]); return { verified: true }; }
  };
  assert.deepEqual((await runNextRelease({ ledger, services })).targets, ["trmnl"]);
  assert.deepEqual((await runNextRelease({ ledger, services })).targets, ["azure"]);
  assert.deepEqual(deployed, [["trmnl", commit("b")], ["azure", commit("c")]]);
});

for (const stage of ["selection", "prepare"]) {
  test(`artifact-free ${stage} failure can be retried before any deployment`, async () => {
    const ledger = await activatedLedger();
    await admitMainCommits({
      ledger, commits: [{
        commit: commit("b"), parent: commit("a"), paths: ["src/CalendarAgenda/AgendaFunction.cs"]
      }], through: commit("b"), isAncestor: async () => false
    });
    let fail = true;
    let deployments = 0;
    const services = {
      async changedPaths() {
        if (fail && stage === "selection") throw Object.assign(new Error(), { code: "selection_failed" });
        return ["src/CalendarAgenda/AgendaFunction.cs"];
      },
      async prepare(head) {
        assert.equal((await ledger.read()).queue[0].attempts.at(-1).stage, "prepare");
        if (fail && stage === "prepare") throw Object.assign(new Error(), { code: "prepare_failed" });
        return releaseArtifact(head);
      },
      async deployAndVerifyAzure() { deployments += 1; return { verified: true }; }
    };
    const failure = await runNextRelease({ ledger, services });
    assert.equal(failure.stage, stage);
    assert.equal(deployments, 0);
    assert.equal((await ledger.read()).queue[0].artifact, null);
    await retryFailedRelease({ ledger, actor: "owner", reason: "Retry before deployment", services });
    assert.equal((await ledger.read()).queue[0].status, "queued");
    fail = false;
    assert.equal((await runNextRelease({ ledger, services })).status, "succeeded");
    assert.equal(deployments, 1);
  });
}

test("activation requires Azure bootstrap and explicit backup recovery acceptance", async () => {
  for (const approval of [
    { azureBootstrapVerified: true },
    { azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: false },
    { azureBootstrapVerified: false, trmnlBackupRecoveryAccepted: true },
    { azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: "true" }
  ]) {
    const ledger = memoryLedger();
    await assert.rejects(activateReleaseBaseline({
      ledger, commit: commit("a"), actor: "owner", reason: "initial release",
      ...approval, services: {}
    }), { message: "activation_evidence_required" });
    assert.equal(await ledger.read(), null);
  }
});

test("initial activation deploys both targets in order and only then sets the baseline", async () => {
  const ledger = memoryLedger();
  const stages = [];
  const services = {
    async prepare(head, targets) {
      assert.equal(head, commit("b"));
      assert.deepEqual(targets, ["azure", "trmnl"]);
      return releaseArtifact(head, { azure: `azure/${head}`, trmnl: `trmnl/${head}` });
    },
    async deployAndVerifyAzure() {
      stages.push("azure");
      return { verified: true };
    },
    async publishAndVerifyTrmnl() {
      assert.deepEqual(stages, ["azure"]);
      stages.push("trmnl");
      return { verified: true };
    }
  };
  const result = await activateReleaseBaseline({
    ledger, commit: commit("b"), actor: "owner", reason: "Private backup saved; accept manual recovery",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true, services
  });
  assert.deepEqual(result, {
    active: true, baseline: commit("b"), targets: ["azure", "trmnl"], status: "succeeded",
    trmnl_backup_recovery_accepted: true
  });
  assert.deepEqual(stages, ["azure", "trmnl"]);
  const activation = (await ledger.read()).activation;
  assert.equal(activation.actor, "owner");
  assert.equal(activation.reason, "Private backup saved; accept manual recovery");
  assert.equal(activation.trmnl_backup_recovery_accepted, true);
  const status = await listReleaseStatus({ ledger });
  assert.equal(status.activation.trmnl_backup_recovery_accepted, true);
  assert.deepEqual(status.baselines, {
    azure: commit("b"), trmnl: commit("b")
  });
});

test("legacy activation status does not invent backup approval and rejects invalid acceptance", async () => {
  const ledger = await activatedLedger();
  const state = await ledger.read();
  assert.equal(state.activation.trmnl_backup_recovery_accepted, true);
  delete state.activation.trmnl_backup_recovery_accepted;
  await ledger.replace(state);
  assert.equal((await listReleaseStatus({ ledger })).activation.trmnl_backup_recovery_accepted, null);
  for (const invalid of ["true", false]) {
    state.activation.trmnl_backup_recovery_accepted = invalid;
    await ledger.replace(state);
    await assert.rejects(listReleaseStatus({ ledger }), { message: "ledger_invalid" });
  }
});

test("activation failure is visible in status without exposing its detailed diagnostics", async () => {
  const ledger = memoryLedger();
  const result = await activateReleaseBaseline({
    ledger,
    commit: commit("b"),
    actor: "owner",
    reason: "initial baseline",
    azureBootstrapVerified: true,
    trmnlBackupRecoveryAccepted: true,
    services: {
      async prepare(head, targets) {
        return releaseArtifact(head, Object.fromEntries(targets.map(target =>
          [target, `${target}/${head}`])));
      },
      async deployAndVerifyAzure() {
        throw Object.assign(new Error("private diagnostic"), { code: "azure_verification_failed" });
      },
      async publishAndVerifyTrmnl() {
        assert.fail("TRMNL publication must wait for Azure verification");
      }
    }
  });
  assert.equal(result.blocked, true);
  const status = await listReleaseStatus({ ledger });
  assert.equal(status.activation.status, "failed");
  assert.equal(status.activation.failure.code, "azure_verification_failed");
  assert.doesNotMatch(JSON.stringify(status), /private diagnostic|initial baseline/);
});

test("activation retains its first interruption after successful explicit recovery", async () => {
  const ledger = memoryLedger();
  const abort = new AbortController();
  const withExclusive = ledger.withExclusive;
  ledger.withExclusive = operation => withExclusive(() => operation(abort.signal));
  const options = {
    ledger, commit: commit("b"), actor: "owner", reason: "Initial activation",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true,
    services: {
      async prepare(head, targets) {
        return releaseArtifact(head, Object.fromEntries(targets.map(target => [target, `${target}/${head}`])));
      },
      async deployAndVerifyAzure() {
        abort.abort(new Error("runner_stopped"));
        throw abort.signal.reason;
      }
    }
  };
  options.services.publishAndVerifyTrmnl = async () => ({ verified: true });
  await assert.rejects(activateReleaseBaseline(options), { message: "runner_stopped" });
  ledger.withExclusive = withExclusive;
  assert.equal((await ledger.read()).activation.status, "running");
  assert.equal((await activateReleaseBaseline(options)).code, "interrupted_uncertain");
  const failure = { stage: "azure_deploy", code: "interrupted_uncertain" };
  assert.deepEqual((await ledger.read()).activation.first_failure, failure);
  options.services.deployAndVerifyAzure = async () => ({ verified: true });
  options.services.verifyArtifact = async () => true;
  const recovered = await activateReleaseBaseline({
    ...options, reason: "Confirmed interrupted mutation stopped", previousMutationStopped: true
  });
  assert.equal(recovered.status, "succeeded");
  const activation = (await ledger.read()).activation;
  assert.equal(activation.failure, null);
  assert.deepEqual(activation.first_failure, failure);
});

test("main admission is FIFO, idempotent, and excludes known non-production commits", async () => {
  const ledger = await activatedLedger();
  const commits = [
    { commit: commit("b"), parent: commit("a"), paths: ["display/workbench/preview.mjs"] },
    { commit: commit("c"), parent: commit("b"), paths: ["src/CalendarAgenda/AgendaFunction.cs"] },
    { commit: commit("d"), parent: commit("c"), paths: ["display/src/views/standard.liquid"] },
    { commit: commit("e"), parent: commit("d"), paths: ["unclassified/change"] }
  ];
  const first = await admitMainCommits({
    ledger, commits, through: commit("e"), isAncestor: async () => false
  });
  assert.deepEqual(first.admitted, [commit("c"), commit("d"), commit("e")]);
  const duplicate = await admitMainCommits({
    ledger, commits, through: commit("e"), isAncestor: async () => false
  });
  assert.deepEqual(duplicate.admitted, []);
  const status = await listReleaseStatus({ ledger });
  assert.deepEqual(status.queue.map(release => release.commit), [commit("c"), commit("d"), commit("e")]);
  assert.ok(status.queue.every(release => release.status === "queued"));
});

test("combined release deploys and verifies Azure before TRMNL, then advances both baselines", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger,
    commits: [{
      commit: commit("b"), parent: commit("a"),
      paths: ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"]
    }],
    through: commit("b"), isAncestor: async () => false
  });
  const stages = [];
  const services = {
    async changedPaths(base, head) {
      assert.equal(base, commit("a"));
      assert.equal(head, commit("b"));
      return ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"];
    },
    async prepare(head, targets) {
      return releaseArtifact(head, Object.fromEntries(targets.map(target =>
        [target, `${target}/${head}`])));
    },
    async deployAndVerifyAzure() {
      stages.push("azure");
      return { verified: true };
    },
    async publishAndVerifyTrmnl() {
      assert.deepEqual(stages, ["azure"]);
      stages.push("trmnl");
      return { verified: true };
    }
  };
  assert.deepEqual(await runNextRelease({ ledger, services }), {
    started: true, release: commit("b"), targets: ["azure", "trmnl"], status: "succeeded"
  });
  assert.deepEqual(stages, ["azure", "trmnl"]);
  assert.deepEqual((await listReleaseStatus({ ledger })).baselines, {
    azure: commit("b"), trmnl: commit("b")
  });
});

test("Azure failure blocks TRMNL and successors; retry keeps the original commit and artifact", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger,
    commits: [
      {
        commit: commit("b"), parent: commit("a"),
        paths: ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"]
      },
      { commit: commit("c"), parent: commit("b"), paths: ["display/src/views/standard.liquid"] }
    ],
    through: commit("c"), isAncestor: async () => false
  });
  const stages = [];
  let retry = false;
  let firstArtifact;
  const services = {
    async changedPaths(base) {
      return base === commit("a")
        ? ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"]
        : ["display/src/views/standard.liquid"];
    },
    async prepare(head) {
      firstArtifact ??= releaseArtifact(head, { azure: `packages/${head}.zip`, trmnl: `plugins/${head}` });
      return firstArtifact;
    },
    async deployAndVerifyAzure(head, artifact) {
      assert.equal(head, commit("b"));
      assert.equal(artifact.identity, firstArtifact.identity);
      stages.push("azure");
      if (!retry) throw Object.assign(new Error("secret-bearing diagnostic"), { code: "azure_verification_failed" });
      return { verified: true };
    },
    async publishAndVerifyTrmnl(head, artifact) {
      assert.equal(head, commit("b"));
      assert.equal(artifact.identity, firstArtifact.identity);
      stages.push("trmnl");
      return { verified: true };
    },
    async verifyArtifact(artifact, head) {
      return artifact.identity === firstArtifact.identity && head === commit("b");
    }
  };
  const failed = await runNextRelease({ ledger, services });
  assert.equal(failed.status, "failed");
  assert.equal(failed.started, true);
  assert.deepEqual(failed.targets, ["azure", "trmnl"]);
  assert.equal(failed.code, "azure_verification_failed");
  assert.deepEqual(stages, ["azure"]);
  assert.doesNotMatch(JSON.stringify(await ledger.read()), /secret-bearing diagnostic/);
  assert.deepEqual(await runNextRelease({ ledger, services }), {
    started: false, blocked_by: commit("b"), status: "failed"
  });
  await assert.rejects(retryFailedRelease({
    ledger, actor: "maintainer", reason: "Retry exact release", services
  }), { message: "previous_mutation_stop_confirmation_required" });
  await retryFailedRelease({
    ledger, actor: "maintainer", reason: "Retry exact release after confirming completion",
    services, previousMutationStopped: true
  });
  retry = true;
  assert.equal((await runNextRelease({ ledger, services })).status, "succeeded");
  assert.deepEqual(stages, ["azure", "azure", "trmnl"]);
  assert.equal((await listReleaseStatus({ ledger })).queue[1].status, "queued");
});

test("partial TRMNL failure preserves Azure success and skip does not advance target baselines", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger,
    commits: [{
      commit: commit("b"), parent: commit("a"),
      paths: ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"]
    }],
    through: commit("b"), isAncestor: async () => false
  });
  const services = {
    async changedPaths() {
      return ["src/CalendarAgenda/AgendaFunction.cs", "display/src/settings.yml"];
    },
    async prepare(head) {
      return releaseArtifact(head, { azure: `packages/${head}.zip`, trmnl: `plugins/${head}` });
    },
    async deployAndVerifyAzure() {
      return { verified: true };
    },
    async publishAndVerifyTrmnl() {
      throw Object.assign(new Error("private response"), { code: "trmnl_verification_failed" });
    }
  };
  const failed = await runNextRelease({ ledger, services });
  assert.equal(failed.stage, "trmnl_deploy");
  assert.deepEqual((await listReleaseStatus({ ledger })).baselines, {
    azure: commit("b"), trmnl: commit("a")
  });
  assert.deepEqual((await listReleaseStatus({ ledger })).queue[0].target_results, {
    azure: "verified", trmnl: "failed"
  });
  await assert.rejects(skipFailedRelease({
    ledger, actor: "owner", reason: "Explicitly bypass blocked TRMNL deployment"
  }), { message: "previous_mutation_stop_confirmation_required" });
  await skipFailedRelease({
    ledger, actor: "owner", reason: "Confirmed publication stopped before bypassing",
    previousMutationStopped: true
  });
  const status = await listReleaseStatus({ ledger });
  assert.equal(status.queue[0].status, "skipped");
  assert.deepEqual(status.baselines, { azure: commit("b"), trmnl: commit("a") });
});

test("interrupted active work becomes an uncertain failure barrier, never presumed success", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger,
    commits: [{
      commit: commit("b"), parent: commit("a"), paths: ["src/CalendarAgenda/AgendaFunction.cs"]
    }],
    through: commit("b"), isAncestor: async () => false
  });
  const state = await ledger.read();
  state.queue[0].status = "running";
  state.queue[0].attempts.push({ stage: "azure_deploy", result: "running" });
  await ledger.replace(state);
  assert.deepEqual(await recoverInterruptedRelease({ ledger }), {
    recovered: true, release: commit("b"), blocked: true
  });
  assert.equal((await listReleaseStatus({ ledger })).queue[0].first_failure.code, "interrupted_uncertain");
  assert.equal((await listReleaseStatus({ ledger })).queue[0].target_results.azure, "uncertain");
  assert.equal((await listReleaseStatus({ ledger })).queue[0].recovery_confirmation_required, true);
  assert.deepEqual((await runNextRelease({ ledger, services: {} })).status, "failed");
  await assert.rejects(retryFailedRelease({
    ledger, actor: "owner", reason: "Retry an interrupted release", services: {}
  }), { message: "previous_mutation_stop_confirmation_required" });
  await assert.rejects(skipFailedRelease({
    ledger, actor: "owner", reason: "Skip an interrupted release"
  }), { message: "previous_mutation_stop_confirmation_required" });
});

test("lease cancellation reaches the active deployment and preserves a durable recovery barrier", async () => {
  const ledger = await activatedLedger();
  await admitMainCommits({
    ledger, commits: [{
      commit: commit("b"), parent: commit("a"), paths: ["docs/agenda-contract.md"]
    }], through: commit("b"), isAncestor: async () => false
  });
  const abort = new AbortController();
  const withExclusive = ledger.withExclusive;
  ledger.withExclusive = operation => withExclusive(() => operation(abort.signal));
  const services = {
    async changedPaths() { return ["docs/agenda-contract.md"]; },
    async prepare(head, targets) {
      return releaseArtifact(head, Object.fromEntries(targets.map(target => [target, `${target}/${head}`])));
    },
    async deployAndVerifyAzure(_head, _artifact, { signal }) {
      assert.equal(signal, abort.signal);
      assert.equal((await ledger.read()).queue[0].recovery_confirmation_required, true);
      const completed = new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      abort.abort(Object.assign(new Error("storage_lease_lost"), { code: "storage_lease_lost" }));
      return completed;
    },
    async publishAndVerifyTrmnl() { assert.fail("Cancelled releases cannot publish TRMNL"); },
    async verifyArtifact() { return true; }
  };
  await assert.rejects(runNextRelease({ ledger, services }), { message: "storage_lease_lost" });
  ledger.withExclusive = withExclusive;
  assert.equal((await ledger.read()).queue[0].status, "running");
  await recoverInterruptedRelease({ ledger });
  await assert.rejects(retryFailedRelease({
    ledger, services, actor: "owner", reason: "Retry without stop evidence"
  }), { message: "previous_mutation_stop_confirmation_required" });
  await retryFailedRelease({
    ledger, services, actor: "owner", reason: "Verified previous processes and remote mutations stopped",
    previousMutationStopped: true
  });
  const release = (await ledger.read()).queue[0];
  assert.equal(release.status, "queued");
  assert.equal(release.retry.previous_mutation_stopped, true);
});
