import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as publisher from "../../scripts/publish-trmnl.mjs";

const { publishTrmnl } = publisher;

test.beforeEach(t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://trmnl.com/api/plugin_settings/12345/details");
    assert.equal(options.method, "GET");
    return Response.json({ data: { settings: {}, strategy: "polling" } });
  });
});

test("inspection compares only explicitly returned polling definition text from documented details", async t => {
  const sourceDirectory = await pluginSource(t);
  await writeFile(join(sourceDirectory, "settings.yml"),
    (await readFile(join(sourceDirectory, "settings.yml"), "utf8")) +
    'polling_headers: "x-functions-key: {{ function_key }}"\npolling_body: \'{"rules_json": {{ rules_json | json }}}\'\n');
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer synthetic-key");
    return Response.json({ data: { settings: {
      polling_headers: "x-functions-key: {{ function_key }}",
      polling_body: '{"rules_json": {{ rules_json | json }}}',
      SYNTHETIC_PRIVATE_CUSTOM_FIELD: "SYNTHETIC_PRIVATE_VALUE"
    } } });
  });
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const path = join(cwd, "src", "settings.yml");
      await writeFile(path, (await readFile(path, "utf8")).replace(/polling_headers:[\s\S]*$/,
        "polling_headers: null\npolling_body: null\n"));
    }
  });
  assert.deepEqual(requests, ["https://trmnl.com/api/plugin_settings/12345/details"]);
  assert.equal(result.content_matches, true);
  assert.deepEqual(result.definition_readback, {
    operation: "getPluginSettingDetails", response_available: true,
    fields: [
      { field: "polling_headers", source_type: "string", deployed_type: "string", observable: true, matches: true },
      { field: "polling_body", source_type: "string", deployed_type: "string", observable: true, matches: true }
    ]
  });
  assert.equal(result.content_comparison.files[0].result, "different", "Archive differences remain visible");
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|function_key|rules_json|x-functions-key|[a-f0-9]{64}/);
});

async function pollingSource(t) {
  const source = await pluginSource(t);
  await writeFile(join(source, "settings.yml"), (await readFile(join(source, "settings.yml"), "utf8")) +
    'polling_headers: "x-functions-key: {{ function_key }}"\npolling_body: \'{"rules_json": {{ rules_json | json }}}\'\n');
  return source;
}

const pollingDetails = {
  polling_headers: "x-functions-key: {{ function_key }}",
  polling_body: '{"rules_json": {{ rules_json | json }}}'
};

async function pullRedacted(source, cwd) {
  await cp(source, join(cwd, "src"), { recursive: true });
  const path = join(cwd, "src", "settings.yml");
  await writeFile(path, (await readFile(path, "utf8")).replace(/polling_headers:[\s\S]*$/,
    "polling_headers: null\npolling_body: null\n"));
}

test("publication accepts exported nulls only after exact independent polling readback", async t => {
  const sourceDirectory = await pollingSource(t);
  const calls = [];
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.deepEqual(calls, ["pull", "push", "pull"], "Read the current definition after publication");
    assert.equal(url, "https://trmnl.com/api/plugin_settings/12345/details");
    assert.deepEqual(options.headers, { Authorization: "Bearer synthetic-key", Accept: "application/json" });
    return Response.json({ data: { settings: { ...pollingDetails } } });
  });
  const result = await publishTrmnl({
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls.push(args[0]);
      if (args[0] === "pull") await pullRedacted(sourceDirectory, cwd);
      if (args[0] === "push") {
        assert.equal(await readFile(join(cwd, "src", "settings.yml"), "utf8"),
          await readFile(join(sourceDirectory, "settings.yml"), "utf8"));
      }
    }
  });
  assert.deepEqual(Object.keys(result).sort(), ["identity", "pluginId", "verified"]);
  assert.equal(result.verified, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "trmnl_definition_readback");
  assert.ok(events[0].fields.every(field => field.observable && field.matches));
  assert.doesNotMatch(JSON.stringify(events), /function_key|rules_json|synthetic-key|12345|[a-f0-9]{64}/);
});

test("direct disagreement with an empty source body blocks publication and inspection", async t => {
  const sourceDirectory = await pollingSource(t);
  const path = join(sourceDirectory, "settings.yml");
  await writeFile(path, (await readFile(path, "utf8")).replace(
    /^polling_body:.*$/m, 'polling_body: ""'));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: { settings: { ...pollingDetails, polling_body: "SYNTHETIC_PRIVATE_UNEXPECTED_BODY" } }
  }));
  const options = {
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] !== "pull") return;
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const deployedPath = join(cwd, "src", "settings.yml");
      await writeFile(deployedPath, (await readFile(deployedPath, "utf8")).replace(
        /^polling_headers:.*$/m, "polling_headers: null"));
    }
  };
  await assert.rejects(publishTrmnl(options), { code: "trmnl_deployed_content_mismatch" });
  const result = await publisher.inspectTrmnl(options);
  assert.equal(result.content_matches, false);
  assert.equal(result.definition_readback.fields[1].observable, true);
  assert.equal(result.definition_readback.fields[1].matches, false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_UNEXPECTED_BODY/);
});

