import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
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

async function canonicalSettings(path, signal) {
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
    fail("trmnl_settings_invalid");
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

function runCli(command, args, env, cwd, runCommand, signal) {
  signal?.throwIfAborted();
  if (runCommand) return runCommand(command, args, { env, cwd, signal });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      signal,
      stdio: "ignore",
      windowsHide: true
    });
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("trmnl_publisher_unavailable"));
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error("trmnl_publish_failed"));
    });
  });
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

export async function publishTrmnl({
  sourceDirectory,
  pluginId,
  backupRecoveryAcceptedPluginId,
  apiKey = process.env.TRMNL_API_KEY,
  runCommand,
  signal
}) {
  if (!pluginIdPattern.test(pluginId ?? "")) fail("trmnl_target_identity_missing");
  if (backupRecoveryAcceptedPluginId !== pluginId) fail("trmnl_backup_approval_missing");
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
      const sourceSettings = await canonicalSettings(join(source, "settings.yml"), signal);
      const expectedSchema = fieldSchema(JSON.parse(sourceSettings));
      await runCli("trmnlp", ["pull", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal);
      const deployedSchema = fieldSchema(JSON.parse(
        await canonicalSettings(join(stagedSource, "settings.yml"), signal)
      ));
      for (const [key, type] of deployedSchema) {
        if (expectedSchema.get(key) !== type) fail("trmnl_field_migration_required");
      }
      await rm(stagedSource, { recursive: true });
      await cp(source, stagedSource, { recursive: true, errorOnExist: true, force: false });
      await runCli("trmnlp", ["push", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal);
      await rm(stagedSource, { recursive: true });
      await mkdir(stagedSource);
      await runCli("trmnlp", ["pull", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand, signal);
    } catch (error) {
      if (["trmnl_field_schema_invalid", "trmnl_field_migration_required"].includes(error?.code)) throw error;
      fail("trmnl_publish_or_verify_failed");
    } finally {
      delete childEnvironment.TRMNL_API_KEY;
    }
    const deployedFiles = await filesIn(stagedSource);
    if (JSON.stringify(deployedFiles) !== JSON.stringify(sourceFiles)) {
      fail("trmnl_deployed_file_set_mismatch");
    }
    const templateFiles = sourceFiles.filter(path => path !== "settings.yml");
    const [sourceTemplatesHash, deployedTemplatesHash] = await Promise.all([
      digestFiles(source, templateFiles),
      digestFiles(stagedSource, templateFiles)
    ]);
    if (deployedTemplatesHash !== sourceTemplatesHash) fail("trmnl_deployed_content_mismatch");
    const [sourceSettings, deployedSettings] = await Promise.all([
      canonicalSettings(join(source, "settings.yml"), signal),
      canonicalSettings(join(stagedSource, "settings.yml"), signal)
    ]);
    if (deployedSettings !== sourceSettings) fail("trmnl_deployed_content_mismatch");
    const deployedHash = createHash("sha256")
      .update(deployedTemplatesHash).update("\0").update(deployedSettings).digest("hex");
    return {
      verified: true,
      identity: `sha256:${deployedHash}`,
      pluginId
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
