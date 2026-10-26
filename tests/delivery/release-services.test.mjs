import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrmnlArchive, unpackTrmnlArchive } from "../../scripts/release-services.mjs";

const pluginFiles = [
  "settings.yml", "shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"
];

test("TRMNL release archive round-trips the exact plugin source files", async () => {
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
    await unpackTrmnlArchive(archive, destination);
    assert.deepEqual((await readdir(destination)).sort(), [...pluginFiles].sort());
    for (const file of pluginFiles) {
      assert.equal(await readFile(join(destination, file), "utf8"), `content:${file}`);
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
