import { createHash } from "node:crypto";

const TARGETS = Object.freeze(["azure", "trmnl"]);
const SHA_PATTERN = /^[a-f0-9]{40}$/;

const targetSets = {
  azure: new Set(["azure"]),
  trmnl: new Set(["trmnl"]),
  both: new Set(TARGETS),
  none: new Set()
};

function changedTargets(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (
    normalized === "docs/agenda-contract.md" ||
    normalized === "scripts/agenda-contract.mjs" ||
    normalized === "scripts/azure-blob-ledger.mjs" ||
    normalized === "scripts/git-release-history.mjs" ||
    normalized === "scripts/publish-trmnl.mjs" ||
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith("scripts/release-")
  ) return targetSets.both;
  if (
    normalized.startsWith("src/") ||
    normalized.startsWith("infra/") ||
    normalized.startsWith("tests/CalendarAgenda.Tests/") ||
    normalized.startsWith("scripts/") ||
    normalized === "global.json" ||
    normalized === "NuGet.Config" ||
    normalized === "nuget.config"
  ) return targetSets.azure;
  if (normalized.startsWith("display/src/")) return targetSets.trmnl;
  if (
    normalized.startsWith("display/scenarios/") ||
    normalized.startsWith("display/workbench/") ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith(".agents/") ||
    normalized === "README.md" ||
    normalized === "GLOSSARY.md" ||
    normalized === "Gemfile" ||
    normalized === "Gemfile.lock" ||
    normalized === "skills-lock.json"
  ) return targetSets.none;
  return targetSets.both;
}

export function classifyPaths(paths) {
  const selected = new Set();
  for (const path of paths) {
    for (const target of changedTargets(path)) selected.add(target);
  }
  return TARGETS.filter(target => selected.has(target));
}

export function releaseId(commit) {
  if (!SHA_PATTERN.test(commit)) throw new Error("invalid_commit");
  return createHash("sha256").update(`trmnl-calendar-release:${commit}`).digest("hex");
}

export function artifactIdentity(commit, references, digests, metadata = {}) {
  const canonical = JSON.stringify({
    commit,
    references: Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b))),
    digests: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b))),
    metadata
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertCommit(commit) {
  if (!SHA_PATTERN.test(commit)) throw new Error("invalid_commit");
}

function assertAttribution(actor, reason) {
  if (
    typeof actor !== "string" || !actor.trim() || actor.length > 100 ||
    typeof reason !== "string" || !reason.trim() || reason.length > 500
  ) throw new Error("attribution_required");
}

function assertArtifact(artifact, commit) {
  if (
    !artifact ||
    Object.keys(artifact).some(key =>
      !["commit", "identity", "references", "digests", "metadata"].includes(key)) ||
    artifact.commit !== commit ||
    !artifact.references ||
    Object.keys(artifact.references).some(target => !TARGETS.includes(target)) ||
    Object.values(artifact.references).some(reference =>
      typeof reference !== "string" ||
      !/^[A-Za-z0-9._/-]+$/.test(reference) ||
      reference.includes("..")) ||
    !artifact.digests ||
    Object.keys(artifact.digests).length !== Object.keys(artifact.references).length ||
    Object.entries(artifact.references).some(([target]) =>
      !/^[a-f0-9]{64}$/.test(artifact.digests[target] ?? "")) ||
    !artifact.metadata ||
    Object.keys(artifact.metadata).some(key => key !== "azure_manifest") ||
    (artifact.metadata.azure_manifest !== undefined && (
      artifact.metadata.azure_manifest.commit !== commit ||
      artifact.metadata.azure_manifest.framework !== "net10.0" ||
      artifact.metadata.azure_manifest.working_tree_clean !== true ||
      artifact.metadata.azure_manifest.archive_sha256 !== artifact.digests.azure ||
      !Number.isSafeInteger(artifact.metadata.azure_manifest.archive_bytes) ||
      artifact.metadata.azure_manifest.archive_bytes < 1
    )) ||
    artifact.identity !== artifactIdentity(commit, artifact.references, artifact.digests, artifact.metadata)
  ) throw new Error("artifact_identity_invalid");
  return artifact;
}

function newState() {
  return {
    schema_version: 1,
    active: false,
    checkpoint: null,
    baselines: { azure: null, trmnl: null },
    queue: [],
    updated_at: null
  };
}