for (const omittedPolling of [false, true]) {
  test(`settings retain integer precision with omitted polling ${omittedPolling}`, async t => {
    const sourceDirectory = await pollingSource(t);
    const path = join(sourceDirectory, "settings.yml");
    // Include a known scalar and a nested unknown field; neither may be rounded away.
    await writeFile(path, (await readFile(path, "utf8")).replace("---\n",
      "---\nrefresh_interval: 9007199254740992\n" +
      "SYNTHETIC_PRIVATE_SETTING: {nested: [9007199254740992]}\n"));
    t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: { settings: { ...pollingDetails } } }));
    for (const setting of ["refresh_interval", "SYNTHETIC_PRIVATE_SETTING"]) {
      let changed = true;
      const options = {
        sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
        runCommand: async (_command, args, { cwd }) => {
          if (args[0] !== "pull") return;
          if (omittedPolling) await pullRedacted(sourceDirectory, cwd);
          else await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
          if (changed) {
            const deployedPath = join(cwd, "src", "settings.yml");
            await writeFile(deployedPath, (await readFile(deployedPath, "utf8")).replace(
              new RegExp(`^${setting}:.*$`, "m"), line => line.replace("9007199254740992", "9007199254740993")));
          }
        }
      };
      await assert.rejects(publishTrmnl(options), { code: "trmnl_deployed_content_mismatch" });
      assert.equal((await publisher.inspectTrmnl(options)).content_matches, false);
      changed = false;
      assert.equal((await publishTrmnl(options)).verified, true, "Equal large integers still match");
    }
  });
}

test("post-upload details failures retain archive comparison evidence and redacted errors", async t => {
  const sourceDirectory = await pollingSource(t);
  const marker = "SYNTHETIC_PRIVATE_DETAILS_FAILURE";
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  for (const [response, code] of [
    [() => new Response(marker, { status: 403 }), "trmnl_details_http_403"],
    [() => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(marker)); }
    }), { status: 403 }), "trmnl_details_http_403"],
    [() => new Response(marker), "trmnl_details_response_invalid"],
    [() => { throw new Error(marker); }, "trmnl_details_request_failed"]
  ]) {
    events.length = 0;
    const calls = [];
    t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        calls.push(args[0]);
        if (args[0] === "pull") await pullRedacted(sourceDirectory, cwd);
      }
    }), error => error.code === code && error.message === code && !JSON.stringify(error).includes(marker));
    assert.deepEqual(calls, ["pull", "push", "pull"]);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "trmnl_content_comparison");
    assert.equal(events[0].stage, "verify");
    assert.deepEqual(events[0].definition.fields.map(({ field }) => field), ["polling_headers", "polling_body"]);
    assert.equal(events[0].files[0].result, "different");
    assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC|function_key|rules_json|synthetic-key|12345|[a-f0-9]{64}/);
  }
});

test("sanitized, missing, rendered or changed details never prove the unrendered polling definition", async t => {
  const sourceDirectory = await pollingSource(t);
  t.mock.method(console, "error", () => {});
  for (const settings of [
    {}, { ...pollingDetails, polling_headers: null },
    { ...pollingDetails, polling_body: null },
    { ...pollingDetails, polling_headers: "[set]" },
    { ...pollingDetails, polling_headers: "SYNTHETIC_PRIVATE_LITERAL_KEY" },
    { custom_fields_values: { ...pollingDetails } },
    { ...pollingDetails, polling_body: '{"rules_json": []}' },
    { ...pollingDetails, polling_body: `${pollingDetails.polling_body}\n` }
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: { settings } }));
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        if (args[0] === "pull") await pullRedacted(sourceDirectory, cwd);
      }
    }), { code: "trmnl_deployed_content_mismatch" });
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: { settings: { ...pollingDetails, polling_headers: "[set]" } }
  }));
  const inspected = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => pullRedacted(sourceDirectory, cwd)
  });
  assert.deepEqual(inspected.definition_readback.fields[0], {
    field: "polling_headers", source_type: "string", deployed_type: "string",
    observable: false, matches: false
  });
});

test("exact details cannot waive a different template, known setting or unknown behavior-changing export field", async t => {
  const sourceDirectory = await pollingSource(t);
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { settings: { ...pollingDetails } } }));
  for (const change of ["template", "known_setting", "unknown_setting", "documented_metadata"]) {
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        if (args[0] !== "pull") return;
        await pullRedacted(sourceDirectory, cwd);
        if (change === "template") await writeFile(join(cwd, "src", "full.liquid"), "SYNTHETIC_PRIVATE_TEMPLATE");
        const path = join(cwd, "src", "settings.yml");
        if (change === "known_setting") {
          await writeFile(path, (await readFile(path, "utf8")).replace("strategy: polling", "strategy: webhook"));
        } else if (change === "unknown_setting" || change === "documented_metadata") {
          await writeFile(path, (await readFile(path, "utf8")) +
            (change === "unknown_setting" ? "SYNTHETIC_PRIVATE_EXTRA_FIELD: true\n" : "'read_only?': false\n"));
        }
      }
    }), { code: "trmnl_deployed_content_mismatch" });
  }
  assert.doesNotMatch(JSON.stringify(events), /SYNTHETIC|function_key|rules_json|[a-f0-9]{64}/);
  assert.ok(events.at(-1).definition.fields.some(field => field.field === "read_only?"));
  assert.equal(events.at(-1).definition.unknown_fields.deployed_count, 0);
});

