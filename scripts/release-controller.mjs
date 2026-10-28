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
    normalized === "scripts/agenda-workbench.mjs" ||
    normalized === "scripts/setup-display.ps1" ||
    normalized === "scripts/display-toolchain.ps1" ||
    normalized === "display/render.rb"
  ) return targetSets.none;
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
    normalized === "scripts/azure-cli.ps1" ||
    normalized === "scripts/deploy-azure.ps1" ||
    normalized === "scripts/deploy-release-infrastructure.ps1" ||
    normalized === "scripts/package-function.ps1" ||
    normalized === "scripts/prune-deployment-packages.ps1" ||
    normalized === "scripts/smoke-delivery.mjs" ||
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
    pending_reconciliation: { azure: false, trmnl: false },
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
  if (state.pending_reconciliation === undefined) {
    state.pending_reconciliation = { azure: false, trmnl: false };
    for (const release of state.queue) {
      for (const attempt of release.attempts) {
        for (const target of TARGETS) {
          if (attempt[`${target}_verified`] === true) state.pending_reconciliation[target] = false;
          else if (attempt.stage === `${target}_deploy`) state.pending_reconciliation[target] = true;
        }
      }
      for (const target of TARGETS) {
        const result = release.target_results?.[target];
        if (result === "verified") state.pending_reconciliation[target] = false;
        if (["in_progress", "uncertain", "failed"].includes(result)) {
          state.pending_reconciliation[target] = true;
        }
      }
    }
  }
  if (!state.pending_reconciliation || typeof state.pending_reconciliation !== "object" ||
    Array.isArray(state.pending_reconciliation) ||
    Object.keys(state.pending_reconciliation).some(target => !TARGETS.includes(target)) ||
    TARGETS.some(target => typeof state.pending_reconciliation[target] !== "boolean")) {
    throw new Error("ledger_invalid");
  }
  return state;
}

async function mutate(ledger, action) {
  return ledger.withExclusive(async signal => {
    const raw = await ledger.read();
    const state = validateState(raw ?? newState());
    const result = await action(state, signal);
    signal?.throwIfAborted();
    state.updated_at = new Date().toISOString();
    await ledger.write(state);
    return result;
  });
}

function requiresRecoveryConfirmation(entry) {
  return entry.recovery_confirmation_required === true ||
    Object.values(entry.target_results ?? {}).some(result =>
      ["in_progress", "uncertain", "failed"].includes(result));
}

function confirmRecovery(entry, previousMutationStopped) {
  if (requiresRecoveryConfirmation(entry) && previousMutationStopped !== true) {
    throw new Error("previous_mutation_stop_confirmation_required");
  }
  entry.recovery_confirmation_required = false;
  for (const [target, result] of Object.entries(entry.target_results ?? {})) {
    if (["in_progress", "uncertain", "failed"].includes(result)) entry.target_results[target] = "pending";
  }
}

