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
    backupRecoveryAcceptedPluginId: "12345",
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

  assert.deepEqual(commands.map(({ args }) => args[0]), ["pull", "push", "pull"]);
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
  assert.equal(result.preservation_basis, "synthetic_verified");
});

test("TRMNL publisher accepts plugin-specific backup recovery approval without claiming preservation proof", async t => {
  const sourceDirectory = await pluginSource(t);
  const calls = [];
  const result = await publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    preservationVerifiedPluginId: "different-plugin",
    backupRecoveryAcceptedPluginId: "12345",
    apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls.push(args);
      if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
    }
  });
  assert.deepEqual(calls.map(args => args[0]), ["pull", "push", "pull"]);
  assert.ok(calls.every(args => args.includes("12345")));
  assert.equal(result.verified, true);
  assert.equal(result.preservation_basis, "owner_backup_manual_recovery");
});

test("settings parser receives tool settings but no workflow credentials or Azure configuration", async t => {
  const sourceDirectory = await pluginSource(t);
  const instrumentation = await mkdtemp(join(tmpdir(), "trmnl-parser-test-"));
  t.after(() => rm(instrumentation, { recursive: true, force: true }));
  const observations = join(instrumentation, "parser-environment.jsonl");
  const probe = join(instrumentation, "environment-probe.rb");
  const protectedNames = [
    "GITHUB_TOKEN", "GH_TOKEN", "TRMNL_API_KEY", "TRMNL_FUNCTION_KEY",
    "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "AZURE_PARAMETERS_JSON", "AZURE_CLIENT_SECRET"
  ];
  await writeFile(probe, [
    "require 'json'",
    `File.open(${JSON.stringify(observations.replaceAll("\\", "/"))}, 'a') do |output|`,
    `  output.puts(JSON.generate(ENV.to_h.slice(*${JSON.stringify(protectedNames)}, 'PATH')))`,
    "end"
  ].join("\n"));
  const injected = Object.fromEntries(protectedNames.map(name => [name, `synthetic-${name}`]));
  injected.RUBYOPT = "-renvironment-probe";
  injected.RUBYLIB = instrumentation;
  const previous = Object.fromEntries(Object.keys(injected).map(name => [name, process.env[name]]));
  Object.assign(process.env, injected);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const result = await publishTrmnl({
    sourceDirectory, pluginId: "12345", preservationVerifiedPluginId: "12345",
    runCommand: async (_command, args, { env, cwd }) => {
      assert.equal(env.TRMNL_API_KEY, injected.TRMNL_API_KEY);
      for (const name of protectedNames.filter(name => name !== "TRMNL_API_KEY")) {
        assert.equal(env[name], undefined);
      }
      if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
    }
  });
  assert.equal(result.verified, true);
  const parsers = (await readFile(observations, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(parsers.length, 4);
  for (const parser of parsers) {
    assert.ok(parser.PATH);
    for (const name of protectedNames) assert.equal(parser[name], undefined, `${name} reached settings parser`);
  }
  for (const [name, value] of Object.entries(injected)) assert.equal(process.env[name], value);
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
  for (const backupRecoveryAcceptedPluginId of ["", "true", "12346"]) {
    await assert.rejects(publishTrmnl({
      sourceDirectory,
      pluginId: "12345",
      backupRecoveryAcceptedPluginId,
      apiKey: "synthetic-key",
      runCommand
    }), { message: "trmnl_preservation_gate_missing" });
  }
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
    runCommand: async (_command, args, { signal, cwd }) => {
      calls.push(args[0]);
      assert.equal(signal, abort.signal);
      if (args[0] === "pull") {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        return;
      }
      const cancelled = new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      abort.abort(new Error("storage_lease_lost"));
      return cancelled;
    }
  }), { message: "trmnl_publish_or_verify_failed" });
  assert.deepEqual(calls, ["pull", "push"]);
});

for (const change of ["rename", "remove"]) {
  test(`publisher rejects a configured-field ${change} before pushing`, async t => {
    const deployedSource = await pluginSource(t);
    const sourceDirectory = await pluginSource(t);
    const settings = await readFile(join(sourceDirectory, "settings.yml"), "utf8");
    await writeFile(join(sourceDirectory, "settings.yml"), change === "rename"
      ? settings.replace("keyname: function_key", "keyname: renamed_key")
      : settings.replace('  - keyname: rules_json\n    field_type: code\n    default: "[]"\n', ""));
    const commands = [];
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        commands.push(args[0]);
        assert.equal(args[0], "pull");
        await cp(deployedSource, join(cwd, "src"), { recursive: true });
      }
    }), { code: "trmnl_field_migration_required" });
    assert.deepEqual(commands, ["pull"]);
  });
}

test("publisher refuses to infer preservation when the deployed field schema is absent", async t => {
  const sourceDirectory = await pluginSource(t);
  const commands = [];
  await assert.rejects(publishTrmnl({
    sourceDirectory, pluginId: "12345", preservationVerifiedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      commands.push(args[0]);
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "settings.yml"), "name: Missing field schema\n");
    }
  }), { code: "trmnl_field_schema_invalid" });
  assert.deepEqual(commands, ["pull"]);
});

test("settings comparison ignores mapping-key order recursively but preserves array order", async t => {
  const sourceDirectory = await pluginSource(t);
  const reordered = [
    "custom_fields:",
    "  - name: Agenda endpoint",
    "    field_type: url",
    "    keyname: agenda_endpoint",
    "  - name: Function-scoped key",
    "    keyname: function_key",
    "    field_type: password",
    '  - default: "[]"',
    "    field_type: code",
    "    keyname: rules_json",
    'polling_url: "{{ agenda_endpoint }}"',
    "strategy: polling",
    "name: Working-day agenda",
    ""
  ].join("\n");
  let reverseArray = false;
  const options = {
    sourceDirectory, pluginId: "12345", preservationVerifiedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] === "pull") {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        const remote = reverseArray
          ? reordered.replace(/custom_fields:\n([\s\S]*?)polling_url:/, (_match, fields) =>
            `custom_fields:\n${fields.split(/(?=  - )/).filter(field => field.trim()).reverse().join("")}polling_url:`)
          : reordered;
        await writeFile(join(cwd, "src", "settings.yml"), remote);
      }
    }
  };
  assert.equal((await publishTrmnl(options)).verified, true);
  reverseArray = true;
  await assert.rejects(publishTrmnl(options), { code: "trmnl_deployed_content_mismatch" });
});