test("details HTTP and malformed or oversized response failures are explicit and redacted", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_DETAILS_FAILURE";
  for (const [response, code] of [
    [new Response(marker, { status: 403 }), "trmnl_details_http_403"],
    [new Response(new ReadableStream({
      start(controller) { controller.error(new Error(marker)); }
    }), { status: 403 }), "trmnl_details_http_403"],
    [new Response(marker, { status: 404 }), "trmnl_details_http_404"],
    [new Response(marker, { status: 401 }), "trmnl_details_http_401"],
    [new Response(marker), "trmnl_details_response_invalid"],
    [Response.json({ data: null }), "trmnl_details_response_invalid"],
    [Response.json({ data: { settings: ["not a mapping"] } }), "trmnl_details_response_invalid"],
    [new Response(JSON.stringify({ data: { settings: {}, private_value: marker.repeat(40000) } })),
      "trmnl_details_output_limit"]
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(publisher.inspectTrmnl({
      sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, _args, { cwd }) => cp(sourceDirectory, join(cwd, "src"), { recursive: true })
    }), error => error.code === code && !JSON.stringify(error).includes(marker));
  }
});

test("details cancellation reaches the request and reports no raw transport diagnostic", async t => {
  const sourceDirectory = await pluginSource(t);
  const abort = new AbortController();
  let requested = false;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    requested = true;
    const cancelled = new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("SYNTHETIC_PRIVATE_TRANSPORT")), { once: true });
    });
    abort.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    return cancelled;
  });
  await assert.rejects(publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key", signal: abort.signal,
    runCommand: async (_command, _args, { cwd }) => cp(sourceDirectory, join(cwd, "src"), { recursive: true })
  }), error => error.code === "trmnl_details_cancelled" && !JSON.stringify(error).includes("SYNTHETIC"));
  assert.equal(requested, true);
});

test("details cancellation during body reading leaves no partial-response success", async t => {
  const sourceDirectory = await pluginSource(t);
  const abort = new AbortController();
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('{"data":{"settings":'));
        signal.addEventListener("abort", () => controller.error(new Error("SYNTHETIC_PRIVATE_BODY")), { once: true });
        setTimeout(() => abort.abort(), 10);
      }
    });
    return new Response(body);
  });
  await assert.rejects(publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key", signal: abort.signal,
    runCommand: async (_command, _args, { cwd }) => cp(sourceDirectory, join(cwd, "src"), { recursive: true })
  }), error => error.code === "trmnl_details_cancelled" && !JSON.stringify(error).includes("SYNTHETIC"));
});

test("details has one bounded deadline and refuses transport or redirect failures", async t => {
  const sourceDirectory = await pluginSource(t);
  t.mock.method(globalThis, "fetch", async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () =>
      reject(new Error("SYNTHETIC_PRIVATE_TIMEOUT")), { once: true })));
  // Keep the mock transport alive as a real socket would; AbortSignal's timeout is unreferenced.
  const socket = setInterval(() => {}, 1000);
  try {
    await assert.rejects(publisher.inspectTrmnl({
      sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, _args, { cwd }) => cp(sourceDirectory, join(cwd, "src"), { recursive: true })
    }), { code: "trmnl_details_timeout" });
  } finally {
    clearInterval(socket);
  }
  t.mock.method(globalThis, "fetch", async (_url, { redirect }) => {
    assert.equal(redirect, "error");
    throw new TypeError("SYNTHETIC_PRIVATE_REDIRECT");
  });
  await assert.rejects(publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => cp(sourceDirectory, join(cwd, "src"), { recursive: true })
  }), error => error.code === "trmnl_details_request_failed" && !JSON.stringify(error).includes("SYNTHETIC"));
});

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
  assert.deepEqual(Object.keys(result).sort(), ["identity", "pluginId", "verified"]);
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
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345",
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

test("TRMNL publisher requires an exact plugin-specific backup approval before contacting TRMNL", async t => {
  const sourceDirectory = await pluginSource(t);
  let calls = 0;
  const runCommand = async () => { calls += 1; };
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "",
    backupRecoveryAcceptedPluginId: "",
    apiKey: "synthetic-key",
    runCommand
  }), { message: "trmnl_target_identity_missing" });
  for (const backupRecoveryAcceptedPluginId of [undefined, "", "true", "12346"]) {
    await assert.rejects(publishTrmnl({
      sourceDirectory,
      pluginId: "12345",
      backupRecoveryAcceptedPluginId,
      apiKey: "synthetic-key",
      runCommand
    }), { message: "trmnl_backup_approval_missing" });
  }
  assert.equal(calls, 0);
});