function validateState(state) {
  if (
    state?.schema_version !== 1 ||
    typeof state.active !== "boolean" ||
    !Array.isArray(state.queue) ||
    !state.baselines ||
    !("azure" in state.baselines) ||
    !("trmnl" in state.baselines)
  ) throw new Error("ledger_invalid");
  if (state.checkpoint !== null) assertCommit(state.checkpoint);
  for (const target of TARGETS) {
    if (state.baselines[target] !== null) assertCommit(state.baselines[target]);
  }
  const seen = new Set();
  for (const release of state.queue) {
    assertCommit(release.commit);
    if (seen.has(release.commit)) throw new Error("ledger_duplicate_release");
    seen.add(release.commit);
    if (!["queued", "running", "failed", "succeeded", "skipped"].includes(release.status)) {
      throw new Error("ledger_invalid");
    }
    if (release.artifact !== null) assertArtifact(release.artifact, release.commit);
  }
  return state;
}

async function mutate(ledger, action) {
  return ledger.withExclusive(async () => {
    const raw = await ledger.read();
    const state = validateState(raw ?? newState());
    const result = await action(state);
    state.updated_at = new Date().toISOString();
    await ledger.write(state);
    return result;
  });
}

export async function activateReleaseBaseline({
  ledger,
  commit,
  actor,
  reason,
  azureBootstrapVerified,
  trmnlPreservationVerified,
  services
}) {
  assertCommit(commit);
  assertAttribution(actor, reason);
  if (
    azureBootstrapVerified !== true ||
    trmnlPreservationVerified !== true
  ) throw new Error("activation_evidence_required");
  return ledger.withExclusive(async () => {
    const state = validateState((await ledger.read()) ?? newState());
    if (state.active || state.checkpoint !== null || state.queue.length !== 0) {
      throw new Error("already_initialized");
    }
    if (state.activation?.status === "running") {
      state.activation.status = "failed";
      state.activation.failure = {
        stage: state.activation.stage ?? "unknown",
        code: "interrupted_uncertain"
      };
      state.activation.target_results ??= {};
      for (const target of TARGETS) {
        if (state.activation.target_results[target] === "in_progress") {
          state.activation.target_results[target] = "uncertain";
        }
      }
      await ledger.write(state);
      return { active: false, status: "failed", blocked: true, code: "interrupted_uncertain" };
    }
    if (state.activation && state.activation.commit !== commit) {
      throw new Error("activation_commit_conflict");
    }
    if (!state.activation) {
      state.activation = {
        commit,
        actor: actor.trim(),
        reason: reason.trim(),
        status: "running",
        stage: "prepare",
        target_results: { azure: "pending", trmnl: "pending" },
        artifact: null,
        first_failure: null
      };
    } else {
      state.activation.status = "running";
      state.activation.actor = actor.trim();
      state.activation.reason = reason.trim();
    }
    const activation = state.activation;
    const save = async () => {
      state.updated_at = new Date().toISOString();
      await ledger.write(state);
    };
    await save();
    try {
      if (!services?.prepare || !services?.deployAndVerifyAzure || !services?.publishAndVerifyTrmnl) {
        throw Object.assign(new Error(), { code: "release_services_unavailable" });
      }
      if (!activation.artifact) {
        activation.artifact = assertArtifact(await services.prepare(commit, [...TARGETS]), commit);
      } else if (typeof services.verifyArtifact !== "function" ||
        !(await services.verifyArtifact(activation.artifact, commit))) {
        throw Object.assign(new Error(), { code: "recovery_artifact_unavailable" });
      }
      if (TARGETS.some(target => !activation.artifact.references[target] ||
        !activation.artifact.digests[target])) {
        throw Object.assign(new Error(), { code: "artifact_identity_invalid" });
      }
      for (const target of TARGETS) {
        if (activation.target_results[target] === "verified") continue;
        activation.target_results[target] = "in_progress";
        activation.stage = `${target}_deploy`;
        await save();
        const outcome = target === "azure"
          ? await services.deployAndVerifyAzure(commit, activation.artifact)
          : await services.publishAndVerifyTrmnl(commit, activation.artifact);
        if (outcome?.verified !== true) {
          throw Object.assign(new Error(), { code: `${target}_verification_failed` });
        }
        activation.target_results[target] = "verified";
        await save();
      }
      activation.status = "succeeded";
      activation.stage = "complete";
      state.active = true;
      state.checkpoint = commit;
      state.baselines = { azure: commit, trmnl: commit };
      await save();
      return { active: true, baseline: commit, targets: [...TARGETS], status: "succeeded" };
    } catch (error) {
      activation.status = "failed";
      activation.failure ??= {
        stage: activation.stage,
        code: safeFailure(error)
      };
      activation.first_failure ??= activation.failure;
      const target = activation.stage.split("_")[0];
      if (TARGETS.includes(target) && activation.target_results[target] === "in_progress") {
        activation.target_results[target] = "failed";
      }
      await save();
      return {
        active: false,
        status: "failed",
        blocked: true,
        stage: activation.failure.stage,
        code: activation.failure.code
      };
    }
  });
}

