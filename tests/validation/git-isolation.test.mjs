import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("public process fixtures preserve exact directory identity under an aliased temporary root", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda temporary identity "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "canonical temporary directory");
  const alias = join(directory, "temporary alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const result = spawnSync(process.execPath, [
    "--test", "--test-name-pattern=completion repository is isolated|runtime precedence is explicit|" +
      "setup ignores inherited project destinations|explicit migration removes unchanged|" +
      "successful display setup preserves|display setup reports failed stages|" +
      "validation scopes certificate and project environments",
    join(root, "tests", "delivery", "completion.test.mjs"),
    join(root, "tests", "validation", "display-toolchain.test.mjs"),
    join(root, "tests", "validation", "hooks.test.mjs"),
    join(root, "tests", "validation", "setup-display.test.mjs"),
    join(root, "tests", "validation", "validation.test.mjs")
  ], {
    cwd: root, env: { ...cleanEnvironment(), TEMP: alias, TMP: alias, TMPDIR: alias },
    encoding: "utf8", timeout: 90_000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\bpass 14\b/, "All affected public process assertions must execute.");
  assert.match(result.stdout, /\bfail 0\b/);
});

test("foreign Git environment removes all inherited Git context and retains explicit safe controls", () => {
  const inherited = {
    PATH: "synthetic tool path", TRMNL_RUBY: "synthetic ruby", BUNDLE_PATH: "synthetic bundle",
    GIT_DIR: "owner metadata", GIT_COMMON_DIR: "owner common", GIT_WORK_TREE: "owner files",
    GIT_INDEX_FILE: "owner index", GIT_OBJECT_DIRECTORY: "owner objects",
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "owner alternates",
    GIT_CONFIG: "owner config", GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_SYSTEM: "inherited system config", GIT_CONFIG_GLOBAL: "inherited global config",
    GIT_TEMPLATE_DIR: "owner hooks template", GIT_SHALLOW_FILE: "owner shallow",
    GIT_REPLACE_REF_BASE: "owner replace refs", GIT_NAMESPACE: "owner namespace",
    GIT_TRACE: "owner trace", GIT_EXEC_PATH: "inherited Git tools", GIT_AUTHOR_NAME: "inherited identity",
    git_dir: "case-insensitive selector", GiT_FUTURE_SELECTOR: "unknown future context"
  };
  const before = { ...inherited };
  const controls = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "fixture config", GIT_TERMINAL_PROMPT: "0" };
  assert.deepEqual(isolatedGitEnvironment(controls, inherited), {
    PATH: inherited.PATH, TRMNL_RUBY: inherited.TRMNL_RUBY, BUNDLE_PATH: inherited.BUNDLE_PATH, ...controls
  });
  assert.deepEqual(inherited, before);
});

function cleanEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(env))
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  return {
    ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0"
  };
}

async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(relative, entry.name);
      files[path] = entry.isDirectory() ? "directory"
        : createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit("");
  return files;
}

