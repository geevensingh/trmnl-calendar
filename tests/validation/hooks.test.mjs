import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hookNames = ["pre-commit", "pre-merge-commit", "pre-push"];

async function repository(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agenda hook migration ")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout with ' quotes");
  const template = join(directory, "empty-template");
  const globalConfig = join(directory, "global.gitconfig");
  const calls = join(directory, "validation.log");
  await mkdir(checkout);
  await mkdir(template);
  await writeFile(globalConfig, "");
  const environment = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", HOOK_CALLS: calls
  });
  const git = (arguments_, cwd = checkout) => spawnSync("git", ["--no-pager", ...arguments_], {
    cwd, env: environment, encoding: "utf8", timeout: 30_000
  });
  const checked = (arguments_, cwd = checkout) => {
    const result = git(arguments_, cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  checked(["init", "--quiet", "--initial-branch=main", `--template=${template}`]);
  checked(["config", "user.name", "Synthetic maintainer"]);
  checked(["config", "user.email", "synthetic@example.invalid"]);
  checked(["config", "commit.gpgSign", "false"]);
  await cp(join(root, "scripts"), join(checkout, "scripts"), { recursive: true });
  await writeFile(join(checkout, "scripts", "validate.ps1"), String.raw`
param([string]$Scope)
"$Scope|$((Get-Location).Path)" | Add-Content -LiteralPath $env:HOOK_CALLS
exit 37
`);
  await writeFile(join(checkout, "fixture.txt"), "synthetic initial content\n");
  checked(["add", "."]);
  checked(["commit", "--quiet", "-m", "Synthetic initial commit"]);
  const hooks = checked(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const seedLegacyHooks = async () => {
    // Frozen v1 output, independent of the migration implementation.
    const legacy = (await readFile(join(root, "tests", "validation", "fixtures", "legacy-validation-hook.sh"), "utf8"))
      .replaceAll("\r\n", "\n");
    await mkdir(hooks, { recursive: true });
    for (const name of hookNames) {
      const path = join(hooks, name);
      await writeFile(path, legacy.replaceAll("__SCOPE__", name === "pre-push" ? "Full" : "Fast"));
      await chmod(path, 0o755);
    }
  };
  const createRemote = () => {
    const remote = join(directory, "local remote.git");
    checked(["init", "--bare", "--quiet", `--template=${template}`, remote]);
    return remote;
  };
  const manage = (action, cwd = checkout) => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", join(cwd, "scripts", "git-hooks.ps1"),
    ...(action ? ["-Action", action] : [])
  ], { cwd, env: environment, encoding: "utf8", timeout: 30_000 });
  const absentHooks = async () => {
    for (const name of hookNames)
      await assert.rejects(readFile(join(hooks, name)), { code: "ENOENT" });
  };
  return {
    directory, checkout, hooks, calls, globalConfig, git, checked, createRemote, manage, seedLegacyHooks, absentHooks
  };
}

test("retired hook installation fails with manual-validation and migration guidance without creating hooks", async t => {
  const fixture = await repository(t);
  const configuration = fixture.checked(["config", "--local", "--list"]);
  const result = fixture.manage("Install");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /retired/);
  assert.match(result.stderr, /validate\.ps1/);
  assert.match(result.stderr, /-Action Remove/);
  await fixture.absentHooks();
  assert.equal(fixture.checked(["config", "--local", "--list"]), configuration);
  assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
});

test("status is read-only and removal is repeatable on a checkout that never installed managed hooks", async t => {
  const fixture = await repository(t);
  const configuration = fixture.checked(["config", "--local", "--list"]);
  const status = fixture.manage();
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /Automatic hooks are retired/);
  for (let repeat = 0; repeat < 2; repeat++) {
    const remove = fixture.manage("Remove");
    assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  }
  await fixture.absentHooks();
  assert.equal(fixture.checked(["config", "--local", "--list"]), configuration);
  assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
});

test("explicit migration removes unchanged v1 hooks, after which commit, merge and push no longer invoke validation", async t => {
  const fixture = await repository(t);
  fixture.checked(["switch", "--quiet", "-c", "synthetic-feature"]);
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Synthetic feature"]);
  fixture.checked(["switch", "--quiet", "main"]);
  await fixture.seedLegacyHooks();
  const configuration = fixture.checked(["config", "--local", "--list"]);
  const installed = await Promise.all(hookNames.map(name => readFile(join(fixture.hooks, name))));
  const status = fixture.manage();
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /Managed/);
  assert.deepEqual(await Promise.all(hookNames.map(name => readFile(join(fixture.hooks, name)))), installed);
  const rejected = fixture.git(["commit", "--allow-empty", "--quiet", "-m", "Old hook still active"]);
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
  assert.equal((await readFile(fixture.calls, "utf8")).trim(), `Fast|${fixture.checkout}`);
  await rm(fixture.calls);
  await writeFile(join(fixture.hooks, "unrelated.txt"), "preserve this file");
  for (let repeat = 0; repeat < 2; repeat++) {
    const remove = fixture.manage("Remove");
    assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  }
  await fixture.absentHooks();
  assert.equal(await readFile(join(fixture.hooks, "unrelated.txt"), "utf8"), "preserve this file");
  assert.equal(fixture.checked(["config", "--local", "--list"]), configuration);
  assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "No automatic commit validation"]);
  fixture.checked(["merge", "--no-ff", "--no-edit", "synthetic-feature"]);
  const remote = fixture.createRemote();
  fixture.checked(["push", "--quiet", remote, "HEAD:refs/heads/synthetic"]);
  assert.equal(
    fixture.checked(["--git-dir", remote, "rev-parse", "refs/heads/synthetic"]),
    fixture.checked(["rev-parse", "HEAD"])
  );
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
});

