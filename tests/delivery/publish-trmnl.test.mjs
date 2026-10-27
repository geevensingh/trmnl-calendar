import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishTrmnl } from "../../scripts/publish-trmnl.mjs";

async function pluginSource(t) {
  const root = await mkdtemp(join(tmpdir(), "trmnl-plugin-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.yml"), [
    "---",
    "name: Working-day agenda",
    "strategy: polling",
    "polling_url: \"{{ agenda_endpoint }}\"",
    "custom_fields:",
    "  - keyname: agenda_endpoint",
    "    field_type: url",
    "    name: Agenda endpoint",
    "  - keyname: function_key",
    "    field_type: password",
    "    name: Function-scoped key",
    "  - keyname: rules_json",
    "    field_type: code",
    "    default: \"[]\"",
    ""
  ].join("\n"));
  for (const file of ["shared.liquid", "full.liquid", "half_horizontal.liquid", "half_vertical.liquid"]) {
    await writeFile(join(root, file), `{{ ${file} }}\n`);
  }
  return root;
}

test("TRMNL publisher pins the existing plugin ID and verifies pulled definition/templates", async t => {
  const sourceDirectory = await pluginSource(t);
  const commands = [];
  const result = await publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "12345",
    apiKey: "synthetic-key",
    runCommand: async (command, args, { env, cwd }) => {
      commands.push({ command, args, env: { ...env }, cwd });
      assert.equal(env.TRMNL_API_KEY, "synthetic-key");
      assert.equal(env.AZURE_CLIENT_SECRET, undefined);
      assert.equal(env.AZURE_STORAGE_KEY, undefined);
      assert.ok(cwd.endsWith(join("plugin")));
      if (args[0] === "pull") {
        assert.ok(args.includes("--id"));
        assert.ok(args.includes("12345"));
        assert.deepEqual(await readdir(join(cwd, "src")), []);
        assert.ok(await readFile(join(cwd, ".trmnlp.yml"), "utf8"));
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        const settings = await readFile(join(cwd, "src", "settings.yml"), "utf8");
        assert.ok(settings.includes("name: Working-day agenda"));
      }
    }
  });

  assert.equal(commands.length, 2);
  for (const { command, args } of commands) {
    assert.equal(command, "trmnlp");
    assert.ok(args.includes("--force"));
    assert.ok(args.includes("--id"));
    assert.ok(args.includes("12345"));
    assert.ok(!args.includes("synthetic-key"));
  }
  assert.equal(result.verified, true);
  assert.match(result.identity, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.pluginId, "12345");
});

test("TRMNL publisher fails closed for missing or unproven target identity without contacting TRMNL", async t => {
  const sourceDirectory = await pluginSource(t);
  let calls = 0;
  const runCommand = async () => { calls += 1; };
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "",
    preservationVerifiedPluginId: "",
    apiKey: "synthetic-key",
    runCommand
  }), { message: "trmnl_target_identity_missing" });
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "different-plugin",
    apiKey: "synthetic-key",
    runCommand
  }), { message: "trmnl_preservation_gate_missing" });
  assert.equal(calls, 0);
});

test("TRMNL publisher rejects content mismatch after the remote pull", async t => {
  const sourceDirectory = await pluginSource(t);
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "12345",
    apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] === "pull") {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "full.liquid"), "unexpected remote content\n");
      }
    }
  }), { message: "trmnl_deployed_content_mismatch" });
});

test("sequential TRMNL releases retain the parent credential while isolating child environments", async t => {
  const previous = process.env.TRMNL_API_KEY;
  process.env.TRMNL_API_KEY = "synthetic-key";
  t.after(() => {
    if (previous === undefined) delete process.env.TRMNL_API_KEY;
    else process.env.TRMNL_API_KEY = previous;
  });
  const sourceDirectory = await pluginSource(t);
  for (let index = 0; index < 2; index += 1) {
    const result = await publishTrmnl({
      sourceDirectory,
      pluginId: "12345",
      preservationVerifiedPluginId: "12345",
      runCommand: async (_command, args, { env, cwd }) => {
        assert.equal(env.TRMNL_API_KEY, "synthetic-key");
        if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      }
    });

    assert.equal(result.verified, true);
    assert.equal(process.env.TRMNL_API_KEY, "synthetic-key");
  }
});

test("TRMNL verification rejects an archive missing a template instead of using the uploaded copy", async t => {
  const sourceDirectory = await pluginSource(t);
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "12345",
    apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] === "pull") {
        for (const file of await readdir(sourceDirectory)) {
          if (file !== "full.liquid") await cp(join(sourceDirectory, file), join(cwd, "src", file));
        }
      }
    }
  }), { message: "trmnl_deployed_file_set_mismatch" });
});

test("publisher cancellation reaches the active push and prevents a subsequent pull", async t => {
  const sourceDirectory = await pluginSource(t);
  const abort = new AbortController();
  const calls = [];
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "12345",
    apiKey: "synthetic-key",
    signal: abort.signal,
    runCommand: async (_command, args, { signal }) => {
      calls.push(args[0]);
      assert.equal(signal, abort.signal);
      const cancelled = new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      abort.abort(new Error("storage_lease_lost"));
      return cancelled;
    }
  }), { message: "trmnl_publish_or_verify_failed" });
  assert.deepEqual(calls, ["push"]);
});
