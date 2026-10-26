import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { artifactIdentity, activateReleaseBaseline, listReleaseStatus } from "../../scripts/release-controller.mjs";
import { runReleaseBatch } from "../../scripts/release-runner.mjs";

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
      trmnlPreservationVerified: true,
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
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
