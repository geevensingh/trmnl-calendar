import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hookNames = ["pre-commit", "pre-merge-commit", "pre-push"];

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda hooks "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout with ' quotes");
  const template = join(directory, "empty-template");
  const globalConfig = join(directory, "global.gitconfig");
  const calls = join(directory, "validation.log");
  await mkdir(checkout);
  await mkdir(template);
  await writeFile(globalConfig, "");
  const environment = { ...process.env };
  for (const key of Object.keys(environment))
    if (key.startsWith("GIT_")) delete environment[key];
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", HOOK_CALLS: calls, HOOK_FAIL_SCOPE: "", HOOK_MUTATION: ""
  });
  const git = (arguments_, overrides = {}, cwd = checkout) => spawnSync("git", ["--no-pager", ...arguments_], {
    cwd, env: { ...environment, ...overrides }, encoding: "utf8", timeout: 30_000
  });
  const checked = (arguments_, overrides = {}, cwd = checkout) => {
    const result = git(arguments_, overrides, cwd);
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
if ($env:HOOK_FAIL_SCOPE -eq $Scope) { exit 37 }
if ($Scope -eq 'Full' -and $env:HOOK_MUTATION -eq 'dirty') {
    'Synthetic concurrent edit' | Add-Content -LiteralPath (Join-Path (Get-Location) 'fixture.txt')
}
if ($Scope -eq 'Full' -and $env:HOOK_MUTATION -eq 'head') {
    git commit --allow-empty --quiet -m 'Synthetic concurrent HEAD change'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
exit 0
`);
  await writeFile(join(checkout, "fixture.txt"), "synthetic initial content\n");
  checked(["add", "."]);
  checked(["commit", "--quiet", "-m", "Synthetic initial commit"]);
  const hooks = checked(["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  const createRemote = () => {
    const remote = join(directory, "local remote.git");
    checked(["init", "--bare", "--quiet", remote]);
    return remote;
  };
  const manage = (action, cwd = checkout) => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", join(cwd, "scripts", "git-hooks.ps1"),
    ...(action ? ["-Action", action] : [])
  ], { cwd, env: environment, encoding: "utf8", timeout: 30_000 });
  return { directory, checkout, hooks, calls, globalConfig, git, checked, createRemote, manage };
}

test("hook management is opt-in, repeatable, and removes only its hooks without changing Git configuration", async t => {
  const fixture = await repository(t);
  const configuration = fixture.checked(["config", "--local", "--list"]);
  const status = fixture.manage();
  assert.equal(status.status, 0, status.stdout + status.stderr);
  for (const name of hookNames)
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Not opted in"], { HOOK_FAIL_SCOPE: "Fast" });
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });

  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const installed = await Promise.all(hookNames.map(name => readFile(join(fixture.hooks, name), "utf8")));
  const repeat = fixture.manage("Install");
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.deepEqual(await Promise.all(hookNames.map(name => readFile(join(fixture.hooks, name), "utf8"))), installed);
  await writeFile(join(fixture.hooks, "unrelated.txt"), "preserve this file");

  for (let repeat = 0; repeat < 2; repeat++) {
    const remove = fixture.manage("Remove");
    assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  }
  for (const name of hookNames)
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
  assert.equal(await readFile(join(fixture.hooks, "unrelated.txt"), "utf8"), "preserve this file");
  assert.equal(fixture.checked(["config", "--local", "--list"]), configuration);
  assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Removed opt-in"], { HOOK_FAIL_SCOPE: "Fast" });
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
});

test("pre-commit invokes Fast in the current checkout and blocks failed validation but allows success", async t => {
  const fixture = await repository(t);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const before = fixture.checked(["rev-parse", "HEAD"]);
  await writeFile(join(fixture.checkout, "fixture.txt"), "synthetic changed content\n");
  fixture.checked(["add", "fixture.txt"]);
  const rejected = fixture.git(["commit", "--quiet", "-m", "Must be blocked"], { HOOK_FAIL_SCOPE: "Fast" });
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
  assert.equal(fixture.checked(["rev-parse", "HEAD"]), before);
  fixture.checked(["commit", "--quiet", "-m", "Validation passed"]);
  assert.notEqual(fixture.checked(["rev-parse", "HEAD"]), before);
  const calls = (await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/);
  assert.deepEqual(calls, [`Fast|${fixture.checkout}`, `Fast|${fixture.checkout}`]);
});

test("pre-push runs Full and propagates failure before publishing to a disposable local remote", async t => {
  const fixture = await repository(t);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const remote = fixture.createRemote();
  const arguments_ = ["push", "--quiet", remote, "HEAD:refs/heads/main"];
  const rejected = fixture.git(arguments_, { HOOK_FAIL_SCOPE: "Full" });
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
  assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).status, 0);
  fixture.checked(arguments_);
  assert.equal(
    fixture.checked(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    fixture.checked(["rev-parse", "HEAD"])
  );
  assert.deepEqual((await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/),
    [`Full|${fixture.checkout}`, `Full|${fixture.checkout}`]);
});

test("pre-existing hooks are preserved and conflicts do not cause partial installation", async t => {
  for (const name of hookNames) {
    const fixture = await repository(t);
    await mkdir(fixture.hooks, { recursive: true });
    const original = "#!/bin/sh\n# Existing maintainer hook\nexit 0\n";
    await writeFile(join(fixture.hooks, name), original);
    const install = fixture.manage("Install");
    assert.notEqual(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stderr, /hooks preserved/);
    assert.equal(await readFile(join(fixture.hooks, name), "utf8"), original);
    for (const untouched of hookNames.filter(hook => hook !== name))
      await assert.rejects(readFile(join(fixture.hooks, untouched)), { code: "ENOENT" });
    assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
  }
});

test("existing hook-path configuration is reported without changing local, global, or configured hooks", async t => {
  for (const scope of ["local", "global", "worktree"]) {
    const fixture = await repository(t);
    const configured = join(fixture.directory, "maintainer hooks");
    await mkdir(configured);
    await writeFile(join(configured, "pre-commit"), "maintainer-owned bytes");
    if (scope === "worktree") fixture.checked(["config", "extensions.worktreeConfig", "true"]);
    fixture.checked(["config", `--${scope}`, "core.hooksPath", configured]);
    const beforeLocal = fixture.checked(["config", "--local", "--list"]);
    const beforeGlobal = await readFile(fixture.globalConfig, "utf8");
    const status = fixture.manage();
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, /Existing core\.hooksPath preserved/);
    const install = fixture.manage("Install");
    assert.notEqual(install.status, 0, install.stdout + install.stderr);
    assert.match(install.stderr, /Refusing installation while core\.hooksPath is configured/);
    const remove = fixture.manage("Remove");
    assert.equal(remove.status, 0, remove.stdout + remove.stderr);
    assert.equal(await readFile(join(configured, "pre-commit"), "utf8"), "maintainer-owned bytes");
    assert.equal(fixture.checked(["config", "--local", "--list"]), beforeLocal);
    assert.equal(await readFile(fixture.globalConfig, "utf8"), beforeGlobal);
    for (const name of hookNames)
      await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
  }
});

test("edited managed hooks are neither overwritten nor deleted, while unchanged owned hooks can be removed", async t => {
  const fixture = await repository(t);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const path = join(fixture.hooks, "pre-commit");
  const edited = (await readFile(path, "utf8")) + "# Maintainer addition\n";
  await writeFile(path, edited);
  const repeat = fixture.manage("Install");
  assert.notEqual(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.equal(await readFile(path, "utf8"), edited);
  const remove = fixture.manage("Remove");
  assert.notEqual(remove.status, 0, remove.stdout + remove.stderr);
  assert.match(remove.stderr, /Removal was partial/);
  assert.equal(await readFile(path, "utf8"), edited);
  for (const name of ["pre-merge-commit", "pre-push"])
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
});

test("installation from a linked worktree shares hooks but validates the checkout performing each operation", async t => {
  const fixture = await repository(t);
  const linked = join(fixture.directory, "linked checkout with spaces");
  fixture.checked(["worktree", "add", "--quiet", "-b", "linked-validation", linked]);
  const install = fixture.manage("Install", linked);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Linked commit"], {}, linked);
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Main checkout commit"]);
  assert.deepEqual((await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/),
    [`Fast|${linked}`, `Fast|${fixture.checkout}`]);
  const repeat = fixture.manage("Install");
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  const remove = fixture.manage("Remove", linked);
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  for (const name of hookNames)
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Shared hooks removed"], { HOOK_FAIL_SCOPE: "Fast" });
  assert.equal((await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/).length, 2);
});

test("direct merge commits run Fast, block failure, and remain supported without pull requests", async t => {
  const fixture = await repository(t);
  fixture.checked(["switch", "--quiet", "-c", "synthetic-feature"]);
  await writeFile(join(fixture.checkout, "feature.txt"), "synthetic feature\n");
  fixture.checked(["add", "feature.txt"]);
  fixture.checked(["commit", "--quiet", "-m", "Synthetic feature"]);
  fixture.checked(["switch", "--quiet", "main"]);
  const before = fixture.checked(["rev-parse", "HEAD"]);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const arguments_ = ["merge", "--no-ff", "--no-edit", "synthetic-feature"];
  const rejected = fixture.git(arguments_, { HOOK_FAIL_SCOPE: "Fast" });
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
  assert.equal(fixture.checked(["rev-parse", "HEAD"]), before);
  fixture.checked(["merge", "--abort"]);
  fixture.checked(arguments_);
  assert.notEqual(fixture.checked(["rev-parse", "HEAD"]), before);
  assert.deepEqual((await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/),
    [`Fast|${fixture.checkout}`, `Fast|${fixture.checkout}`]);
});

test("a missing validation entrypoint blocks both commit and publication with recovery guidance", async t => {
  const fixture = await repository(t);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  await rm(join(fixture.checkout, "scripts", "validate.ps1"));
  const remote = fixture.createRemote();
  for (const arguments_ of [
    ["commit", "--allow-empty", "--quiet", "-m", "Missing validator"],
    ["push", "--quiet", remote, "HEAD:refs/heads/main"]
  ]) {
    const result = fixture.git(arguments_);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Missing scripts\\validate\.ps1/);
    assert.match(result.stderr, /Restore it or remove the opt-in hooks/);
  }
  assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).status, 0);
});

test("a linked default hooks directory is preserved instead of followed during installation or removal", async t => {
  const fixture = await repository(t);
  const target = join(fixture.directory, "maintainer hook directory");
  await mkdir(target);
  await writeFile(join(target, "pre-commit"), "maintainer-owned bytes");
  await symlink(target, fixture.hooks, process.platform === "win32" ? "junction" : "dir");
  for (const action of ["Install", "Remove"]) {
    const result = fixture.manage(action);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Preserved nonstandard hooks path/);
  }
  assert.equal(await readFile(join(target, "pre-commit"), "utf8"), "maintainer-owned bytes");
  await assert.rejects(readFile(join(target, "pre-push")), { code: "ENOENT" });
});

test("removal cleans owned default hooks even after hook-path configuration changes, without touching the new path", async t => {
  const fixture = await repository(t);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const configured = join(fixture.directory, "new maintainer hooks");
  await mkdir(configured);
  await writeFile(join(configured, "pre-push"), "new maintainer-owned bytes");
  fixture.checked(["config", "core.hooksPath", configured]);
  const remove = fixture.manage("Remove");
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.match(remove.stdout, /Existing core\.hooksPath preserved/);
  for (const name of hookNames)
    await assert.rejects(readFile(join(fixture.hooks, name)), { code: "ENOENT" });
  assert.equal(fixture.checked(["config", "--get", "core.hooksPath"]), configured);
  assert.equal(await readFile(join(configured, "pre-push"), "utf8"), "new maintainer-owned bytes");
  assert.equal(await readFile(fixture.globalConfig, "utf8"), "");
});

test("pre-push refuses dirty tracked, staged, and untracked files before claiming validation success", async t => {
  for (const change of ["tracked", "staged", "untracked"]) {
    const fixture = await repository(t);
    const install = fixture.manage("Install");
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const remote = fixture.createRemote();
    await writeFile(join(fixture.checkout, change === "untracked" ? "new-file.txt" : "fixture.txt"),
      "synthetic pending change\n");
    if (change === "staged") fixture.checked(["add", "fixture.txt"]);
    const result = fixture.git(["push", "--quiet", remote, "HEAD:refs/heads/main"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /Publication requires a clean checkout/);
    await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
    assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).status, 0);
  }
});

test("pre-push rejects publishing a different revision even when the current checkout is clean", async t => {
  const fixture = await repository(t);
  fixture.checked(["branch", "other-revision"]);
  await writeFile(join(fixture.checkout, "fixture.txt"), "synthetic newer checkout\n");
  fixture.checked(["add", "fixture.txt"]);
  fixture.checked(["commit", "--quiet", "-m", "Advance checked-out HEAD"]);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const remote = fixture.createRemote();
  const rejected = fixture.git(["push", "--quiet", remote, "other-revision:refs/heads/other"]);
  assert.notEqual(rejected.status, 0, rejected.stdout + rejected.stderr);
  assert.match(rejected.stderr, /Only the checked-out HEAD can be published/);
  await assert.rejects(readFile(fixture.calls), { code: "ENOENT" });
  fixture.checked(["push", "--quiet", remote, "HEAD:refs/heads/main"]);
  assert.equal(
    fixture.checked(["--git-dir", remote, "rev-parse", "refs/heads/main"]),
    fixture.checked(["rev-parse", "HEAD"])
  );
  assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/heads/other"]).status, 0);
});

test("pre-push rejects checkout or HEAD changes made during otherwise successful validation", async t => {
  for (const mutation of ["dirty", "head"]) {
    const fixture = await repository(t);
    const install = fixture.manage("Install");
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const remote = fixture.createRemote();
    const result = fixture.git(["push", "--quiet", remote, "HEAD:refs/heads/main"], { HOOK_MUTATION: mutation });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, mutation === "dirty" ? /Publication requires a clean checkout/ : /HEAD changed during full validation/);
    assert.match(await readFile(fixture.calls, "utf8"), /Full\|/);
    assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]).status, 0);
  }
});

test("pre-push supports tags of HEAD and deletions but rejects mixed updates containing a different commit", async t => {
  const fixture = await repository(t);
  fixture.checked(["branch", "older-revision"]);
  fixture.checked(["commit", "--allow-empty", "--quiet", "-m", "Advance current HEAD"]);
  fixture.checked(["tag", "-a", "synthetic-head", "-m", "Synthetic annotated tag"]);
  const install = fixture.manage("Install");
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const remote = fixture.createRemote();
  fixture.checked(["push", "--quiet", remote, "refs/tags/synthetic-head:refs/tags/synthetic-head"]);
  assert.equal(
    fixture.checked(["--git-dir", remote, "rev-parse", "refs/tags/synthetic-head^{commit}"]),
    fixture.checked(["rev-parse", "HEAD"])
  );
  fixture.checked(["push", "--quiet", remote, ":refs/tags/synthetic-head"]);
  assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", "refs/tags/synthetic-head"]).status, 0);
  const mixed = fixture.git(["push", "--quiet", remote, "HEAD:refs/heads/main", "older-revision:refs/heads/other"]);
  assert.notEqual(mixed.status, 0, mixed.stdout + mixed.stderr);
  assert.match(mixed.stderr, /Only the checked-out HEAD can be published/);
  for (const name of ["main", "other"])
    assert.notEqual(fixture.git(["--git-dir", remote, "rev-parse", "--verify", `refs/heads/${name}`]).status, 0);
  assert.deepEqual((await readFile(fixture.calls, "utf8")).trim().split(/\r?\n/),
    [`Full|${fixture.checkout}`, `Full|${fixture.checkout}`]);
});