export async function activateReleaseBaseline({
  ledger,
  commit,
  actor,
  reason,
  azureBootstrapVerified,
  trmnlPreservationVerified,
  previousMutationStopped = false,
  services
}) {
  assertCommit(commit);
  assertAttribution(actor, reason);
  if (
    azureBootstrapVerified !== true ||
    trmnlPreservationVerified !== true
  ) throw new Error("activation_evidence_required");
  return ledger.withExclusive(async signal => {
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
      state.activation.first_failure ??= state.activation.failure;
      state.activation.target_results ??= {};
      for (const target of TARGETS) {
        if (state.activation.target_results[target] === "in_progress") {
          state.activation.target_results[target] = "uncertain";
          state.pending_reconciliation[target] = true;
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
      confirmRecovery(state.activation, previousMutationStopped);
      state.activation.recovery = {
        actor: actor.trim(), reason: reason.trim(),
        previous_mutation_stopped: previousMutationStopped,
        at: new Date().toISOString()
      };
      state.activation.status = "running";
      state.activation.failure = null;
      state.activation.actor = actor.trim();
      state.activation.reason = reason.trim();
    }
    const activation = state.activation;
    const save = async () => {
      signal?.throwIfAborted();
      state.updated_at = new Date().toISOString();
      await ledger.write(state);
    };
    await save();
    try {
      if (!services?.prepare || !services?.deployAndVerifyAzure || !services?.publishAndVerifyTrmnl) {
        throw Object.assign(new Error(), { code: "release_services_unavailable" });
      }
      if (!activation.artifact) {
        activation.artifact = assertArtifact(await services.prepare(commit, [...TARGETS], { signal }), commit);
      } else if (typeof services.verifyArtifact !== "function" ||
        !(await services.verifyArtifact(activation.artifact, commit, { signal }))) {
        throw Object.assign(new Error(), { code: "recovery_artifact_unavailable" });
      }
      if (TARGETS.some(target => !activation.artifact.references[target] ||
        !activation.artifact.digests[target])) {
        throw Object.assign(new Error(), { code: "artifact_identity_invalid" });
      }
      for (const target of TARGETS) {
        if (activation.target_results[target] === "verified") continue;
        activation.target_results[target] = "in_progress";
        activation.recovery_confirmation_required = true;
        state.pending_reconciliation[target] = true;
        activation.stage = `${target}_deploy`;
        await save();
        const outcome = target === "azure"
          ? await services.deployAndVerifyAzure(commit, activation.artifact, { signal })
          : await services.publishAndVerifyTrmnl(commit, activation.artifact, { signal });
        signal?.throwIfAborted();
        if (outcome?.verified !== true) {
          throw Object.assign(new Error(), { code: `${target}_verification_failed` });
        }
        activation.target_results[target] = "verified";
        activation.recovery_confirmation_required = false;
        state.pending_reconciliation[target] = false;
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
      activation.failure = {
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
    if (TARGETS.includes(target) && running.target_results?.[target] !== "verified") {
      running.target_results ??= {};
      running.target_results[target] = "uncertain";
      state.pending_reconciliation[target] = true;
    }
    return { recovered: true, release: running.commit, blocked: true };
  });
}

export async function retryFailedRelease({ ledger, actor, reason, services, previousMutationStopped = false }) {
  assertAttribution(actor, reason);
  return mutate(ledger, async (state, signal) => {
    const release = state.queue.find(item => item.status === "failed");
    if (!release) throw new Error("no_failed_release");
    confirmRecovery(release, previousMutationStopped);
    if (release.artifact) {
      if (typeof services?.verifyArtifact !== "function" ||
        !(await services.verifyArtifact(release.artifact, release.commit, { signal }))) {
        throw new Error("recovery_artifact_unavailable");
      }
    } else if (!["selection", "prepare"].includes(release.first_failure?.stage)) {
      throw new Error("recovery_artifact_unavailable");
    }
    release.status = "queued";
    release.retry = {
      actor: actor.trim(),
      reason: reason.trim(),
      previous_mutation_stopped: previousMutationStopped,
      at: new Date().toISOString()
    };
    return { release: release.commit, retried: true };
  });
}

export async function skipFailedRelease({ ledger, actor, reason, previousMutationStopped = false }) {
  assertAttribution(actor, reason);
  return mutate(ledger, state => {
    const release = state.queue.find(item => item.status === "failed");
    if (!release) throw new Error("no_failed_release");
    confirmRecovery(release, previousMutationStopped);
    release.status = "skipped";
    release.skip = {
      actor: actor.trim(), reason: reason.trim(),
      previous_mutation_stopped: previousMutationStopped, at: new Date().toISOString()
    };
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
  return ledger.withExclusive(async signal => {
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
      signal?.throwIfAborted();
      state.updated_at = new Date().toISOString();
      await ledger.write(state);
    };
    await save();

    try {
      const targets = [];
      for (const target of TARGETS) {
        const baseline = state.baselines[target];
        if (baseline === null) throw Object.assign(new Error(), { code: "target_baseline_missing" });
        const paths = await services.changedPaths(baseline, release.commit, { signal });
        if (state.pending_reconciliation[target] || classifyPaths(paths).includes(target)) targets.push(target);
      }
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
      await save();
      if (!release.artifact) {
        const artifact = await services.prepare(release.commit, targets, { signal });
        release.artifact = assertArtifact(artifact, release.commit);
      }
      if (targets.some(target => !release.artifact.references[target] ||
        !release.artifact.digests[target])) {
        throw Object.assign(new Error(), { code: "artifact_identity_invalid" });
      }
      await save();
      for (const target of TARGETS) {
        if (!targets.includes(target) ||
          (state.baselines[target] === release.commit && !state.pending_reconciliation[target])) continue;
        release.target_results[target] = "in_progress";
        release.recovery_confirmation_required = true;
        state.pending_reconciliation[target] = true;
        attempt.stage = `${target}_deploy`;
        await save();
        const outcome = target === "azure"
          ? await services.deployAndVerifyAzure(release.commit, release.artifact, { signal })
          : await services.publishAndVerifyTrmnl(release.commit, release.artifact, { signal });
        signal?.throwIfAborted();
        if (outcome?.verified !== true) {
          throw Object.assign(new Error(), { code: `${target}_verification_failed` });
        }
        state.baselines[target] = release.commit;
        release.target_results[target] = "verified";
        release.recovery_confirmation_required = false;
        state.pending_reconciliation[target] = false;
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
        started: true,
        release: release.commit,
        targets: release.targets ?? [],
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
      pending_reconciliation: { ...state.pending_reconciliation },
      activation: state.activation ? {
        commit: state.activation.commit,
        status: state.activation.status,
        stage: state.activation.stage,
        target_results: { ...state.activation.target_results },
        recovery_confirmation_required: requiresRecoveryConfirmation(state.activation),
        failure: state.activation.failure ?? null
      } : null,
      queue: state.queue.map(({ id, commit, status, targets, target_results, first_failure, skip,
        recovery_confirmation_required }) => ({
        id, commit, status, targets: targets ?? null,
        target_results: target_results ?? {},
        recovery_confirmation_required: requiresRecoveryConfirmation({ recovery_confirmation_required, target_results }),
        first_failure: first_failure ?? null,
        skip: skip ? { actor: skip.actor, at: skip.at } : null
      }))
    };
  });
}
