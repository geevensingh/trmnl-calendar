import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  activateReleaseBaseline,
  admitMainCommits,
  listReleaseStatus,
  recoverInterruptedRelease,
  repairActivationTrmnl,
  retryFailedRelease,
  runNextRelease,
  skipFailedRelease
} from "./release-controller.mjs";
import { isGitAncestor, mainCommitsAfter } from "./git-release-history.mjs";
import { AzureBlobLedger } from "./azure-blob-ledger.mjs";
import { createReleaseServices } from "./release-services.mjs";

const execFileAsync = promisify(execFile);

function gitEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

export async function runReleaseBatch({ ledger, services, cwd, through }) {
  let status = await listReleaseStatus({ ledger });
  if (!status.active || !status.checkpoint) throw new Error("release_system_not_activated");
  const commits = await mainCommitsAfter(cwd, status.checkpoint, through);
  const admission = await admitMainCommits({
    ledger,
    commits,
    through,
    isAncestor: (ancestor, descendant) => isGitAncestor(cwd, ancestor, descendant)
  });
  const recovery = await recoverInterruptedRelease({ ledger });
  const releases = [];
  if (recovery.recovered) {
    return {
      admission: { checkpoint: admission.checkpoint, admitted: admission.admitted.length },
      recovery,
      releases,
      blocked: true
    };
  }

  while (true) {
    const outcome = await runNextRelease({
      ledger, services,
      isAncestor: (ancestor, descendant) => isGitAncestor(cwd, ancestor, descendant)
    });
    if (!outcome.started) {
      if (outcome.blocked_by) {
        return {
          admission: { checkpoint: admission.checkpoint, admitted: admission.admitted.length },
          recovery,
          releases,
          blocked: true
        };
      }
      break;
    }
    releases.push({
      commit: outcome.release,
      status: outcome.status,
      targets: outcome.targets ?? [],
      ...(outcome.status === "failed" ? {
        stage: outcome.stage,
        code: outcome.code
      } : {})
    });
    if (outcome.status !== "succeeded") break;
  }
  status = await listReleaseStatus({ ledger });
  return {
    admission: { checkpoint: status.checkpoint, admitted: admission.admitted.length },
    recovery,
    releases,
    blocked: status.queue.some(release => release.status === "failed" || release.status === "running")
  };
}

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: gitEnvironment(),
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim();
  } catch {
    throw new Error("git_release_history_failed");
  }
}

export async function activateFromMain({ ledger, services, cwd, through, ...options }) {
  const status = await listReleaseStatus({ ledger });
  const commit = status.activation?.commit ?? through;
  if (!status.activation) {
    const main = await runGit(cwd, ["rev-parse", "refs/remotes/origin/main"]);
    if (main !== through) throw new Error("activation_commit_must_be_current_main");
  } else if (!(await isGitAncestor(cwd, commit, through))) {
    throw new Error("activation_commit_not_on_main");
  }
  return activateReleaseBaseline({ ...options, ledger, services, commit });
}

export async function repairActivationTrmnlFromMain({
  ledger, services, cwd, through, commit, correctedCommit, ...options
}) {
  const status = await listReleaseStatus({ ledger });
  if (!status.activation || status.activation.commit !== commit) {
    throw new Error("activation_commit_conflict");
  }
  if (status.activation.trmnl_repair) {
    if (status.activation.trmnl_repair.commit !== correctedCommit) {
      throw new Error("activation_repair_commit_conflict");
    }
  } else {
    const main = await runGit(cwd, ["rev-parse", "refs/remotes/origin/main"]);
    if (main !== through || correctedCommit !== through) {
      throw new Error("repair_commit_must_be_current_main");
    }
  }
  const history = await mainCommitsAfter(cwd, commit, through);
  if (!history.some(item => item.commit === correctedCommit)) {
    throw new Error("repair_commit_not_on_main");
  }
  return repairActivationTrmnl({
    ...options, ledger, services, commit, correctedCommit
  });
}