test("foreign hooks are preserved and partial removal is reported for every formerly managed hook name", async t => {
  for (const name of hookNames) {
    const fixture = await repository(t);
    await fixture.seedLegacyHooks();
    const original = "#!/bin/sh\n# Existing maintainer hook\nexit 0\n";
    await writeFile(join(fixture.hooks, name), original);
    const remove = fixture.manage("Remove");
    assert.notEqual(remove.status, 0, remove.stdout + remove.stderr);
    assert.match(remove.stderr, /Removal was partial/);
    assert.equal(await readFile(join(fixture.hooks, name), "utf8"), original);
    for (const other of hookNames.filter(hook => hook !== name))
      await assert.rejects(readFile(join(fixture.hooks, other)), { code: "ENOENT" });
    assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
  }
});

test("edited v1 hooks are preserved while unchanged managed hooks are removed", async t => {
  const fixture = await repository(t);
  await fixture.seedLegacyHooks();
  const path = join(fixture.hooks, "pre-commit");
  const edited = (await readFile(path, "utf8")) + "# Maintainer addition\n";
  await writeFile(path, edited);
  for (let repeat = 0; repeat < 2; repeat++) {
    const remove = fixture.manage("Remove");
    assert.notEqual(remove.status, 0, remove.stdout + remove.stderr);
    assert.match(remove.stderr, /Removal was partial/);
    assert.equal(await readFile(path, "utf8"), edited);
  }
  for (const name of ["pre-merge-commit", "pre-push"])
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
});

test("effective local, global and worktree hook paths and their hook files survive default-hook migration", async t => {
  for (const scope of ["local", "global", "worktree"]) {
    const fixture = await repository(t);
    await fixture.seedLegacyHooks();
    const configured = join(fixture.directory, "maintainer hooks");
    await mkdir(configured);
    await writeFile(join(configured, "pre-commit"), "maintainer-owned bytes");
    if (scope === "worktree") fixture.checked(["config", "extensions.worktreeConfig", "true"]);
    fixture.checked(["config", `--${scope}`, "core.hooksPath", configured]);
    const beforeLocal = fixture.checked(["config", "--local", "--list"]);
    const beforeGlobal = await readFile(fixture.globalConfig, "utf8");
    const beforeEffective = fixture.checked(["config", "--show-origin", "--get", "core.hooksPath"]);
    const remove = fixture.manage("Remove");
    assert.equal(remove.status, 0, remove.stdout + remove.stderr);
    assert.match(remove.stdout, /Existing core\.hooksPath preserved/);
    await fixture.absentHooks();
    assert.equal(await readFile(join(configured, "pre-commit"), "utf8"), "maintainer-owned bytes");
    assert.equal(fixture.checked(["config", "--local", "--list"]), beforeLocal);
    assert.equal(await readFile(fixture.globalConfig, "utf8"), beforeGlobal);
    assert.equal(fixture.checked(["config", "--show-origin", "--get", "core.hooksPath"]), beforeEffective);
  }
});

test("migration from a linked worktree removes shared common hooks for both checkouts", async t => {
  const fixture = await repository(t);
  const linked = join(fixture.directory, "linked checkout with spaces");
  fixture.checked(["worktree", "add", "--quiet", "-b", "linked-validation", linked]);
  await fixture.seedLegacyHooks();
  const remove = fixture.manage("Remove", linked);
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.match(remove.stdout, /shared by linked worktrees/);
  await fixture.absentHooks();
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Linked commit"], linked);
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Other checkout commit"]);
  const remote = fixture.createRemote();
  fixture.checked(["push", "--quiet", remote, "HEAD:refs/heads/linked"], linked);
  fixture.checked(["push", "--quiet", remote, "HEAD:refs/heads/other"]);
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
});

test("a linked default hooks directory is preserved instead of followed during migration", async t => {
  const fixture = await repository(t);
  const target = join(fixture.directory, "maintainer hook directory");
  await mkdir(target);
  await writeFile(join(target, "pre-commit"), "maintainer-owned bytes");
  await symlink(target, fixture.hooks, process.platform === "win32" ? "junction" : "dir");
  const result = fixture.manage("Remove");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Preserved nonstandard hooks path/);
  assert.equal(await readFile(join(target, "pre-commit"), "utf8"), "maintainer-owned bytes");
  await assert.rejects(readFile(join(target, "pre-push")), { code: "ENOENT" });
});

test("linked entries at managed hook names are preserved and report partial removal", async t => {
  const fixture = await repository(t);
  await fixture.seedLegacyHooks();
  const target = join(fixture.directory, "maintainer target");
  await mkdir(target);
  await writeFile(join(target, "sentinel"), "untouched");
  const path = join(fixture.hooks, "pre-commit");
  await rm(path);
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  const result = fixture.manage("Remove");
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Removal was partial/);
  assert.equal(await readFile(join(path, "sentinel"), "utf8"), "untouched");
  for (const name of ["pre-merge-commit", "pre-push"])
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
});
