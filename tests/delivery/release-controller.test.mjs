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
    trmnlPreservationVerified: true,
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

test("classification selects only affected production targets and defaults unknown paths to both", () => {
  assert.deepEqual(classifyPaths(["src/CalendarAgenda/AgendaFunction.cs"]), ["azure"]);
  assert.deepEqual(classifyPaths(["display/src/views/standard.liquid"]), ["trmnl"]);
  assert.deepEqual(classifyPaths(["docs/agenda-contract.md"]), ["azure", "trmnl"]);
  assert.deepEqual(classifyPaths(["scripts/publish-trmnl.mjs"]), ["azure", "trmnl"]);
  assert.deepEqual(classifyPaths(["tests/CalendarAgenda.Tests/AgendaHttpTests.cs"]), ["azure"]);
  assert.deepEqual(classifyPaths(["display/workbench/preview.mjs", "README.md"]), []);
  assert.deepEqual(classifyPaths(["new-and-unclassified/file.txt"]), ["azure", "trmnl"]);
});

test("activation refuses missing bootstrap or synthetic preservation evidence before deploying", async () => {
  const ledger = memoryLedger();
  await assert.rejects(
    activateReleaseBaseline({
      ledger,
      commit: commit("a"),
      actor: "owner",
      reason: "initial release",
      azureBootstrapVerified: false,
      trmnlPreservationVerified: true,
      services: {}
    }),
    { message: "activation_evidence_required" }
  );
  assert.equal(await ledger.read(), null);
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
    ledger, commit: commit("b"), actor: "owner", reason: "initial baseline",
    azureBootstrapVerified: true, trmnlPreservationVerified: true, services
  });
  assert.deepEqual(result, {
    active: true, baseline: commit("b"), targets: ["azure", "trmnl"], status: "succeeded"
  });
  assert.deepEqual(stages, ["azure", "trmnl"]);
  assert.deepEqual((await listReleaseStatus({ ledger })).baselines, {
    azure: commit("b"), trmnl: commit("b")
  });
});

test("activation failure is visible in status without exposing its detailed diagnostics", async () => {
  const ledger = memoryLedger();
  const result = await activateReleaseBaseline({
    ledger,
    commit: commit("b"),
    actor: "owner",
    reason: "initial baseline",
    azureBootstrapVerified: true,
    trmnlPreservationVerified: true,
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
  assert.equal(failed.code, "azure_verification_failed");
  assert.deepEqual(stages, ["azure"]);
  assert.doesNotMatch(JSON.stringify(await ledger.read()), /secret-bearing diagnostic/);
  assert.deepEqual(await runNextRelease({ ledger, services }), {
    started: false, blocked_by: commit("b"), status: "failed"
  });
  await retryFailedRelease({ ledger, actor: "maintainer", reason: "Retry exact release", services });
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
  await skipFailedRelease({ ledger, actor: "owner", reason: "Explicitly bypass blocked TRMNL deployment" });
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
  assert.deepEqual((await runNextRelease({ ledger, services: {} })).status, "failed");
});