export async function inspectTrmnlFromMain({ ledger, services, cwd, through }) {
  const status = await listReleaseStatus({ ledger });
  const blocked = status.queue.find(release => ["failed", "running"].includes(release.status));
  let commit = status.active ? blocked?.commit ?? through :
    status.activation?.trmnl_repair?.commit ?? status.activation?.commit ?? through;
  const repairCommit = status.activation?.trmnl_repair?.commit;
  if (status.active && blocked && repairCommit && status.baselines.trmnl === repairCommit &&
    await isGitAncestor(cwd, blocked.commit, repairCommit)) {
    commit = repairCommit;
  }
  if (!(await isGitAncestor(cwd, commit, through))) throw new Error("inspection_commit_not_on_main");
  return { commit, ...await services.inspectTrmnl(commit) };
}

async function runCli() {
  const { values } = parseArgs({
    options: {
      operation: { type: "string", default: "main" },
      reason: { type: "string", default: "" },
      "activation-commit": { type: "string", default: process.env.ACTIVATION_COMMIT ?? "" },
      "corrected-commit": { type: "string", default: process.env.CORRECTED_COMMIT ?? "" },
      "previous-mutation-stopped": {
        type: "boolean", default: process.env.PREVIOUS_MUTATION_STOPPED === "true"
      }
    }
  });
  const operation = values.operation;
  if (!["main", "status", "inspect-trmnl", "activate", "repair-activation-trmnl", "retry", "skip"].includes(operation)) {
    throw new Error("release_operation_invalid");
  }
  if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("main_only_release_operation");
  const through = process.env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(through ?? "")) throw new Error("invalid_commit");
  const cwd = process.cwd();
  const ledger = new AzureBlobLedger({
    account: process.env.AZURE_STORAGE_ACCOUNT,
    container: process.env.AZURE_RELEASE_CONTAINER
  });
  if (operation === "status") return listReleaseStatus({ ledger });

  const services = createReleaseServices({ repository: cwd });
  if (operation === "inspect-trmnl") {
    return inspectTrmnlFromMain({ ledger, services, cwd, through });
  }
  const previousMutationStopped = values["previous-mutation-stopped"];
  if (operation === "activate" || operation === "repair-activation-trmnl") {
    const activate = operation === "activate" ? activateFromMain : repairActivationTrmnlFromMain;
    return activate({
      ledger,
      cwd,
      through,
      ...(operation === "repair-activation-trmnl" ? {
        commit: values["activation-commit"], correctedCommit: values["corrected-commit"]
      } : {}),
      actor: process.env.GITHUB_ACTOR ?? "",
      reason: values.reason,
      azureBootstrapVerified: process.env.AZURE_BOOTSTRAP_VERIFIED === "true",
      trmnlBackupRecoveryAccepted: Boolean(process.env.TRMNL_PLUGIN_ID) &&
        process.env.TRMNL_BACKUP_RECOVERY_ACCEPTED_PLUGIN_ID === process.env.TRMNL_PLUGIN_ID,
      previousMutationStopped,
      services
    });
  }
  if (operation === "retry" || operation === "skip") {
    const recovery = await recoverInterruptedRelease({ ledger });
    if (recovery.recovered) {
      return { blocked: true, recovery, releases: [] };
    }
    if (operation === "retry") {
      await retryFailedRelease({
        ledger,
        actor: process.env.GITHUB_ACTOR ?? "",
        reason: values.reason,
        previousMutationStopped,
        services
      });
    } else {
      await skipFailedRelease({
        ledger,
        actor: process.env.GITHUB_ACTOR ?? "",
        reason: values.reason,
        previousMutationStopped
      });
    }
  }
  return runReleaseBatch({ ledger, services, cwd, through });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runCli();
    console.log(JSON.stringify(result));
    if (result?.blocked || result?.status === "failed") process.exitCode = 1;
  } catch (error) {
    const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : typeof error?.message === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.message)
        ? error.message
        : "release_operation_failed";
    console.error(JSON.stringify({ status: "failed", code }));
    process.exitCode = 1;
  }
}
