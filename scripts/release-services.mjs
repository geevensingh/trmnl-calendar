import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  AzureBlobArtifacts
} from "./azure-blob-ledger.mjs";
import { artifactIdentity } from "./release-controller.mjs";
import { publishTrmnl } from "./publish-trmnl.mjs";

const execFileAsync = promisify(execFile);
const maximumArtifactBytes = 100 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const expectedPluginFiles = new Set([
  "settings.yml", "shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"
]);

function reject(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function limitedEnvironment(extra = {}) {
  const output = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "LC_ALL",
    "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "DOTNET_ROOT", "DOTNET_CLI_HOME",
    "NUGET_PACKAGES", "DOTNET_GENERATE_ASPNET_CERTIFICATE", "SystemRoot"
  ]) {
    if (process.env[key] !== undefined) output[key] = process.env[key];
  }
  return { ...output, ...extra };
}

async function run(command, args, {
  cwd, env = limitedEnvironment(), code = "release_tool_failed", signal
} = {}) {
  signal?.throwIfAborted();
  try {
    return await execFileAsync(command, args, {
      cwd,
      env,
      signal,
      encoding: "utf8",
      windowsHide: true,
      timeout: 20 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch {
    reject(code);
  }
}

async function withCommitCheckout(repository, commit, action, signal) {
  if (!shaPattern.test(commit)) reject("invalid_commit");
  const temporary = await mkdtemp(join(tmpdir(), "calendar-release-checkout-"));
  const checkout = join(temporary, "source");
  let added = false;
  try {
    await run("git", ["-C", repository, "worktree", "add", "--detach", checkout, commit], {
      env: limitedEnvironment(),
      signal,
      code: "release_checkout_failed"
    });
    added = true;
    return await action(checkout);
  } finally {
    try {
      if (added) {
        await run("git", ["-C", repository, "worktree", "remove", "--force", checkout], {
          env: limitedEnvironment(),
          code: "release_checkout_cleanup_failed"
        });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function withParametersFile(parametersJson, action) {
  let parameters;
  try {
    parameters = JSON.parse(parametersJson);
  } catch {
    reject("azure_runtime_configuration_invalid");
  }
  if (!parameters || typeof parameters !== "object" ||
    !parameters.parameters || typeof parameters.parameters !== "object" ||
    typeof parameters.parameters.resourceGroupName?.value !== "string" ||
    typeof parameters.parameters.releaseControllerPrincipalId?.value !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(parameters.parameters.releaseControllerPrincipalId.value)) {
    reject("azure_runtime_configuration_invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "calendar-release-parameters-"));
  const path = join(directory, `${randomUUID()}.json`);
  try {
    await writeFile(path, JSON.stringify(parameters), { flag: "wx", mode: 0o600 });
    return await action(path, parameters);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function readRequiredEnv(name, pattern, code) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) reject(code);
  return value;
}

async function githubApi(path, method, payload, token, signal) {
  signal?.throwIfAborted();
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const repository = readRequiredEnv("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "github_deployment_record_failed");
  if (!token || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._/-]*)?$/.test(api) ||
    api.includes("..")) {
    reject("github_deployment_record_failed");
  }
  let response;
  try {
    response = await fetch(`${api}/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    });
  } catch {
    reject("github_deployment_record_failed");
  }
  if (!response.ok) reject("github_deployment_record_failed");
  try {
    return await response.json();
  } catch {
    reject("github_deployment_record_failed");
  }
}

async function withDeploymentRecord(target, commit, action, signal) {
  const token = process.env.GITHUB_TOKEN;
  const environment = `production-${target}`;
  const deployment = await githubApi("/deployments", "POST", {
    ref: commit,
    task: "deploy",
    auto_merge: false,
    required_contexts: [],
    environment,
    description: `Release ${target} for ${commit}`,
    production_environment: true
  }, token, signal);
  if (!Number.isSafeInteger(deployment.id)) reject("github_deployment_record_failed");
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl = `${server}/${repo}/actions/runs/${runId}`;
  const update = async (state, description, updateSignal = signal) => {
    await githubApi(`/deployments/${deployment.id}/statuses`, "POST", {
      state,
      description,
      log_url: runUrl,
      environment
    }, token, updateSignal);
  };
  await update("in_progress", `Deploying ${target} for ${commit}`);
  try {
    const result = await action();
    await update("success", `Verified ${target} for ${commit}`);
    return result;
  } catch (error) {
    await update("failure", `Failed ${target} for ${commit}`, null);
    throw error;
  }
}

function makeArtifact(commit, references, digests, metadata = {}) {
  return {
    commit,
    references,
    digests,
    metadata,
    identity: artifactIdentity(commit, references, digests, metadata)
  };
}

export async function createTrmnlArchive(source, output, { signal } = {}) {
  const entries = await readdir(source, { withFileTypes: true });
  const paths = entries.map(entry => entry.name).sort();
  if (paths.length !== expectedPluginFiles.size ||
    paths.some(path => !expectedPluginFiles.has(path)) ||
    entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) reject("trmnl_source_invalid");
  const archive = resolve(output);
  const archiveDirectory = dirname(archive);
  await mkdir(archiveDirectory, { recursive: true });
  await run("tar", [
    "--format=ustar", "-cf", `./${basename(archive)}`, "-C", resolve(source), ...paths
  ], {
    cwd: archiveDirectory,
    env: limitedEnvironment(),
    signal,
    code: "trmnl_artifact_prepare_failed"
  });
  const bytes = await readFile(archive);
  if (bytes.length === 0 || bytes.length > maximumArtifactBytes) reject("artifact_size_invalid");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function unpackTrmnlArchive(archive, destination, { signal } = {}) {
  const archivePath = resolve(archive);
  const archiveName = `./${basename(archivePath)}`;
  const archiveDirectory = dirname(archivePath);
  const listing = await run("tar", ["-tf", archiveName], {
    cwd: archiveDirectory,
    env: limitedEnvironment(),
    signal,
    code: "trmnl_artifact_invalid"
  });
  const paths = listing.stdout.split(/\r?\n/).filter(Boolean)
    .map(path => path.replace(/^\.\//, ""))
    .filter(path => path && path !== ".");
  if (paths.length !== expectedPluginFiles.size ||
    paths.some(path => !expectedPluginFiles.has(path)) ||
    new Set(paths).size !== expectedPluginFiles.size) reject("trmnl_artifact_invalid");
  const destinationDirectory = resolve(destination);
  await mkdir(destinationDirectory, { recursive: true });
  // GNU tar unquotes -C paths; a local input also avoids drive-qualified archive names.
  const extraction = await mkdtemp(join(destinationDirectory, ".trmnl-archive-"));
  try {
    await copyFile(archivePath, join(extraction, "source.tar"));
    await run("tar", ["-xf", `./${basename(extraction)}/source.tar`], {
      cwd: destinationDirectory,
      env: limitedEnvironment(),
      signal,
      code: "trmnl_artifact_invalid"
    });
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

export function createReleaseServices({ repository = process.cwd() } = {}) {
  const account = readRequiredEnv("AZURE_STORAGE_ACCOUNT", /^[a-z0-9]{3,24}$/, "azure_release_configuration_invalid");
  const container = readRequiredEnv("AZURE_RELEASE_CONTAINER", /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/, "azure_release_configuration_invalid");
  const artifactContainer = readRequiredEnv(
    "AZURE_ARTIFACT_CONTAINER",
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/,
    "azure_release_configuration_invalid"
  );
  const artifactStore = new AzureBlobArtifacts({ account, container: artifactContainer });

  return {
    async changedPaths(from, to, { signal } = {}) {
      const result = await run("git", [
        "-C", repository, "diff", "--no-renames", "--name-only", "-z", from, to
      ], {
        env: limitedEnvironment(),
        signal,
        code: "release_git_diff_failed"
      });
      return result.stdout.split("\0").filter(Boolean);
    },

    async prepare(commit, targets, { signal } = {}) {
      return withCommitCheckout(repository, commit, async checkout => {
        const references = {};
        const digests = {};
        const metadata = {};
        if (targets.includes("azure")) {
          const outputDirectory = join(checkout, "artifacts", "packages");
          const packaged = await run("pwsh", [
            "-NoProfile", "-NonInteractive", "-File", join(checkout, "scripts", "package-function.ps1"),
            "-OutputDirectory", outputDirectory
          ], { cwd: checkout, env: limitedEnvironment(), code: "azure_package_failed", signal });
          let result;
          try {
            result = JSON.parse(packaged.stdout);
          } catch {
            reject("azure_package_failed");
          }
          const archive = await readFile(result.archive);
          const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
          if (
            manifest.commit !== commit ||
            manifest.working_tree_clean !== true ||
            manifest.framework !== "net10.0" ||
            manifest.archive_sha256 !== createHash("sha256").update(archive).digest("hex") ||
            manifest.archive_bytes !== archive.length
          ) reject("azure_package_identity_invalid");
          const archiveDigest = createHash("sha256").update(archive).digest("hex");
          const reference = `releases/${commit}/azure-${archiveDigest}.zip`;
          const upload = await artifactStore.put(reference, archive, { signal });
          references.azure = upload.reference;
          digests.azure = upload.sha256;
          metadata.azure_manifest = manifest;
        }
        if (targets.includes("trmnl")) {
          const bundle = await createTrmnlArchive(join(checkout, "display", "src"),
            join(checkout, "artifacts", `trmnl-${commit}.tar`), { signal });
          const reference = `releases/${commit}/trmnl-${bundle.sha256}.tar`;
          const upload = await artifactStore.put(reference, bundle.bytes, { signal });
          references.trmnl = upload.reference;
          digests.trmnl = upload.sha256;
        }
        return makeArtifact(commit, references, digests, metadata);
      }, signal);
    },

    async verifyArtifact(artifact, commit, { signal } = {}) {
      if (artifact.commit !== commit) return false;
      for (const target of Object.keys(artifact.references)) {
        const stored = await artifactStore.get(artifact.references[target], { signal });
        if (stored.sha256 !== artifact.digests[target]) return false;
        if (target === "azure" && stored.bytes.length !== artifact.metadata.azure_manifest.archive_bytes) {
          return false;
        }
      }
      return true;
    },

    async deployAndVerifyAzure(commit, artifact, { signal } = {}) {
      return withDeploymentRecord("azure", commit, async () => {
        const stored = await artifactStore.get(artifact.references.azure, { signal });
        const manifest = artifact.metadata.azure_manifest;
        if (
          stored.sha256 !== artifact.digests.azure ||
          manifest.commit !== commit ||
          manifest.archive_sha256 !== stored.sha256 ||
          manifest.archive_bytes !== stored.bytes.length
        ) reject("azure_artifact_unavailable");
        const subscription = readRequiredEnv("AZURE_SUBSCRIPTION_ID",
          /^[0-9a-f-]{36}$/i, "azure_release_configuration_invalid");
        const approvedGroup = readRequiredEnv("AZURE_RESOURCE_GROUP_NAME",
          /^[A-Za-z0-9_.()-]{1,90}$/, "azure_release_configuration_invalid");
        const parametersJson = process.env.AZURE_PARAMETERS_JSON;
        const functionKey = process.env.TRMNL_FUNCTION_KEY;
        if (!functionKey) reject("azure_release_configuration_invalid");
        return withParametersFile(parametersJson, async (parametersPath, parameters) => {
          if (
            parameters.parameters.resourceGroupName.value !== approvedGroup ||
            parameters.parameters.releaseStorageAccountName?.value !== account ||
            parameters.parameters.storageAccountName?.value === account ||
            parameters.parameters.releaseControlContainerName?.value !== container ||
            parameters.parameters.releaseArtifactContainerName?.value !== artifactContainer
          ) {
            reject("azure_runtime_target_mismatch");
          }
          return withCommitCheckout(repository, commit, async checkout => {
            const infra = await run("pwsh", [
              "-NoProfile", "-NonInteractive", "-File",
              join(checkout, "scripts", "deploy-release-infrastructure.ps1"),
              "-SubscriptionId", subscription,
              "-ApprovedResourceGroupName", approvedGroup,
              "-ParametersFile", parametersPath,
              "-ReviewedMainCommit", commit
            ], { cwd: checkout, env: limitedEnvironment(), code: "azure_infrastructure_failed", signal });
            let capacity;
            try {
              capacity = JSON.parse(infra.stdout);
            } catch {
              reject("azure_infrastructure_failed");
            }
            if (capacity.status !== "reconciled" || capacity.commit !== commit ||
              !capacity.scaleAndConcurrency) reject("azure_infrastructure_failed");

            const packageDirectory = join(checkout, "artifacts", "recovered-package");
            await mkdir(packageDirectory, { recursive: true });
            const packagePath = join(packageDirectory, `calendar-${commit}.zip`);
            await writeFile(packagePath, stored.bytes, { flag: "wx", mode: 0o600 });
            const manifestPath = join(packageDirectory, "manifest.json");
            await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
            const deployed = await run("pwsh", [
              "-NoProfile", "-NonInteractive", "-File", join(checkout, "scripts", "deploy-azure.ps1"),
              "-Mode", "DeployCode", "-ApprovedResourcePlan",
              "-SubscriptionId", subscription,
              "-ParametersFile", parametersPath,
              "-PackageFile", packagePath,
              "-ReviewedIntegrationCommit", commit,
              "-ReviewedCapacityJson", JSON.stringify(capacity)
            ], {
              cwd: checkout,
              env: limitedEnvironment({ TRMNL_FUNCTION_KEY: functionKey }),
              signal,
              code: "azure_deployment_or_verification_failed"
            });
            if (!deployed.stdout.includes("redacted current-agenda/authentication smoke checks passed")) {
              reject("azure_deployment_or_verification_failed");
            }
            return { verified: true };
          }, signal);
        });
      }, signal);
    },

    async publishAndVerifyTrmnl(commit, artifact, { signal } = {}) {
      return withDeploymentRecord("trmnl", commit, async () => {
        const stored = await artifactStore.get(artifact.references.trmnl, { signal });
        if (stored.sha256 !== artifact.digests.trmnl) reject("trmnl_artifact_unavailable");
        const directory = await mkdtemp(join(tmpdir(), "calendar-trmnl-release-"));
        const archive = join(directory, "source.tar");
        const source = join(directory, "src");
        try {
          await writeFile(archive, stored.bytes, { flag: "wx", mode: 0o600 });
          await unpackTrmnlArchive(archive, source, { signal });
          const result = await publishTrmnl({
            sourceDirectory: source,
            pluginId: process.env.TRMNL_PLUGIN_ID,
            backupRecoveryAcceptedPluginId: process.env.TRMNL_BACKUP_RECOVERY_ACCEPTED_PLUGIN_ID,
            apiKey: process.env.TRMNL_API_KEY,
            signal
          });
          return { verified: result.verified };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }, signal);
    }
  };
}