test("TRMNL publisher rejects content mismatch after the remote pull", async t => {
  const sourceDirectory = await pluginSource(t);
  await assert.rejects(publishTrmnl({
    sourceDirectory,
    pluginId: "12345",
    backupRecoveryAcceptedPluginId: "12345",
    apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] === "pull") {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "full.liquid"), "unexpected remote content\n");
      }
    }
  }), { message: "trmnl_deployed_content_mismatch" });
});

for (const [failureAt, stage] of [[1, "preflight_pull"], [2, "push"], [3, "verify_pull"]]) {
  test(`TRMNL ${stage} failure retains only its stage and allowlisted HTTP status`, async t => {
    const sourceDirectory = await pluginSource(t);
    let calls = 0;
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345",
      apiKey: "synthetic-private-key",
      runCommand: async (_command, args, { cwd, env }) => {
        assert.equal(env.TRMNL_API_KEY, "synthetic-private-key");
        calls += 1;
        if (calls === failureAt) {
          throw Object.assign(new Error("synthetic-private-key https://private.invalid"), {
            stderr: "Error: failed to download plugin settings archive: 403 synthetic-private-key"
          });
        }
        if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      }
    }), error => {
      assert.equal(error.code, `trmnl_${stage}_http_403`);
      assert.equal(error.message, error.code);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-private|private.invalid|stderr/);
      return true;
    });
    assert.equal(calls, failureAt);
  });
}

test("TRMNL publisher does not promote arbitrary diagnostic text into safe status codes", async t => {
  const sourceDirectory = await pluginSource(t);
  await assert.rejects(publishTrmnl({
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async () => {
      throw Object.assign(new Error("private diagnostic"), {
        code: "trmnl_private_key_value",
        stdout: "private field 401; failed to download plugin settings archive: 418 private body"
      });
    }
  }), { code: "trmnl_preflight_pull_failed" });
});

for (const [label, body, issues] of [
  ["field map", { errors: {
    description: ["is too long (maximum is 35 characters): synthetic-private-value"],
    polling_url: ["is invalid: https://private.invalid"],
    private_configured_field: ["synthetic-private-key"]
  }, data: { function_key: "synthetic-private-key" } }, [
    { field: "description", reason: "too_long" }, { field: "polling_url", reason: "invalid" }
  ]],
  ["message list", { errors: [
    "Description is too long (maximum is 35 characters)",
    "Polling verb is not included in the list",
    "synthetic-private-key"
  ] }, [
    { field: "description", reason: "too_long" }, { field: "polling_verb", reason: "unsupported" }
  ]],
  ["validation message", { message: "Validation failed: Description is too long (maximum is 35 characters)" }, [
    { field: "description", reason: "too_long" }
  ]],
  ["validation records", { errors: [
    { field: "refresh_interval", message: "must be greater than 0: synthetic-private-value" },
    { field: "name", message: "has already been taken: synthetic-private-name" },
    { field: "private_field", message: "Description is invalid: synthetic-private-value" }
  ] }, [
    { field: "name", reason: "duplicate" }, { field: "refresh_interval", reason: "out_of_range" }
  ]],
  ["echoed reason words", { errors: {
    polling_url: ["is invalid: https://private.invalid/unsupported"]
  } }, [{ field: "polling_url", reason: "invalid" }]],
  ["unknown validation prefix", { errors: {
    description: ["synthetic-private-value is required: unsupported"]
  } }, [{ field: "description", reason: "unclassified" }]],
  ["normalized validation prefix", { errors: {
    polling_url: [" \tIs invalid: https://private.invalid/unsupported"]
  } }, [{ field: "polling_url", reason: "invalid" }]],
  ["combined validation message", {
    message: "Validation failed: Description is too long, Name can't be blank"
  }, []],
  ["combined field-map message", { errors: {
    description: ["is too long, Name can't be blank"]
  } }, []],
  ["echoed combined message", { errors: {
    description: ["is too long: synthetic-private-value, Name can't be blank"]
  } }, [{ field: "description", reason: "too_long" }]],
  ["unrecognized response", { error: "synthetic-private-key", private_field: "https://private.invalid" }, []]
]) {
  test(`TRMNL upload validation classifies ${label} without disclosing response values`, async t => {
    const sourceDirectory = await pluginSource(t);
    const diagnostics = [];
    t.mock.method(console, "error", message => diagnostics.push(JSON.parse(message)));
    const calls = [];
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        calls.push(args[0]);
        if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        else throw Object.assign(new Error("synthetic-private-key"), {
          stderr: `api_client.rb:81: failed to upload plugin settings archive: 422 ${JSON.stringify(body)} (TRMNLP::Error)\n from cli.rb:1`
        });
      }
    }), { code: "trmnl_push_http_422" });
    assert.deepEqual(calls, ["pull", "push"]);
    assert.deepEqual(diagnostics, [{
      event: "trmnl_archive_validation", stage: "push", http_status: 422,
      classified: issues.length > 0, issues
    }]);
    assert.doesNotMatch(JSON.stringify(diagnostics),
      /synthetic|private|function_key|https|35|maximum|api_client|cli\.rb/);
  });
}

