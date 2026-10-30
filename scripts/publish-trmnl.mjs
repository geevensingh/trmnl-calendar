import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pluginIdPattern = /^[1-9][0-9]{0,18}$/;
const execFileAsync = promisify(execFile);
const expectedFiles = [
  "settings.yml",
  "shared.liquid",
  "full.liquid",
  "half_horizontal.liquid",
  "half_vertical.liquid"
];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function filesIn(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("trmnl_source_invalid");
    if (entry.isDirectory()) files.push(...await filesIn(root, path));
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    else fail("trmnl_source_invalid");
  }
  return files.sort();
}

async function digestFiles(root, paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = await readFile(join(root, ...path.split("/")));
    hash.update(path).update("\0").update(bytes).update("\0");
  }
  return hash.digest("hex");
}

async function canonicalSettings(path, signal, code) {
  try {
    const { stdout } = await execFileAsync("ruby", [
      "-rjson", "-ryaml", "-e",
      [
        "def canonical(value)",
        "  case value",
        "  when Hash",
        "    abort unless value.keys.all? { |key| key.is_a?(String) }",
        "    value.keys.sort.to_h { |key| [key, canonical(value.fetch(key))] }",
        "  when Array then value.map { |item| canonical(item) }",
        "  else value",
        "  end",
        "end",
        "value = YAML.safe_load_file(ARGV.fetch(0))",
        "abort unless value.is_a?(Hash)",
        "value.delete('id')",
        "STDOUT.write(JSON.generate(canonical(value)))"
      ].join("\n"),
      path
    ], {
      signal,
      env: publisherEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  } catch {
    fail(code);
  }
}

function fieldSchema(settings) {
  const fields = settings.custom_fields;
  if (!Array.isArray(fields)) fail("trmnl_field_schema_invalid");
  const schema = new Map();
  for (const field of fields) {
    if (!field || typeof field.keyname !== "string" || !field.keyname.trim() ||
      typeof field.field_type !== "string" || !field.field_type.trim() || schema.has(field.keyname)) {
      fail("trmnl_field_schema_invalid");
    }
    schema.set(field.keyname, field.field_type);
  }
  return schema;
}

async function runCli(command, args, env, cwd, runCommand, signal, stage) {
  signal?.throwIfAborted();
  try {
    await (runCommand ?? execFileAsync)(command, args, {
      cwd, env, signal, windowsHide: true, encoding: "utf8",
      timeout: 120_000, maxBuffer: 1024 * 1024
    });
  } catch (error) {
    if (signal?.aborted) fail(`trmnl_${stage}_cancelled`);
    if (error.code === "ENOENT") fail(`trmnl_${stage}_unavailable`);
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail(`trmnl_${stage}_output_limit`);
    if (error.killed) fail(`trmnl_${stage}_timeout`);
    const diagnostic = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    const status = diagnostic.match(
      /failed to (?:download|upload) plugin settings archive: (400|401|403|404|409|422|429|500|502|503|504)\b/
    )?.[1];
    fail(status ? `trmnl_${stage}_http_${status}` : `trmnl_${stage}_failed`);
  }
}

function publisherEnvironment(apiKey) {
  const env = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "GEM_HOME", "GEM_PATH",
    "RUBYOPT", "RUBYLIB", "BUNDLE_GEMFILE", "BUNDLE_PATH", "SystemRoot", "TMP", "TEMP"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (apiKey !== undefined) env.TRMNL_API_KEY = apiKey;
  return env;
}

async function compareContent(source, deployed, sourceFiles, signal) {
  const deployedFiles = await filesIn(deployed);
  if (JSON.stringify(deployedFiles) !== JSON.stringify(sourceFiles)) {
    return { fileSetMatches: false, matches: false };
  }
  const templateFiles = sourceFiles.filter(path => path !== "settings.yml");
  const [sourceTemplatesHash, deployedTemplatesHash, sourceSettings, deployedSettings] = await Promise.all([
    digestFiles(source, templateFiles),
    digestFiles(deployed, templateFiles),
    canonicalSettings(join(source, "settings.yml"), signal, "trmnl_source_settings_invalid"),
    canonicalSettings(join(deployed, "settings.yml"), signal, "trmnl_verify_settings_invalid")
  ]);
  const matches = sourceTemplatesHash === deployedTemplatesHash && sourceSettings === deployedSettings;
  return {
    fileSetMatches: true,
    matches,
    identity: matches ? `sha256:${createHash("sha256")
      .update(deployedTemplatesHash).update("\0").update(deployedSettings).digest("hex")}` : null
  };
}

async function operateTrmnl({
  sourceDirectory,
  pluginId,
  backupRecoveryAcceptedPluginId,
  apiKey = process.env.TRMNL_API_KEY,
  runCommand,
  signal
}, inspecting) {
  if (!pluginIdPattern.test(pluginId ?? "")) fail("trmnl_target_identity_missing");
  if (!inspecting && backupRecoveryAcceptedPluginId !== pluginId) fail("trmnl_backup_approval_missing");
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 512 ||
    /[\s\x00-\x1f\x7f]/.test(apiKey)) fail("trmnl_authentication_missing");

  const source = resolve(sourceDirectory ?? "");
  const sourceFiles = await filesIn(source);
  if (expectedFiles.some(path => !sourceFiles.includes(path))) fail("trmnl_source_invalid");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "trmnl-release-"));
  const workingDirectory = join(temporaryRoot, "plugin");
  const stagedSource = join(workingDirectory, "src");
  try {
    await mkdir(stagedSource, { recursive: true });
    await writeFile(join(workingDirectory, ".trmnlp.yml"),
      "---\nwatch: false\ncustom_fields: {}\n", { flag: "wx" });
    const childEnvironment = publisherEnvironment(apiKey);
    try {
      const sourceSettings = await canonicalSettings(join(source, "settings.yml"), signal,
        "trmnl_source_settings_invalid");
      const expectedSchema = fieldSchema(JSON.parse(sourceSettings));
      await runCli("trmnlp", ["pull", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal, "preflight_pull");
      const deployedSchema = fieldSchema(JSON.parse(
        await canonicalSettings(join(stagedSource, "settings.yml"), signal, "trmnl_preflight_settings_invalid")
      ));
      const compatible = [...deployedSchema].every(([key, type]) => expectedSchema.get(key) === type);
      if (inspecting) {
        const content = await compareContent(source, stagedSource, sourceFiles, signal);
        return {
          operation: "inspect-trmnl", remote_readable: true,
          field_schema_compatible: compatible, content_matches: content.matches
        };
      }
      if (!compatible) fail("trmnl_field_migration_required");
      await rm(stagedSource, { recursive: true });
      await cp(source, stagedSource, { recursive: true, errorOnExist: true, force: false });
      await runCli("trmnlp", ["push", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal, "push");
      await rm(stagedSource, { recursive: true });
      await mkdir(stagedSource);
      await runCli("trmnlp", ["pull", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal, "verify_pull");
    } finally {
      delete childEnvironment.TRMNL_API_KEY;
    }
    const content = await compareContent(source, stagedSource, sourceFiles, signal);
    if (!content.fileSetMatches) fail("trmnl_deployed_file_set_mismatch");
    if (!content.matches) fail("trmnl_deployed_content_mismatch");
    return {
      verified: true,
      identity: content.identity,
      pluginId
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function publishTrmnl(options) {
  return operateTrmnl(options, false);
}

export async function inspectTrmnl(options) {
  return operateTrmnl(options, true);
}
