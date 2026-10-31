import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  artifactIdentity, activateReleaseBaseline, listReleaseStatus, retryFailedRelease
} from "../../scripts/release-controller.mjs";
import * as runner from "../../scripts/release-runner.mjs";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const { activateFromMain, runReleaseBatch } = runner;
const execFileAsync = promisify(execFile);

function memoryLedger() {
  let state = null;
  let locked = false;
  return {
    async withExclusive(operation) {
      assert.equal(locked, false);
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
    async write(value) {
      state = structuredClone(value);
    }
  };
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: isolatedGitEnvironment({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TEMPLATE_DIR: "",
      GIT_TERMINAL_PROMPT: "0"
    }),
    windowsHide: true
  });
  return stdout.trim();
}

test("release runner admits first-parent main commits and drains their FIFO queue", async () => {
  const repository = await mkdtemp(join(tmpdir(), "calendar-release-runner-test-"));
  try {
    await git(repository, "init", "--quiet", "--initial-branch=main");
    await git(repository, "config", "user.name", "Release test");
    await git(repository, "config", "user.email", "release-test@example.invalid");
    await mkdir(join(repository, "src", "CalendarAgenda"), { recursive: true });
    await writeFile(join(repository, "src", "CalendarAgenda", "AgendaFunction.cs"), "initial");
    await git(repository, "add", ".");
    await git(repository, "commit", "--quiet", "-m", "baseline");
    const baseline = await git(repository, "rev-parse", "HEAD");
    const ledger = memoryLedger();
    const artifactFor = commit => {
      const references = { azure: `packages/${commit}.zip` };
      const digests = { azure: "a".repeat(64) };
      const metadata = {};
      return {
        commit,
        references,
        digests,
        metadata,
        identity: artifactIdentity(commit, references, digests, metadata)
      };
    };
    await activateReleaseBaseline({
      ledger,
      commit: baseline,
      actor: "owner",
      reason: "test activation",
      azureBootstrapVerified: true,
      trmnlBackupRecoveryAccepted: true,
      services: {
        async prepare(commit, targets) {
          return {
            ...artifactFor(commit),
            references: Object.fromEntries(targets.map(target => [target, `${target}/${commit}`])),
            digests: Object.fromEntries(targets.map(target => [target, "a".repeat(64)])),
            identity: artifactIdentity(
              commit,
              Object.fromEntries(targets.map(target => [target, `${target}/${commit}`])),
              Object.fromEntries(targets.map(target => [target, "a".repeat(64)])),
              {}
            )
          };
        },
        async deployAndVerifyAzure() { return { verified: true }; },
        async publishAndVerifyTrmnl() { return { verified: true }; }
      }
    });

    await writeFile(join(repository, "src", "CalendarAgenda", "AgendaFunction.cs"), "released");
    await git(repository, "add", ".");
    await git(repository, "commit", "--quiet", "-m", "change Azure function");
    const through = await git(repository, "rev-parse", "HEAD");
    const deployed = [];
    const services = {
      async changedPaths(from, to) {
        return (await git(repository, "diff", "--name-only", from, to)).split(/\r?\n/).filter(Boolean);
      },
      async prepare(commit, targets) {
        assert.deepEqual(targets, ["azure"]);
        return artifactFor(commit);
      },
      async deployAndVerifyAzure(commit) {
        deployed.push(commit);
        return { verified: true };
      },
      async publishAndVerifyTrmnl() {
        assert.fail("TRMNL must not deploy for an Azure-only change");
      },
      async inspectTrmnl() {
        return {
          operation: "inspect-trmnl", remote_readable: true, field_schema_compatible: true, content_matches: false
        };
      }
    };

    const result = await runReleaseBatch({ ledger, services, cwd: repository, through });
    assert.deepEqual(result.releases, [{
      commit: through, status: "succeeded", targets: ["azure"]
    }]);
    assert.equal(result.blocked, false);
    assert.deepEqual(deployed, [through]);
    assert.equal((await listReleaseStatus({ ledger })).baselines.azure, through);
    assert.equal((await listReleaseStatus({ ledger })).baselines.trmnl, baseline);

    await writeFile(join(repository, "src", "CalendarAgenda", "AgendaFunction.cs"), "failed release");
    await git(repository, "add", ".");
    await git(repository, "commit", "--quiet", "-m", "failing Azure release");
    const failedHead = await git(repository, "rev-parse", "HEAD");
    services.deployAndVerifyAzure = async () => {
      throw Object.assign(new Error("private diagnostic"), { code: "azure_verification_failed" });
    };
    const failed = await runReleaseBatch({ ledger, services, cwd: repository, through: failedHead });
    assert.equal(failed.blocked, true);
    assert.deepEqual(failed.releases, [{
      commit: failedHead, status: "failed", targets: ["azure"],
      stage: "azure_deploy", code: "azure_verification_failed"
    }]);
    assert.doesNotMatch(JSON.stringify(failed), /private diagnostic/);
    const beforeInspection = await ledger.read();
    assert.equal((await runner.inspectTrmnlFromMain({
      ledger, services, cwd: repository, through: failedHead
    })).commit, failedHead);
    assert.deepEqual(await ledger.read(), beforeInspection);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("activation recovery resumes the recorded commit and retained artifacts after main advances", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "calendar-activation-runner-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "--quiet", "--initial-branch=main");
  await git(cwd, "config", "user.name", "Release test");
  await git(cwd, "config", "user.email", "release-test@example.invalid");
  await writeFile(join(cwd, "README.md"), "baseline");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "activation baseline");
  const baseline = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-ref", "refs/remotes/origin/main", baseline);
  const ledger = memoryLedger();
  let prepares = 0;
  let azureDeploys = 0;
  let publications = 0;
  let originalArtifact;
  const services = {
    async prepare(commit, targets) {
      prepares += 1;
      assert.equal(commit, baseline);
      const references = Object.fromEntries(targets.map(target => [target, `${target}/${commit}`]));
      const digests = Object.fromEntries(targets.map(target => [target, "a".repeat(64)]));
      originalArtifact = {
        commit, references, digests, metadata: {},
        identity: artifactIdentity(commit, references, digests, {})
      };
      return originalArtifact;
    },
    async deployAndVerifyAzure() { azureDeploys += 1; return { verified: true }; },
    async publishAndVerifyTrmnl(commit, artifact) {
      publications += 1;
      assert.equal(commit, baseline);
      assert.deepEqual(artifact, originalArtifact);
      if (publications === 1) throw Object.assign(new Error(), { code: "trmnl_verification_failed" });
      return { verified: true };
    },
    async verifyArtifact(artifact, commit) {
      assert.equal(commit, baseline);
      assert.deepEqual(artifact, originalArtifact);
      return true;
    },
    async inspectTrmnl(commit) {
      assert.equal(commit, baseline);
      return {
        operation: "inspect-trmnl", remote_readable: true, field_schema_compatible: true, content_matches: false
      };
    }
  };
  const options = {
    ledger, services, cwd, through: baseline, actor: "owner", reason: "initial activation",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true
  };
  assert.equal((await runner.inspectTrmnlFromMain({
    ledger: memoryLedger(), services, cwd, through: baseline
  })).commit, baseline);
  assert.equal((await activateFromMain(options)).blocked, true);
  await writeFile(join(cwd, "README.md"), "main advanced");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "advance main");
  const through = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-ref", "refs/remotes/origin/main", through);
  const beforeInspection = await ledger.read();
  assert.deepEqual(await runner.inspectTrmnlFromMain({ ledger, services, cwd, through }), {
    operation: "inspect-trmnl", commit: baseline,
    remote_readable: true, field_schema_compatible: true, content_matches: false
  });
  assert.deepEqual(await ledger.read(), beforeInspection);
  assert.equal(azureDeploys, 1);
  assert.equal(publications, 1);
  assert.equal(prepares, 1);
  await assert.rejects(activateFromMain({ ...options, ledger: memoryLedger() }), {
    message: "activation_commit_must_be_current_main"
  });
  await assert.rejects(activateFromMain({ ...options, through }), {
    message: "previous_mutation_stop_confirmation_required"
  });
  const resumed = await activateFromMain({
    ...options, through, previousMutationStopped: true, reason: "Previous publisher stopped; resume baseline"
  });
  assert.equal(resumed.active, true);
  assert.equal(resumed.baseline, baseline);
  assert.equal(prepares, 1);
  assert.equal(azureDeploys, 1);
  assert.equal(publications, 2);
  const state = await ledger.read();
  assert.equal(state.activation.recovery.actor, "owner");
  assert.equal(state.activation.recovery.previous_mutation_stopped, true);
  assert.equal(state.activation.trmnl_backup_recovery_accepted, true);
  assert.equal((await listReleaseStatus({ ledger })).activation.failure, null);
});