test("TRMNL upload validation never prints malformed or oversized response bodies", async t => {
  const sourceDirectory = await pluginSource(t);
  const diagnostics = [];
  t.mock.method(console, "error", message => diagnostics.push(JSON.parse(message)));
  const oversized = JSON.stringify({
    errors: { description: ["is too long"] }, private_value: " ".repeat(65_536)
  });
  assert.ok(oversized.length > 65_536);
  assert.deepEqual(JSON.parse(oversized).errors, { description: ["is too long"] });
  for (const body of ["not-json synthetic-private-key", oversized]) {
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, args, { cwd }) => {
        if (args[0] === "pull") await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        else throw Object.assign(new Error(), { stderr: `failed to upload plugin settings archive: 422 ${body}` });
      }
    }), { code: "trmnl_push_http_422" });
  }
  assert.equal(diagnostics.length, 2);
  for (const diagnostic of diagnostics) {
    assert.deepEqual(diagnostic.issues, []);
    assert.equal(diagnostic.classified, false);
  }
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic|private/);
});

test("TRMNL publisher identifies unreadable exported settings without exposing their values", async t => {
  const sourceDirectory = await pluginSource(t);
  let calls = 0;
  await assert.rejects(publishTrmnl({
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      calls += 1;
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "settings.yml"), "private: [unterminated\n");
    }
  }), { code: "trmnl_preflight_settings_invalid" });
  assert.equal(calls, 1);
});

for (const [failure, suffix] of [
  [{ code: "ENOENT" }, "unavailable"],
  [{ killed: true }, "timeout"],
  [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }, "output_limit"],
  [{ stdout: "Error: failed to download plugin settings archive: 401 private response" }, "http_401"]
]) {
  test(`TRMNL publisher reports fixed ${suffix} diagnostics without raw command output`, async t => {
    const sourceDirectory = await pluginSource(t);
    await assert.rejects(publishTrmnl({
      sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
      runCommand: async () => { throw Object.assign(new Error("private diagnostic"), failure); }
    }), { code: `trmnl_preflight_pull_${suffix}` });
  });
}

test("TRMNL publisher distinguishes invalid source and post-push settings", async t => {
  const sourceDirectory = await pluginSource(t);
  const sourceSettings = await readFile(join(sourceDirectory, "settings.yml"), "utf8");
  await writeFile(join(sourceDirectory, "settings.yml"), "private: [unterminated\n");
  let calls = 0;
  const options = {
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls += 1;
      if (args[0] === "pull") {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        if (calls === 3) await writeFile(join(cwd, "src", "settings.yml"), "private: [unterminated\n");
      }
    }
  };
  await assert.rejects(publishTrmnl(options), { code: "trmnl_source_settings_invalid" });
  assert.equal(calls, 0);
  await writeFile(join(sourceDirectory, "settings.yml"), sourceSettings);
  await assert.rejects(publishTrmnl(options), { code: "trmnl_verify_settings_invalid" });
  assert.equal(calls, 3);
});

test("read-only TRMNL inspection pulls once and reports compatibility without publishing or backup approval", async t => {
  const sourceDirectory = await pluginSource(t);
  const calls = [];
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls.push(args[0]);
      assert.equal(args[0], "pull");
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
    }
  });
  const { content_comparison, definition_readback, ...existing } = result;
  assert.deepEqual(existing, {
    operation: "inspect-trmnl", remote_readable: true, field_schema_compatible: true, content_matches: true
  });
  assert.deepEqual(content_comparison, {
    file_set_matches: true,
    files: [
      { file: "settings.yml", result: "match" },
      { file: "shared.liquid", result: "match" },
      { file: "full.liquid", result: "match" },
      { file: "half_horizontal.liquid", result: "match" },
      { file: "half_vertical.liquid", result: "match" }
    ],
    unknown_files: { source_count: 0, deployed_count: 0, matches: true },
    definition: {
      compared: true, fields: [],
      unknown_fields: { source_count: 0, deployed_count: 0, matches: true }
    }
  });
  assert.deepEqual(calls, ["pull"]);
  assert.equal(definition_readback.response_available, true);
  assert.ok(definition_readback.fields.every(field => field.observable === false && field.matches === false));
  assert.doesNotMatch(JSON.stringify(result), /synthetic|12345|agenda_endpoint|function_key|rules_json/);
});

