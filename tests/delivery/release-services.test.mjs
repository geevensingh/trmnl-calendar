import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { createTrmnlArchive, unpackTrmnlArchive } from "../../scripts/release-services.mjs";

const pluginFiles = [
  "settings.yml", "shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"
];

async function unpackWithDiagnostics(t, archive, destination) {
  try {
    await unpackTrmnlArchive(archive, destination);
  } catch (error) {
    // Match the release subprocess environment, but replay only this test's synthetic archive.
    const env = {};
    for (const key of [
      "PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "LC_ALL",
      "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "DOTNET_ROOT", "DOTNET_CLI_HOME",
      "NUGET_PACKAGES", "DOTNET_GENERATE_ASPNET_CERTIFICATE", "SystemRoot"
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const cwd = dirname(resolve(archive));
    const archiveName = `./${basename(archive)}`;
    for (const [command, args] of [
      [process.platform === "win32" ? "where.exe" : "which", ["tar"]],
      ["tar", ["--version"]],
      ["tar", ["-tf", archiveName]],
      ["tar", ["-xf", archiveName, "-C", resolve(destination)]]
    ]) {
      const result = spawnSync(command, args, {
        cwd, env, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 256 * 1024
      });
      t.diagnostic(`Synthetic archive diagnostic: ${JSON.stringify({
        command, args, cwd, status: result.status, signal: result.signal,
        error: result.error?.code,
        stdout: result.stdout?.slice(0, 8192),
        stderr: result.stderr?.slice(0, 8192)
      })}`);
    }
    throw error;
  }
}

test("TRMNL release archive round-trips the exact plugin source files", async t => {
  const directory = await mkdtemp(join(tmpdir(), "calendar-release-services-test-"));
  try {
    const source = join(directory, "checkout", "display", "src");
    const archive = join(directory, "checkout", "artifacts", "trmnl-test.tar");
    const destination = join(directory, "recovered", "src");
    await mkdir(source, { recursive: true });
    for (const file of pluginFiles) {
      await writeFile(join(source, file), `content:${file}`);
    }
    const created = await createTrmnlArchive(source, archive);
    assert.ok(created.bytes.length > 0);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);
    await unpackWithDiagnostics(t, archive, destination);
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
    await unpackWithDiagnostics(
      t,
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
