import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createReleaseServices, createTrmnlArchive, unpackTrmnlArchive } from "../../scripts/release-services.mjs";
import { AzureBlobArtifacts } from "../../scripts/azure-blob-ledger.mjs";
import { artifactIdentity } from "../../scripts/release-controller.mjs";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const execFileAsync = promisify(execFile);

const pluginFiles = [
  "settings.yml", "shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"
];

test("activation repair retains the invalid archive and packages only the reviewed corrected TRMNL source", async t => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-trmnl-repair-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "repository");
  const source = join(repository, "display", "src");
  await mkdir(source, { recursive: true });
  const git = async (...args) => (await execFileAsync("git", ["-C", repository, ...args], {
    env: isolatedGitEnvironment({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TEMPLATE_DIR: ""
    })
  })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "core.autocrlf", "false");
  await git("config", "user.name", "Synthetic repair");
  await git("config", "user.email", "repair@example.invalid");
  const settings = "name: Synthetic agenda\ndescription: A deliberately long synthetic description.\nstrategy: polling\n";
  for (const file of pluginFiles) await writeFile(join(source, file), file === "settings.yml" ? settings : `original:${file}`);
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Original invalid description");
  const original = await git("rev-parse", "HEAD");
  const invalid = await createTrmnlArchive(source, join(directory, "original.tar"));
  const originalReference = `releases/${original}/trmnl-${invalid.sha256}.tar`;
  const references = { trmnl: originalReference };
  const digests = { trmnl: invalid.sha256 };
  const originalArtifact = {
    commit: original, references, digests, metadata: {},
    identity: artifactIdentity(original, references, digests, {})
  };
  const stored = new Map([[originalReference, invalid.bytes]]);
  t.mock.method(AzureBlobArtifacts.prototype, "get", async reference => {
    const bytes = stored.get(reference);
    assert.ok(bytes, "only synthetic retained artifacts may be read");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  t.mock.method(AzureBlobArtifacts.prototype, "put", async (reference, bytes) => {
    assert.equal(stored.has(reference), false, "never replace an immutable artifact");
    stored.set(reference, bytes);
    return { reference, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const variables = {
    AZURE_STORAGE_ACCOUNT: "syntheticrepair",
    AZURE_RELEASE_CONTAINER: "release-control",
    AZURE_ARTIFACT_CONTAINER: "release-artifacts"
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const correctedSettings = "name: Synthetic agenda\ndescription: Private agenda.\nstrategy: polling\n";
  await writeFile(join(source, "settings.yml"), correctedSettings);
  await writeFile(join(source, "shared.liquid"), "reviewed template styling");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Correct definition");
  const corrected = await git("rev-parse", "HEAD");
  const services = createReleaseServices({ repository });
  assert.equal(typeof services.prepareTrmnlActivationRepair, "function");
  const repaired = await services.prepareTrmnlActivationRepair(originalArtifact, corrected);
  assert.equal(repaired.commit, corrected);
  assert.deepEqual(Object.keys(repaired.references), ["trmnl"]);
  assert.notEqual(repaired.digests.trmnl, invalid.sha256);
  assert.deepEqual(stored.get(originalReference), invalid.bytes);
  const recovered = join(directory, "recovered");
  await writeFile(join(directory, "corrected.tar"), stored.get(repaired.references.trmnl));
  await unpackTrmnlArchive(join(directory, "corrected.tar"), recovered);
  assert.equal(await readFile(join(recovered, "settings.yml"), "utf8"), correctedSettings);
  assert.equal(await readFile(join(recovered, "shared.liquid"), "utf8"), "reviewed template styling");
  for (const invalid of [
    settings,
    correctedSettings.replace("Private agenda.", "A much longer description than the original invalid description was."),
    correctedSettings.replace("strategy: polling", "strategy: webhook"),
    `${correctedSettings}custom_fields: []\n`,
    `${correctedSettings}description: Duplicate.\n`,
    correctedSettings.replace("Private agenda.", " ")
  ]) {
    await writeFile(join(source, "settings.yml"), invalid);
    await git("add", ".");
    await git("commit", "--quiet", "--allow-empty", "-m", "Unsafe synthetic correction");
    const unsafe = await git("rev-parse", "HEAD");
    await assert.rejects(services.prepareTrmnlActivationRepair(originalArtifact, unsafe), {
      code: "trmnl_repair_description_only_required"
    });
    assert.equal(stored.size, 2, "rejected definitions cannot create replacement artifacts");
  }
  await writeFile(join(source, "settings.yml"), correctedSettings);
  await mkdir(join(repository, "docs"), { recursive: true });
  await writeFile(join(repository, "docs", "agenda-contract.md"), "changed shared contract");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "Unsafe contract change");
  await assert.rejects(services.prepareTrmnlActivationRepair(
    originalArtifact, await git("rev-parse", "HEAD")
  ), { code: "trmnl_repair_contract_changed" });
  await assert.rejects(services.prepareTrmnlActivationRepair({
    ...originalArtifact, digests: { trmnl: "0".repeat(64) }
  }, corrected), { code: "recovery_artifact_unavailable" });
});

test("release services reject mismatched or runtime-shared release storage before reconciliation", async t => {
  const commit = "a".repeat(40);
  const bytes = Buffer.from("synthetic package");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.mock.method(AzureBlobArtifacts.prototype, "get", async () => ({ bytes, sha256 }));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.ok(url.startsWith("https://api.github.com/repos/synthetic/calendar/deployments"));
    requests.push({ url, body: JSON.parse(options.body) });
    return Response.json({ id: 123 });
  });
  const variables = {
    AZURE_STORAGE_ACCOUNT: "syntheticrelease",
    AZURE_RELEASE_CONTAINER: "release-control",
    AZURE_ARTIFACT_CONTAINER: "release-artifacts",
    AZURE_SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_RESOURCE_GROUP_NAME: "synthetic-group",
    GITHUB_TOKEN: "synthetic-token",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "synthetic/calendar",
    TRMNL_FUNCTION_KEY: "synthetic-key",
    AZURE_PARAMETERS_JSON: ""
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const services = createReleaseServices();
  const artifact = {
    references: { azure: "releases/package.zip" }, digests: { azure: sha256 },
    metadata: { azure_manifest: { commit, archive_sha256: sha256, archive_bytes: bytes.length } }
  };
  for (const [runtime, release] of [
    ["syntheticrelease", "syntheticrelease"],
    ["syntheticruntime", "wrongrelease"],
    ["syntheticruntime", undefined]
  ]) {
    process.env.AZURE_PARAMETERS_JSON = JSON.stringify({ parameters: {
      resourceGroupName: { value: "synthetic-group" },
      storageAccountName: { value: runtime },
      releaseStorageAccountName: { value: release },
      releaseControlContainerName: { value: "release-control" },
      releaseArtifactContainerName: { value: "release-artifacts" },
      releaseControllerPrincipalId: { value: "00000000-0000-0000-0000-000000000002" }
    } });
    await assert.rejects(services.deployAndVerifyAzure(commit, artifact), {
      code: "azure_runtime_target_mismatch"
    });
  }
  assert.equal(requests.filter(request => request.body.state === "failure").length, 3);
  assert.equal(requests.filter(request => request.body.state === "success").length, 0);
});

test("TRMNL release archive round-trips the exact plugin source files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-release-services-test-"));
  try {
    const source = join(directory, "checkout", "display", "src");
    const archive = join(directory, "checkout", "artifacts", "trmnl-test.tar");
    // POSIX keeps the backslash literal; Windows treats it as a directory separator.
    const destination = join(directory, String.raw`output\recovered\src`);
    await mkdir(source, { recursive: true });
    for (const file of pluginFiles) {
      await writeFile(join(source, file), `content:${file}`);
    }
    const created = await createTrmnlArchive(source, archive);
    assert.ok(created.bytes.length > 0);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);
    await unpackTrmnlArchive(archive, destination);
    assert.deepEqual((await readdir(destination)).sort(), [...pluginFiles].sort());
    for (const file of pluginFiles) {
      assert.equal(await readFile(join(destination, file), "utf8"), `content:${file}`);
    }
    const relativeArchive = join(directory, "relative archive", "trmnl-test.tar");
    const relativeDestination = join(directory, "relative recovered", "src");
    const relativeCreated = await createTrmnlArchive(
      relative(process.cwd(), source), relative(process.cwd(), relativeArchive)
    );
    assert.ok(relativeCreated.bytes.length > 0);
    await unpackTrmnlArchive(
      relative(process.cwd(), relativeArchive), relative(process.cwd(), relativeDestination)
    );
    for (const file of pluginFiles) {
      assert.equal(await readFile(join(relativeDestination, file), "utf8"), `content:${file}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TRMNL archive preparation rejects extra or nested source entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-release-services-test-"));
  try {
    const source = join(directory, "src");
    await mkdir(source, { recursive: true });
    for (const file of pluginFiles) await writeFile(join(source, file), file);
    await writeFile(join(source, "unreviewed.txt"), "unexpected");
    await assert.rejects(
      createTrmnlArchive(source, join(directory, "artifacts", "plugin.tar")),
      { code: "trmnl_source_invalid" }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release services refuse cancelled work before launching tools or contacting deployment APIs", async t => {
  const variables = {
    AZURE_STORAGE_ACCOUNT: "syntheticstorage",
    AZURE_RELEASE_CONTAINER: "release-control",
    AZURE_ARTIFACT_CONTAINER: "release-artifacts"
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const reason = Object.assign(new Error("storage_lease_lost"), { code: "storage_lease_lost" });
  const signal = AbortSignal.abort(reason);
  const services = createReleaseServices();
  const commit = "a".repeat(40);
  for (const operation of [
    () => services.changedPaths(commit, commit, { signal }),
    () => services.prepare(commit, ["azure", "trmnl"], { signal }),
    () => services.prepareTrmnlActivationRepair({ commit }, commit, { signal }),
    () => services.deployAndVerifyAzure(commit, {}, { signal }),
    () => services.inspectTrmnl(commit, { signal }),
    () => services.publishAndVerifyTrmnl(commit, {}, { signal })
  ]) {
    await assert.rejects(operation, error => error === reason);
  }
});