test("read-only TRMNL inspection reports mismatches without mutating the plugin", async t => {
  const sourceDirectory = await pluginSource(t);
  const calls = [];
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls.push(args[0]);
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const settings = await readFile(join(cwd, "src", "settings.yml"), "utf8");
      await writeFile(join(cwd, "src", "settings.yml"), settings.replace("keyname: function_key", "keyname: previous_key"));
      await writeFile(join(cwd, "src", "full.liquid"), "different remote template\n");
    }
  });
  const { content_comparison, definition_readback, ...existing } = result;
  assert.deepEqual(existing, {
    operation: "inspect-trmnl", remote_readable: true, field_schema_compatible: false, content_matches: false
  });
  assert.deepEqual(content_comparison.definition.fields, [
    { field: "custom_fields", reason: "value_mismatch",
      source_type: "array", deployed_type: "array", source_empty: false, deployed_empty: false }
  ]);
  assert.equal(content_comparison.files.find(item => item.file === "full.liquid").result, "different");
  assert.deepEqual(calls, ["pull"]);
  assert.equal(definition_readback.operation, "getPluginSettingDetails");
});

test("read-only comparison identifies fixed fields and files without exposing remote names, values or hashes", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_COMPARISON_MARKER";
  const calls = [];
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      calls.push(args[0]);
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const settings = await readFile(join(cwd, "src", "settings.yml"), "utf8");
      await writeFile(join(cwd, "src", "settings.yml"),
        settings.replace("name: Working-day agenda", `name: ${marker}`)
          .replace("keyname: function_key", `keyname: ${marker}_configured_field`) +
        `${marker}_unknown_definition: "${marker}_unknown_value"\n`);
      await writeFile(join(cwd, "src", "half_vertical.liquid"), `${marker}_template`);
    }
  });
  assert.equal(result.content_matches, false);
  assert.equal(result.field_schema_compatible, false);
  assert.deepEqual(result.content_comparison, {
    file_set_matches: true,
    files: [
      { file: "settings.yml", result: "different" },
      { file: "shared.liquid", result: "match" },
      { file: "full.liquid", result: "match" },
      { file: "half_horizontal.liquid", result: "match" },
      { file: "half_vertical.liquid", result: "different" }
    ],
    unknown_files: { source_count: 0, deployed_count: 0, matches: true },
    definition: {
      compared: true,
      fields: [
        { field: "name", reason: "value_mismatch",
          source_type: "string", deployed_type: "string", source_empty: false, deployed_empty: false },
        { field: "custom_fields", reason: "value_mismatch",
          source_type: "array", deployed_type: "array", source_empty: false, deployed_empty: false }
      ],
      unknown_fields: { source_count: 0, deployed_count: 1, matches: false }
    }
  });
  assert.deepEqual(calls, ["pull"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(
    `${marker}|agenda_endpoint|function_key|rules_json|synthetic-key|12345|[a-f0-9]{64}`
  ));
});

test("comparison distinguishes missing definitions and value types without emitting values or canonicalization noise", async t => {
  const sourceDirectory = await pluginSource(t);
  const settings = await readFile(join(sourceDirectory, "settings.yml"), "utf8");
  await writeFile(join(sourceDirectory, "settings.yml"),
    `${settings}description: Private synthetic agenda.\nrefresh_interval: 15\n`);
  const inspected = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "settings.yml"),
        `${settings}refresh_interval: "15"\ndark_mode: "no"\nid: 98765\n`);
    }
  });
  assert.deepEqual(inspected.content_comparison.definition.fields, [
    { field: "description", reason: "deployed_missing",
      source_type: "string", deployed_type: "missing", source_empty: false, deployed_empty: null },
    { field: "refresh_interval", reason: "type_mismatch",
      source_type: "number", deployed_type: "string", source_empty: null, deployed_empty: false },
    { field: "dark_mode", reason: "source_missing",
      source_type: "missing", deployed_type: "string", source_empty: null, deployed_empty: false }
  ]);
  assert.deepEqual(inspected.content_comparison.definition.unknown_fields, {
    source_count: 0, deployed_count: 0, matches: true
  });
  assert.equal(inspected.content_matches, false);
  assert.doesNotMatch(JSON.stringify(inspected), /Private synthetic|98765|15/);
});

test("inspection distinguishes dropped polling settings and source-established extra settings without accepting them", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_REPRESENTATION";
  await writeFile(join(sourceDirectory, "settings.yml"),
    (await readFile(join(sourceDirectory, "settings.yml"), "utf8")) +
    `polling_headers: |\n  x-functions-key: {{ function_key }}\npolling_body: |\n  {"rules_json": {{ rules_json | json }}}\n`);
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const settings = await readFile(join(cwd, "src", "settings.yml"), "utf8");
      await writeFile(join(cwd, "src", "settings.yml"), settings.replace(
        /polling_headers: \|[\s\S]*$/,
        `polling_headers:\npolling_body: {}\nstatic_data: ''\nserverless_language:\noauth_enabled: false\n${marker}: ${marker}\n`
      ));
    }
  });
  assert.equal(result.content_matches, false);
  assert.deepEqual(result.content_comparison.definition.fields, [
    { field: "polling_headers", reason: "type_mismatch",
      source_type: "string", deployed_type: "null", source_empty: false, deployed_empty: null },
    { field: "polling_body", reason: "type_mismatch",
      source_type: "string", deployed_type: "object", source_empty: false, deployed_empty: true },
    { field: "static_data", reason: "source_missing",
      source_type: "missing", deployed_type: "string", source_empty: null, deployed_empty: true },
    { field: "serverless_language", reason: "source_missing",
      source_type: "missing", deployed_type: "null", source_empty: null, deployed_empty: null },
    { field: "oauth_enabled", reason: "source_missing",
      source_type: "missing", deployed_type: "boolean", source_empty: null, deployed_empty: null }
  ]);
  assert.deepEqual(result.content_comparison.definition.unknown_fields, {
    source_count: 0, deployed_count: 1, matches: false
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(
    `${marker}|function_key|rules_json|x-functions-key|[a-f0-9]{64}`
  ));
});