test("reviewed activation repair keeps Azure backlog FIFO without replaying older invalid TRMNL archives", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "calendar-repair-runner-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "--quiet", "--initial-branch=main");
  await git(cwd, "config", "user.name", "Release test");
  await git(cwd, "config", "user.email", "release-test@example.invalid");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "display", "src"), { recursive: true });
  await writeFile(join(cwd, "src", "function.cs"), "original backend");
  await writeFile(join(cwd, "display", "src", "settings.yml"), "description: Original invalid description.");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "original activation");
  const original = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-ref", "refs/remotes/origin/main", original);
  const ledger = memoryLedger();
  const deployments = [];
  const publications = [];
  let repairPreparations = 0;
  let repairFails = true;
  const services = {
    async changedPaths(from, to) {
      return (await git(cwd, "diff", "--name-only", from, to)).split(/\r?\n/).filter(Boolean);
    },
    async prepare(commit, targets) {
      const references = Object.fromEntries(targets.map(target => [target, `${target}/${commit}`]));
      const digests = Object.fromEntries(targets.map(target => [target, commit.padEnd(64, "0")]));
      return { commit, references, digests, metadata: {},
        identity: artifactIdentity(commit, references, digests, {}) };
    },
    async prepareTrmnlActivationRepair(_originalArtifact, commit) {
      repairPreparations += 1;
      const artifact = await this.prepare(commit, ["trmnl"]);
      artifact.references.trmnl = `releases/${commit}/trmnl-${artifact.digests.trmnl}.tar`;
      artifact.identity = artifactIdentity(commit, artifact.references, artifact.digests, {});
      return artifact;
    },
    async verifyArtifact() { return true; },
    async deployAndVerifyAzure(commit) { deployments.push(commit); return { verified: true }; },
    async publishAndVerifyTrmnl(commit, artifact) {
      publications.push({ commit, source: artifact.commit });
      if (commit === original) throw Object.assign(new Error(), { code: "trmnl_push_http_422" });
      if (repairFails) throw Object.assign(new Error(), { code: "trmnl_verification_failed" });
      return { verified: true };
    },
    async inspectTrmnl(commit) {
      return { operation: "inspect-trmnl", inspected_commit: commit, content_matches: false };
    }
  };
  const options = {
    ledger, services, cwd, through: original, actor: "owner", reason: "Synthetic baseline",
    azureBootstrapVerified: true, trmnlBackupRecoveryAccepted: true
  };
  assert.equal((await activateFromMain(options)).status, "failed");
  await writeFile(join(cwd, "src", "function.cs"), "unprocessed Azure change");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "Azure successor");
  const azureSuccessor = await git(cwd, "rev-parse", "HEAD");
  await writeFile(join(cwd, "display", "src", "settings.yml"), "description: Private agenda.");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "reviewed correction");
  const corrected = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-ref", "refs/remotes/origin/main", corrected);
  assert.equal(typeof runner.repairActivationTrmnlFromMain, "function");
  const repairOptions = {
    ...options, through: corrected, commit: original, correctedCommit: corrected,
    previousMutationStopped: true, reason: "Reviewed correction; previous publishing stopped"
  };
  const failedBeforeRepair = await ledger.read();
  await assert.rejects(runner.repairActivationTrmnlFromMain({
    ...repairOptions, commit: azureSuccessor
  }), { message: "activation_commit_conflict" });
  await assert.rejects(runner.repairActivationTrmnlFromMain({
    ...repairOptions, correctedCommit: azureSuccessor
  }), { message: "repair_commit_must_be_current_main" });
  assert.deepEqual(await ledger.read(), failedBeforeRepair);
  assert.equal((await runner.repairActivationTrmnlFromMain(repairOptions)).status, "failed");
  assert.equal((await runner.inspectTrmnlFromMain({ ...options, through: corrected })).commit, corrected);
  await assert.rejects(activateFromMain({ ...options, through: corrected, previousMutationStopped: true }), {
    message: "activation_repair_operation_required"
  });
  await writeFile(join(cwd, "README.md"), "main advanced after explicit repair failed");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "docs after repair");
  const through = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "update-ref", "refs/remotes/origin/main", through);
  await assert.rejects(runner.repairActivationTrmnlFromMain({
    ...repairOptions, through, correctedCommit: through
  }), { message: "activation_repair_commit_conflict" });
  repairFails = false;
  const repaired = await runner.repairActivationTrmnlFromMain({ ...repairOptions, through });
  assert.equal(repaired.status, "succeeded");
  assert.equal(repairPreparations, 1, "failed repair retries the retained corrected archive even after main advances");
  const status = await listReleaseStatus({ ledger });
  assert.equal(status.checkpoint, original);
  assert.deepEqual(status.baselines, { azure: original, trmnl: corrected });
  assert.deepEqual(deployments, [original], "repair itself must not deploy the newer Azure");
  const changedPaths = services.changedPaths;
  services.changedPaths = async () => { throw Object.assign(new Error(), { code: "synthetic_selection_failure" }); };
  assert.equal((await runReleaseBatch({ ledger, services, cwd, through })).blocked, true);
  assert.equal((await runner.inspectTrmnlFromMain({ ledger, services, cwd, through })).commit, corrected);
  services.changedPaths = changedPaths;
  await retryFailedRelease({
    ledger, services, actor: "owner", reason: "Retry synthetic selection before any mutation"
  });
  const batch = await runReleaseBatch({ ledger, services, cwd, through });
  assert.equal(batch.blocked, false);
  assert.deepEqual(batch.releases, [
    { commit: azureSuccessor, status: "succeeded", targets: ["azure"] },
    { commit: corrected, status: "succeeded", targets: [] }
  ]);
  assert.deepEqual(deployments, [original, azureSuccessor]);
  assert.deepEqual(publications, [
    { commit: original, source: original },
    { commit: corrected, source: corrected },
    { commit: corrected, source: corrected }
  ]);
  const finalStatus = await listReleaseStatus({ ledger });
  assert.equal(finalStatus.baselines.azure, azureSuccessor);
  assert.equal(finalStatus.baselines.trmnl, corrected);
  assert.deepEqual(finalStatus.queue[0].covered_targets, {
    trmnl: { commit: corrected, artifact_identity: finalStatus.activation.trmnl_repair.artifact.identity }
  });
  await writeFile(join(cwd, "display", "src", "full.liquid"), "later reviewed template");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "--quiet", "-m", "post-repair template");
  const later = await git(cwd, "rev-parse", "HEAD");
  assert.deepEqual((await runReleaseBatch({ ledger, services, cwd, through: later })).releases, [
    { commit: later, status: "succeeded", targets: ["trmnl"] }
  ]);
  assert.equal(publications.at(-1).commit, later);
});