async function owner(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda git isolation "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "owner");
  const linked = join(directory, "linked");
  const remote = join(directory, "remote.git");
  await mkdir(checkout);
  const env = cleanEnvironment();
  const git = (cwd, ...args) => {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd, env, encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(checkout, "init", "--quiet", "--initial-branch=main", "--template=");
  git(checkout, "config", "user.name", "Synthetic owner");
  git(checkout, "config", "user.email", "owner@example.invalid");
  git(checkout, "config", "commit.gpgSign", "false");
  await writeFile(join(checkout, "owner.txt"), "Owner baseline\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "Owner baseline");
  git(checkout, "worktree", "add", "--quiet", "-b", "linked", linked);
  git(checkout, "init", "--quiet", "--bare", "--template=", remote);
  const capture = join(directory, "capture.mjs");
  await writeFile(capture, `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ISOLATION_CAPTURE, JSON.stringify(Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.startsWith("GIT_")))));
`);
  const hooks = join(checkout, ".git", "hooks");
  await mkdir(hooks);
  await writeFile(join(hooks, "pre-push"), '#!/bin/sh\nexec node "$ISOLATION_SCRIPT"\n');
  await chmod(join(hooks, "pre-push"), 0o755);
  await mkdir(join(checkout, ".git", "info"));
  const contexts = [];
  for (const cwd of [checkout, linked]) {
    const output = join(directory, `${contexts.length}.json`);
    const result = spawnSync("git", ["push", "--quiet", remote, `HEAD:refs/heads/capture-${contexts.length}`], {
      cwd, env: { ...env, ISOLATION_SCRIPT: capture, ISOLATION_CAPTURE: output },
      encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = JSON.parse(await readFile(output, "utf8"));
    const gitDirectory = git(cwd, "rev-parse", "--absolute-git-dir");
    if (cwd === linked) assert.equal(resolve(cwd, exported.GIT_DIR), resolve(gitDirectory));
    contexts.push({ cwd, exported, gitDirectory });
    await writeFile(join(cwd, "owner.txt"), "Stashed owner work\n");
    git(cwd, "stash", "push", "--quiet", "-m", "Owner stash");
    await writeFile(join(cwd, "owner.txt"), "Staged owner work\n");
    git(cwd, "add", "owner.txt");
    await writeFile(join(cwd, "owner.txt"), "Unstaged owner work\n");
    await writeFile(join(cwd, "untracked.txt"), "Untracked owner work\n");
    await writeFile(join(cwd, "ignored.log"), "Ignored owner output\n");
  }
  await writeFile(join(checkout, ".git", "info", "exclude"), "ignored.log\n");
  const before = [await snapshot(checkout), await snapshot(linked)];
  const unchanged = async label => {
    assert.deepEqual(await snapshot(checkout), before[0], `${label}: owner files/common metadata changed`);
    assert.deepEqual(await snapshot(linked), before[1], `${label}: linked files/HEAD/index changed`);
  };
  const runCase = async (label, action) => {
    await unchanged(`${label}: before`);
    const failures = [];
    let result;
    try {
      result = await action();
    } catch (error) {
      failures.push(error);
    }
    try {
      await unchanged(`${label}: after`);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${label}: child and owner verification failed`);
    return result;
  };
  return { directory, checkout, linked, contexts, git, unchanged, runCase };
}

function injections(owner, context) {
  const selectors = {
    GIT_DIR: context.gitDirectory,
    GIT_COMMON_DIR: join(owner.checkout, ".git"),
    GIT_WORK_TREE: context.cwd,
    GIT_INDEX_FILE: join(context.gitDirectory, "index"),
    GIT_OBJECT_DIRECTORY: join(owner.checkout, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(owner.checkout, ".git", "objects")
  };
  const count = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" };
  const parameters = { GIT_CONFIG_PARAMETERS: "'core.bare=true'" };
  return [
    ["no inherited selectors", {}],
    ["exported pre-push context", context.exported],
    ...Object.entries(selectors).map(([name, value]) => [name, { [name]: value }]),
    ["config pairs", count],
    ["config parameters", parameters],
    ["config file", { GIT_CONFIG: join(owner.checkout, ".git", "config") }],
    ["combined selectors and configuration", { ...context.exported, ...selectors, ...count, ...parameters }]
  ];
}

test("reused owner boundaries reject child contamination before allowing another case", async t => {
  const fixture = await owner(t);
  await assert.rejects(fixture.runCase("contaminating child", () => {
    const result = spawnSync(process.execPath, [
      "-e", "require('node:fs').writeFileSync(process.argv[1], 'Contaminated owner\\n')",
      join(fixture.linked, "owner.txt")
    ], { env: cleanEnvironment(), encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }), /contaminating child: after: linked files\/HEAD\/index changed/);
  let invoked = false;
  await assert.rejects(fixture.runCase("following child", () => { invoked = true; }),
    /following child: before: linked files\/HEAD\/index changed/);
  assert.equal(invoked, false, "A contaminated owner must not reach another public process.");
});

test("reused owner boundaries retain both child failure and owner corruption evidence", async t => {
  const fixture = await owner(t);
  await assert.rejects(fixture.runCase("failed contaminating child", () => {
    const result = spawnSync(process.execPath, [
      "-e", "require('node:fs').writeFileSync(process.argv[1], 'Corrupted index'); process.exit(23)",
      join(fixture.contexts[0].gitDirectory, "index")
    ], { env: cleanEnvironment(), encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, "Synthetic public child exited 23.");
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /Synthetic public child exited 23/);
    assert.match(error.errors[1].message, /after: owner files\/common metadata changed/);
    return true;
  });
});

test("reused owner boundaries preserve child exit and timeout results and clean owned state", async t => {
  let ownedDirectory;
  const unrelated = await mkdtemp(join(tmpdir(), "agenda unrelated owner "));
  t.after(() => rm(unrelated, { recursive: true, force: true }));
  await writeFile(join(unrelated, "sentinel.txt"), "Unrelated work\n");
  await t.test("failed and timed out children leave the owner reusable", async t => {
    const fixture = await owner(t);
    ownedDirectory = fixture.directory;
    const failed = await fixture.runCase("failed child", () => spawnSync(process.execPath, [
      "-e", "process.stderr.write('Synthetic child failure'); process.exit(23)"
    ], { env: cleanEnvironment(), encoding: "utf8", timeout: 10_000 }));
    assert.equal(failed.status, 23);
    assert.equal(failed.stderr, "Synthetic child failure");
    const timedOut = await fixture.runCase("timed out child", () => spawnSync(process.execPath, [
      "-e", "setInterval(() => {}, 1000)"
    ], { env: cleanEnvironment(), encoding: "utf8", timeout: 200 }));
    assert.equal(timedOut.error?.code, "ETIMEDOUT");
    assert.equal(timedOut.status, null);
    assert.equal(timedOut.signal, "SIGTERM");
    assert.throws(() => process.kill(timedOut.pid, 0), { code: "ESRCH" },
      "The timed out owned child must have exited.");
    const result = await fixture.runCase("following completion fixture", () => spawnSync(process.execPath, [
      "--test", "--test-name-pattern=^completion repository is isolated",
      join(root, "tests", "delivery", "completion.test.mjs")
    ], { cwd: root, env: { ...cleanEnvironment(), ...fixture.contexts[1].exported },
      encoding: "utf8", timeout: 30_000 }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\bpass 1\b/, "The real fixture must still execute after failed children.");
  });
  await assert.rejects(readdir(ownedDirectory), { code: "ENOENT" });
  assert.equal(await readFile(join(unrelated, "sentinel.txt"), "utf8"), "Unrelated work\n");
});

test("completion fixture preserves standard and linked owners under exported hook context and selectors", async t => {
  const fixture = await owner(t);
  for (const index of [0, 1]) {
    for (const [name, injection] of injections(fixture, fixture.contexts[index])) {
      const label = `${index === 1 ? "linked" : "standard"}: ${name}`;
      await t.test(label, () => fixture.runCase(label, () => {
        const result = spawnSync(process.execPath, [
          "--test", "--test-name-pattern=^completion repository is isolated", join(root, "tests", "delivery", "completion.test.mjs")
        ], { cwd: root, env: { ...cleanEnvironment(), ...injection }, encoding: "utf8", timeout: 30_000 });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /\bpass 1\b/, "The actual completion fixture test must execute.");
      }));
    }
  }
});

test("review snapshot fixture preserves synthetic owners under combined inherited Git context", async t => {
  for (const index of [0, 1]) {
    await t.test(index === 1 ? "linked owner" : "standard owner", async t => {
      const fixture = await owner(t);
      const injection = {
        ...injections(fixture, fixture.contexts[index]).at(-1)[1],
        GIT_TEMPLATE_DIR: join(fixture.checkout, ".git"),
        GIT_NAMESPACE: "owner-namespace",
        GIT_REPLACE_REF_BASE: "refs/owner-replacements/",
        GIT_TRACE: join(fixture.checkout, "trace.log"),
        GIT_TRACE2_EVENT: join(fixture.checkout, "trace2.log"),
        GiT_FUTURE_SELECTOR: "unknown inherited context"
      };
      const result = spawnSync(process.execPath, [
        "--test", "--test-name-pattern=^uncommitted-only review", join(root, "tests", "validation", "review-scope.test.mjs")
      ], { cwd: root, env: { ...cleanEnvironment(), ...injection }, encoding: "utf8", timeout: 30_000 });
      await fixture.unchanged("review snapshot fixture");
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /\bpass 1\b/, "The actual review snapshot and commit-binding example must execute.");
    });
  }
});

test("Workbench Git fixture preserves standard and linked owners under exported hook context and selectors", async t => {
  const fixture = await owner(t);
  for (const index of [0, 1]) {
    for (const [name, injection] of injections(fixture, fixture.contexts[index])) {
      const label = `${index === 1 ? "linked" : "standard"}: ${name}`;
      await t.test(label, () => fixture.runCase(label, () => {
        const result = spawnSync("dotnet", [
          "test", join(root, "tests", "CalendarAgenda.Tests", "CalendarAgenda.Tests.csproj"),
          "--no-build", "--no-restore", "--nologo", "--verbosity", "quiet",
          "--filter", "FullyQualifiedName~Git_fixture_is_independent"
        ], {
          cwd: root, env: { ...cleanEnvironment(), ...injection, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false" },
          encoding: "utf8", timeout: 30_000
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Passed:\s+1\b/, "Build the Workbench isolation regression before this check.");
      }));
    }
  }
});

test("public Workbench reads its explicit foreign workspace, not the inherited owner baseline", async t => {
  const fixture = await owner(t);
  const workspace = join(fixture.directory, "foreign workspace");
  for (const directory of ["docs", "display/src"]) await mkdir(join(workspace, directory), { recursive: true });
  fixture.git(workspace, "init", "--quiet", "--initial-branch=main", "--template=");
  await writeFile(join(workspace, "docs", "agenda-contract.md"), "# Agenda HTTP and display contract, version 999\n");
  await writeFile(join(workspace, "display", "render.rb"), "Synthetic incompatible renderer\n");
  for (const name of ["shared", "full", "half_horizontal", "half_vertical"])
    await writeFile(join(workspace, "display", "src", `${name}.liquid`), "Synthetic template\n");
  fixture.git(workspace, "add", ".");
  fixture.git(workspace, "-c", "user.name=Synthetic fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "Foreign baseline");
  const baseline = fixture.git(workspace, "rev-parse", "HEAD");
  for (const context of fixture.contexts) {
    const injection = injections(fixture, context).at(-1)[1];
    const result = spawnSync(process.execPath, [
      join(root, "scripts", "agenda-workbench.mjs"), "--workspace", workspace, "--port", "0"
    ], { cwd: root, env: { ...cleanEnvironment(), ...injection }, encoding: "utf8", timeout: 15_000 });
    await fixture.unchanged("public Workbench");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`Incompatible baseline ${baseline}:`), result.stderr);
  }
});