test("comparison exposes only fixed type and structural-emptiness enums and never equates represented polling settings", async t => {
  const sourceDirectory = await pluginSource(t);
  const base = await readFile(join(sourceDirectory, "settings.yml"), "utf8");
  const original = '  {"rules_json": {{ rules_json | json }}}';
  await writeFile(join(sourceDirectory, "settings.yml"), `${base}polling_body: |\n${original}\n`);
  const markers = {
    object: '{"SYNTHETIC_PRIVATE_KEY": "SYNTHETIC_PRIVATE_VALUE"}',
    array: '["SYNTHETIC_PRIVATE_VALUE"]'
  };
  for (const [yaml, type, empty] of [
    ["", "missing", null], ["polling_body: null\n", "null", null],
    ["polling_body: false\n", "boolean", null], ["polling_body: 0\n", "number", null],
    ['polling_body: ""\n', "string", true], ['polling_body: " "\n', "string", false],
    ["polling_body: {}\n", "object", true], ["polling_body: []\n", "array", true],
    [`polling_body: ${markers.object}\n`, "object", false],
    [`polling_body: ${markers.array}\n`, "array", false],
    ['polling_body: {rules_json: "{{ rules_json | json }}"}\n', "object", false]
  ]) {
    const result = await publisher.inspectTrmnl({
      sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
      runCommand: async (_command, _args, { cwd }) => {
        await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
        await writeFile(join(cwd, "src", "settings.yml"), base + yaml);
      }
    });
    assert.equal(result.content_matches, false, "No type/representation difference is normalized away.");
    assert.deepEqual(result.content_comparison.definition.fields, [{
      field: "polling_body", reason: type === "missing" ? "deployed_missing" :
        type === "string" ? "value_mismatch" : "type_mismatch",
      source_type: "string", deployed_type: type, source_empty: false, deployed_empty: empty
    }]);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|rules_json|[a-f0-9]{64}/);
  }
});

test("known OAuth setting identifiers retain presence, types and mismatches rather than being ignored as metadata", async t => {
  const sourceDirectory = await pluginSource(t);
  const fields = [
    "oauth_auth_params", "oauth_authorization_method", "oauth_authorize_url", "oauth_body_format",
    "oauth_enabled", "oauth_expiry_field_name", "oauth_expiry_strategy", "oauth_fixed_expiry_ms",
    "oauth_pkce_enabled", "oauth_refresh_params", "oauth_refresh_url", "oauth_scope_separator",
    "oauth_scopes", "oauth_token_field_name", "oauth_token_headers", "oauth_token_params",
    "oauth_token_request_auth_method", "oauth_token_response_metadata", "oauth_token_site", "oauth_token_url"
  ];
  const marker = "SYNTHETIC_PRIVATE_OAUTH_VALUE";
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const path = join(cwd, "src", "settings.yml");
      await writeFile(path, (await readFile(path, "utf8")) + fields.map(field => `${field}: ${marker}\n`).join(""));
    }
  });
  assert.equal(result.content_matches, false);
  assert.deepEqual(result.content_comparison.definition.fields, fields.map(field => ({
    field, reason: "source_missing", source_type: "missing", deployed_type: "string",
    source_empty: null, deployed_empty: false
  })));
  assert.deepEqual(result.content_comparison.definition.unknown_fields, {
    source_count: 0, deployed_count: 0, matches: true
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${marker}|[a-f0-9]{64}`));
});

test("publisher type evidence never logs static data, OAuth values or nested names", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_NESTED_VALUE";
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  await assert.rejects(publishTrmnl({
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] !== "pull") return;
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      const path = join(cwd, "src", "settings.yml");
      await writeFile(path, (await readFile(path, "utf8")) +
        `static_data:\n  ${marker}_key: [${marker}]\n` +
        `oauth_token_headers:\n  ${marker}_header: ${marker}\n`);
    }
  }), { code: "trmnl_deployed_content_mismatch" });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].definition.fields, [
    { field: "static_data", reason: "source_missing",
      source_type: "missing", deployed_type: "object", source_empty: null, deployed_empty: false },
    { field: "oauth_token_headers", reason: "source_missing",
      source_type: "missing", deployed_type: "object", source_empty: null, deployed_empty: false }
  ]);
  assert.deepEqual(events[0].definition.unknown_fields, {
    source_count: 0, deployed_count: 0, matches: true
  });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${marker}|[a-f0-9]{64}`));
});