export async function admitMainCommits({ ledger, commits, through, isAncestor }) {
  assertCommit(through);
  if (
    !Array.isArray(commits) ||
    commits.some(item => !SHA_PATTERN.test(item?.commit) || !SHA_PATTERN.test(item?.parent) ||
      !Array.isArray(item.paths) || item.paths.some(path => typeof path !== "string"))
  ) {
    throw new Error("invalid_commit_batch");
  }
  if (typeof isAncestor !== "function") throw new Error("git_ancestry_check_required");
  return mutate(ledger, async state => {
    if (!state.active) throw new Error("release_system_not_activated");
    if (state.checkpoint === through || await isAncestor(through, state.checkpoint)) {
      return { admitted: [], checkpoint: state.checkpoint, pending: state.queue.filter(item =>
        item.status === "queued" || item.status === "running" || item.status === "failed"
      ).length };
    }
    const existing = new Set(state.queue.map(item => item.commit));
    const admitted = [];
    const checkpointIndex = commits.findIndex(item => item.commit === state.checkpoint);
    const remaining = checkpointIndex >= 0
      ? commits.slice(checkpointIndex + 1)
      : commits;
    if (remaining[0]?.parent !== state.checkpoint) throw new Error("main_history_gap");
    let expectedParent = state.checkpoint;
    for (const { commit, parent, paths } of remaining) {
      if (parent !== expectedParent) throw new Error("main_history_gap");
      expectedParent = commit;
      if (!existing.has(commit) && classifyPaths(paths).length > 0) {
        state.queue.push({
          id: releaseId(commit),
          commit,
          status: "queued",
          attempts: [],
          artifact: null,
          first_failure: null
        });
        existing.add(commit);
        admitted.push(commit);
      }
    }
    if (expectedParent !== through) throw new Error("main_history_gap");
    state.checkpoint = through;
    return { admitted, checkpoint: through, pending: state.queue.filter(item =>
      item.status === "queued" || item.status === "running" || item.status === "failed"
    ).length };
  });
}

export async function recoverInterruptedRelease({ ledger }) {
  return mutate(ledger, state => {
    const running = state.queue.find(item => item.status === "running");
    if (!running) return { recovered: false };
    const attempt = running.attempts.at(-1);
    const failure = { stage: attempt?.stage ?? "unknown", code: "interrupted_uncertain" };
    running.status = "failed";
    running.first_failure ??= failure;
    if (attempt) {
      attempt.result = "failed";
      attempt.failure = failure;
    }
    const target = attempt?.stage?.split("_")[0];
    if (TARGETS.includes(target)) {
      running.target_results ??= {};
      running.target_results[target] = "uncertain";
    }
    return { recovered: true, release: running.commit, blocked: true };
  });
}

export async function retryFailedRelease({ ledger, actor, reason, services }) {
  assertAttribution(actor, reason);
  return mutate(ledger, async state => {
    const release = state.queue.find(item => item.status === "failed");
    if (!release) throw new Error("no_failed_release");
    if (release.artifact) {
      if (typeof services?.verifyArtifact !== "function" ||
        !(await services.verifyArtifact(release.artifact, release.commit))) {
        throw new Error("recovery_artifact_unavailable");
      }
    } else if (release.first_failure?.stage !== "prepare") {
      throw new Error("recovery_artifact_unavailable");
    }
    release.status = "queued";
    release.retry = {
      actor: actor.trim(),
      reason: reason.trim(),
      at: new Date().toISOString()
    };
    return { release: release.commit, retried: true };
  });
}

export async function skipFailedRelease({ ledger, actor, reason }) {
  assertAttribution(actor, reason);
  return mutate(ledger, state => {
    const release = state.queue.find(item => item.status === "failed");
    if (!release) throw new Error("no_failed_release");
    release.status = "skipped";
    release.skip = { actor: actor.trim(), reason: reason.trim(), at: new Date().toISOString() };
    return { release: release.commit, skipped: true, baselines: { ...state.baselines } };
  });
}

