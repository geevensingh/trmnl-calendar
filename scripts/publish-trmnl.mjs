import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function canonicalSettings(path) {
  try {
    const { stdout } = await execFileAsync("ruby", [
      "-rjson", "-ryaml", "-e",
      "value = YAML.safe_load_file(ARGV.fetch(0)); abort unless value.is_a?(Hash); value.delete('id'); STDOUT.write(JSON.generate(value))",
      path
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return stdout;
  } catch {
    fail("trmnl_settings_invalid");
  }
}

function runCli(command, args, env, cwd, runCommand) {
  if (runCommand) return runCommand(command, args, { env, cwd });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
    "RUBYOPT", "BUNDLE_GEMFILE", "BUNDLE_PATH"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.TRMNL_API_KEY = apiKey;
  return env;
}

export async function publishTrmnl({
  sourceDirectory,
  pluginId,
  preservationVerifiedPluginId,
  apiKey = process.env.TRMNL_API_KEY,
  runCommand
}) {
  if (!pluginIdPattern.test(pluginId ?? "")) fail("trmnl_target_identity_missing");
  if (preservationVerifiedPluginId !== pluginId) fail("trmnl_preservation_gate_missing");
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 512 ||
    /[\s\x00-\x1f\x7f]/.test(apiKey)) fail("trmnl_authentication_missing");

  const source = resolve(sourceDirectory ?? "");
  const sourceFiles = await filesIn(source);
  if (expectedFiles.some(path => !sourceFiles.includes(path))) fail("trmnl_source_invalid");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "trmnl-release-"));
  const workingDirectory = join(temporaryRoot, "plugin");
  const stagedSource = join(workingDirectory, "src");
  try {
    await cp(source, stagedSource, { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(workingDirectory, ".trmnlp.yml"),
      "---\nwatch: false\ncustom_fields: {}\n", { flag: "wx" });
    const childEnvironment = publisherEnvironment(apiKey);
    try {
      await runCli("trmnlp", ["push", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand);
      await runCli("trmnlp", ["pull", "--force", "--id", pluginId],
        childEnvironment, workingDirectory, runCommand);
    } catch {
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
      canonicalSettings(join(source, "settings.yml")),
      canonicalSettings(join(stagedSource, "settings.yml"))
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