test("file-set comparison reports fixed missing files and only counts for arbitrary filenames", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_FILENAME";
  await writeFile(join(sourceDirectory, `${marker}-source.txt`), "synthetic source");
  const result = await publisher.inspectTrmnl({
    sourceDirectory, pluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, _args, { cwd }) => {
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      await rm(join(cwd, "src", "shared.liquid"));
      await rm(join(cwd, "src", `${marker}-source.txt`));
      await writeFile(join(cwd, "src", `${marker}-remote.txt`), "synthetic remote");
    }
  });
  assert.equal(result.content_matches, false);
  assert.equal(result.content_comparison.file_set_matches, false);
  assert.deepEqual(result.content_comparison.files, [
    { file: "settings.yml", result: "not_compared" },
    { file: "shared.liquid", result: "deployed_missing" },
    { file: "full.liquid", result: "match" },
    { file: "half_horizontal.liquid", result: "match" },
    { file: "half_vertical.liquid", result: "match" }
  ]);
  assert.deepEqual(result.content_comparison.unknown_files, {
    source_count: 1, deployed_count: 1, matches: false
  });
  assert.deepEqual(result.content_comparison.definition, {
    compared: false, fields: [], unknown_fields: null
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${marker}|[a-f0-9]{64}`));
});

test("publisher emits the bounded comparison before retaining the exact mismatch failure", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_VERIFY_CONTENT";
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  const commands = [];
  await assert.rejects(publishTrmnl({
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      commands.push(args[0]);
      if (args[0] !== "pull") return;
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      if (commands.length === 3) {
        await writeFile(join(cwd, "src", "full.liquid"), marker);
        const path = join(cwd, "src", "settings.yml");
        await writeFile(path, (await readFile(path, "utf8")) + `${marker}: ${marker}\n`);
      }
    }
  }), { code: "trmnl_deployed_content_mismatch" });
  assert.deepEqual(commands, ["pull", "push", "pull"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "trmnl_content_comparison");
  assert.equal(events[0].stage, "verify");
  assert.deepEqual(events[0].definition.fields, []);
  assert.deepEqual(events[0].definition.unknown_fields, {
    source_count: 0, deployed_count: 1, matches: false
  });
  assert.equal(events[0].files.find(item => item.file === "full.liquid").result, "different");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(`${marker}|synthetic-key|12345|[a-f0-9]{64}`));
});

test("unknown definition and file content remains part of exact verification but never becomes diagnostic identifiers", async t => {
  const sourceDirectory = await pluginSource(t);
  const marker = "SYNTHETIC_PRIVATE_UNKNOWN_CONTENT";
  const settings = await readFile(join(sourceDirectory, "settings.yml"), "utf8");
  const privateFields = Array.from({ length: 100 }, (_, index) => `${marker}_${index}: source\n`).join("");
  await writeFile(join(sourceDirectory, "settings.yml"), settings + privateFields);
  await writeFile(join(sourceDirectory, `${marker}.liquid`), `${marker}_source`);
  const events = [];
  t.mock.method(console, "error", message => events.push(JSON.parse(message)));
  const options = {
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
    runCommand: async (_command, args, { cwd }) => {
      if (args[0] !== "pull") return;
      await cp(sourceDirectory, join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "settings.yml"), settings + privateFields.replaceAll(": source", ": deployed"));
      await writeFile(join(cwd, "src", `${marker}.liquid`), `${marker}_deployed`);
    }
  };
  const result = await publisher.inspectTrmnl(options);
  assert.equal(result.content_matches, false);
  assert.deepEqual(result.content_comparison.files, [
    { file: "settings.yml", result: "different" },
    { file: "shared.liquid", result: "match" },
    { file: "full.liquid", result: "match" },
    { file: "half_horizontal.liquid", result: "match" },
    { file: "half_vertical.liquid", result: "match" }
  ]);
  assert.deepEqual(result.content_comparison.definition.fields, []);
  assert.deepEqual(result.content_comparison.definition.unknown_fields, {
    source_count: 100, deployed_count: 100, matches: false
  });
  assert.deepEqual(result.content_comparison.unknown_files, {
    source_count: 1, deployed_count: 1, matches: false
  });
  await assert.rejects(publishTrmnl(options), { code: "trmnl_deployed_content_mismatch" });
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify([result, ...events]), new RegExp(`${marker}|[a-f0-9]{64}`));
  assert.ok(JSON.stringify(result.content_comparison).length < 1500, "Output size is independent of unknown names/values.");
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
      backupRecoveryAcceptedPluginId: "12345",
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
    backupRecoveryAcceptedPluginId: "12345",
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
    backupRecoveryAcceptedPluginId: "12345",
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
  }), { message: "trmnl_push_cancelled" });
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
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
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
    sourceDirectory, pluginId: "12345", backupRecoveryAcceptedPluginId: "12345", apiKey: "synthetic-key",
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