function safeFailure(error) {
  const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "release_stage_failed";
  return code;
}

export async function runNextRelease({ ledger, services }) {
  return ledger.withExclusive(async () => {
    const state = validateState((await ledger.read()) ?? newState());
    const barrier = state.queue.find(item => ["running", "failed"].includes(item.status));
    if (barrier) return { started: false, blocked_by: barrier.commit, status: barrier.status };
    const release = state.queue.find(item => item.status === "queued");
    if (!release) return { started: false, reason: "queue_empty" };
    if (typeof services?.changedPaths !== "function" || typeof services?.prepare !== "function") {
      throw new Error("release_services_unavailable");
    }
    release.status = "running";
    release.attempts.push({ started_at: new Date().toISOString(), stage: "selection", result: "running" });
    const attempt = release.attempts.at(-1);
    const save = async () => {
      state.updated_at = new Date().toISOString();
      await ledger.write(state);
    };
    await save();

    try {
      const paths = [];
      for (const target of TARGETS) {
        const baseline = state.baselines[target];
        if (baseline === null) throw Object.assign(new Error(), { code: "target_baseline_missing" });
        paths.push(...await services.changedPaths(baseline, release.commit));
      }
      const targets = classifyPaths(paths);
      release.targets = targets;
      release.target_results ??= {};
      for (const target of targets) release.target_results[target] ??= "pending";
      if (targets.length === 0) {
        attempt.stage = "selection";
        attempt.result = "succeeded";
        release.status = "succeeded";
        release.targets = [];
        await save();
        return { started: true, release: release.commit, targets, status: "succeeded" };
      }
      attempt.targets = targets;
      attempt.stage = "prepare";
      if (!release.artifact) {
        const artifact = await services.prepare(release.commit, targets);
        release.artifact = assertArtifact(artifact, release.commit);
      }
      if (targets.some(target => !release.artifact.references[target] ||
        !release.artifact.digests[target])) {
        throw Object.assign(new Error(), { code: "artifact_identity_invalid" });
      }
      await save();
      for (const target of TARGETS) {
        if (!targets.includes(target) || state.baselines[target] === release.commit) continue;
        release.target_results[target] = "in_progress";
        attempt.stage = `${target}_deploy`;
        await save();
        const outcome = target === "azure"
          ? await services.deployAndVerifyAzure(release.commit, release.artifact)
          : await services.publishAndVerifyTrmnl(release.commit, release.artifact);
        if (outcome?.verified !== true) {
          throw Object.assign(new Error(), { code: `${target}_verification_failed` });
        }
        state.baselines[target] = release.commit;
        release.target_results[target] = "verified";
        attempt[`${target}_verified`] = true;
        await save();
      }
      attempt.stage = "complete";
      attempt.result = "succeeded";
      release.targets = targets;
      release.status = "succeeded";
      await save();
      return { started: true, release: release.commit, targets, status: "succeeded" };
    } catch (error) {
      const failure = { stage: attempt.stage, code: safeFailure(error) };
      release.status = "failed";
      release.first_failure ??= failure;
      const target = attempt.stage.split("_")[0];
      if (TARGETS.includes(target) && release.target_results?.[target] === "in_progress") {
        release.target_results[target] = "failed";
      }
      attempt.result = "failed";
      attempt.failure = failure;
      await save();
      return {
        release: release.commit,
        status: "failed",
        blocked: true,
        stage: failure.stage,
        code: failure.code
      };
    }
  });
}

export async function listReleaseStatus({ ledger }) {
  return ledger.withExclusive(async () => {
    const state = validateState((await ledger.read()) ?? newState());
    return {
      active: state.active,
      checkpoint: state.checkpoint,
      baselines: { ...state.baselines },
      activation: state.activation ? {
        commit: state.activation.commit,
        status: state.activation.status,
        stage: state.activation.stage,
        target_results: { ...state.activation.target_results },
        failure: state.activation.failure ?? null
      } : null,
      queue: state.queue.map(({ id, commit, status, targets, target_results, first_failure, skip }) => ({
        id, commit, status, targets: targets ?? null,
        target_results: target_results ?? {},
        first_failure: first_failure ?? null,
        skip: skip ? { actor: skip.actor, at: skip.at } : null
      }))
    };
  });
}
