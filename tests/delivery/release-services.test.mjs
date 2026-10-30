import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createReleaseServices, createTrmnlArchive, unpackTrmnlArchive } from "../../scripts/release-services.mjs";
import { AzureBlobArtifacts } from "../../scripts/azure-blob-ledger.mjs";

const pluginFiles = [
  "settings.yml", "shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"
];

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
    () => services.deployAndVerifyAzure(commit, {}, { signal }),
    () => services.inspectTrmnl(commit, { signal }),
    () => services.publishAndVerifyTrmnl(commit, {}, { signal })
  ]) {
    await assert.rejects(operation, error => error === reason);
  }
});
