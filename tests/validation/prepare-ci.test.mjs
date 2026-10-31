import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function repository(t, { gateOnBaseOnly = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agenda CI revision "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout with spaces");
  await mkdir(checkout);
  const environment = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  });
  const git = (...args) => spawnSync("git", ["--no-pager", ...args], {
    cwd: checkout, env: environment, encoding: "utf8", timeout: 10_000
  });
  const checked = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  checked("init", "--quiet", "--initial-branch=main", "--template=");
  checked("config", "user.name", "Synthetic maintainer");
  checked("config", "user.email", "synthetic@example.invalid");
  checked("config", "commit.gpgSign", "false");
  checked("config", "core.autocrlf", "false");
  await cp(join(root, "scripts"), join(checkout, "scripts"), { recursive: true });
  if (gateOnBaseOnly) await rm(join(checkout, "scripts", "check-required-validation.mjs"));
  await writeFile(join(checkout, "shared.txt"), "original content\n");
  checked("add", ".");
  checked("commit", "--quiet", "-m", "Synthetic initial base");
  const originalBase = checked("rev-parse", "HEAD");
  checked("switch", "--quiet", "-c", "feature");
  await writeFile(join(checkout, "head-only.txt"), "submitted head content\n");
  checked("add", ".");
  checked("commit", "--quiet", "-m", "Synthetic submitted head");
  const head = checked("rev-parse", "HEAD");
  checked("switch", "--quiet", "main");
  checked("merge", "--quiet", "--no-ff", "--no-edit", "feature");
  const staleMerge = checked("rev-parse", "HEAD");
  checked("update-ref", "refs/pull/51/merge", staleMerge);
  checked("switch", "--quiet", "-c", "retarget-base", originalBase);
  if (gateOnBaseOnly)
    await cp(join(root, "scripts", "check-required-validation.mjs"),
      join(checkout, "scripts", "check-required-validation.mjs"));
  await writeFile(join(checkout, "base-only.txt"), "new base content\n");
  checked("add", ".");
  checked("commit", "--quiet", "-m", "Synthetic retarget base");
  const base = checked("rev-parse", "HEAD");
  checked("checkout", "--quiet", "--detach", staleMerge);
  const prepare = (arguments_ = ["--head-commit", head, "--base-commit", base], overrides = {}) =>
    spawnSync(process.execPath, [join(checkout, "scripts", "prepare-ci.mjs"), ...arguments_], {
      cwd: checkout, env: { ...environment, ...overrides }, encoding: "utf8", timeout: 30_000
    });
  return { directory, checkout, environment, git, checked, prepare, originalBase, head, base, staleMerge };
}

test("PR preparation evaluates the pinned new base and head even when the advertised merge ref is stale", async t => {
  const fixture = await repository(t);
  assert.equal(fixture.checked("rev-parse", "refs/pull/51/merge"), fixture.staleMerge);
  assert.notEqual(fixture.checked("show", "-s", "--format=%P", "HEAD").split(" ")[0], fixture.base);
  await assert.rejects(readFile(join(fixture.checkout, "base-only.txt")), { code: "ENOENT" });
  const refs = fixture.checked("for-each-ref", "--format=%(refname) %(objectname)");
  const result = fixture.prepare();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.preparation_succeeded, true);
  assert.equal(report.head_commit, fixture.head);
  assert.equal(report.base_commit, fixture.base);
  assert.deepEqual(report.evaluated_parents, [fixture.base, fixture.head]);
  assert.equal(report.evaluated_commit, fixture.checked("rev-parse", "HEAD"));
  assert.equal(report.evaluated_tree, fixture.checked("rev-parse", "HEAD^{tree}"));
  assert.deepEqual(fixture.checked("show", "-s", "--format=%P", "HEAD").split(" "), [fixture.base, fixture.head]);
  assert.equal(await readFile(join(fixture.checkout, "base-only.txt"), "utf8"), "new base content\n");
  assert.equal(await readFile(join(fixture.checkout, "head-only.txt"), "utf8"), "submitted head content\n");
  assert.equal(fixture.git("symbolic-ref", "--quiet", "HEAD").status, 1);
  assert.equal(fixture.checked("status", "--porcelain"), "");
  assert.equal(fixture.checked("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  const repeat = fixture.prepare();
  assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
  assert.deepEqual(JSON.parse(repeat.stdout), report);
});

test("Required validation certifies only Full prepared for the exact event-pinned PR revision", async t => {
  const fixture = await repository(t, { gateOnBaseOnly: true });
  await assert.rejects(readFile(join(fixture.checkout, "scripts", "check-required-validation.mjs")), { code: "ENOENT" });
  const prepared = fixture.prepare();
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const revision = JSON.parse(prepared.stdout);
  const gate = (preparation, head = fixture.head, base = fixture.base) =>
    spawnSync(process.execPath, [
      join(fixture.checkout, "scripts", "check-required-validation.mjs"),
      "--full-result", "success", "--event-name", "pull_request",
      "--head-commit", head, "--base-commit", base, "--preparation", preparation
    ], { cwd: fixture.checkout, env: fixture.environment, encoding: "utf8", timeout: 10_000 });
  const accepted = gate(prepared.stdout);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  const report = JSON.parse(accepted.stdout);
  assert.equal(report.required_validation_succeeded, true);
  assert.equal(report.head_commit, fixture.head);
  assert.equal(report.base_commit, fixture.base);
  assert.equal(report.evaluated_commit, fixture.checked("rev-parse", "HEAD"));
  assert.equal(report.evaluated_tree, fixture.checked("rev-parse", "HEAD^{tree}"));

  for (const [preparation, head, base] of [
    ["", fixture.head, fixture.base],
    ["not JSON", fixture.head, fixture.base],
    [JSON.stringify({ ...revision, preparation_succeeded: false }), fixture.head, fixture.base],
    [JSON.stringify({ ...revision, evaluated_commit: null }), fixture.head, fixture.base],
    [JSON.stringify({ ...revision, evaluated_commit: [revision.evaluated_commit] }), fixture.head, fixture.base],
    [JSON.stringify({ ...revision, evaluated_tree: null }), fixture.head, fixture.base],
    [JSON.stringify({ ...revision, evaluated_parents: [fixture.originalBase, fixture.head] }), fixture.head, fixture.base],
    [JSON.stringify({ ...revision, checkout_state: { status_nonempty: true, index_visibility_restricted: false } }),
      fixture.head, fixture.base],
    [JSON.stringify({ ...revision, errors: ["prepared_checkout_failed"] }), fixture.head, fixture.base],
    [prepared.stdout, fixture.originalBase, fixture.base],
    [prepared.stdout, fixture.head, fixture.originalBase]
  ]) {
    const rejected = gate(preparation, head, base);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.equal(JSON.parse(rejected.stderr).required_validation_succeeded, false);
    assert.equal(rejected.stdout, "");
  }
});

test("PR preparation refuses attached, dirty or hidden-index checkouts without replacing their content", async t => {
  for (const state of ["attached", "tracked", "untracked", "hidden-index"]) {
    await t.test(state, async t => {
      const fixture = await repository(t);
      if (state === "attached") fixture.checked("checkout", "--quiet", "main");
      if (state === "hidden-index") fixture.checked("update-index", "--assume-unchanged", "shared.txt");
      const file = state === "untracked" ? "pending.txt" : "shared.txt";
      if (state !== "attached") await writeFile(join(fixture.checkout, file), "preserve pending work\n");
      const head = fixture.checked("rev-parse", "HEAD");
      const content = await readFile(join(fixture.checkout, file));
      const configuration = await readFile(join(fixture.checkout, ".git", "config"));
      const result = fixture.prepare();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stderr);
      assert.equal(report.preparation_succeeded, false);
      assert.deepEqual(report.errors, [
        state === "attached" ? "detached_checkout_required" : "clean_visible_checkout_required"
      ]);
      assert.equal(fixture.checked("rev-parse", "HEAD"), head);
      assert.deepEqual(await readFile(join(fixture.checkout, file)), content);
      assert.deepEqual(await readFile(join(fixture.checkout, ".git", "config")), configuration);
      await assert.rejects(readFile(join(fixture.checkout, "base-only.txt")), { code: "ENOENT" });
    });
  }
});

test("PR preparation refuses shallow history even when both pinned objects are present", async t => {
  const fixture = await repository(t);
  fixture.checked("fetch", "--quiet", "--depth=1", ".", fixture.staleMerge);
  assert.equal(fixture.checked("rev-parse", "--is-shallow-repository"), "true");
  const result = fixture.prepare();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stderr).errors, ["complete_checkout_history_required"]);
  assert.equal(fixture.checked("rev-parse", "HEAD"), fixture.staleMerge);
});

test("PR preparation does not run or modify configured foreign hooks", async t => {
  const fixture = await repository(t);
  const hooks = join(fixture.directory, "foreign hooks");
  await mkdir(hooks);
  const hook = join(hooks, "post-checkout");
  const bytes = "#!/bin/sh\nprintf 'foreign hook ran\\n' > hook-ran.txt\n";
  await writeFile(hook, bytes);
  await chmod(hook, 0o755);
  fixture.checked("config", "core.hooksPath", hooks);
  const configuration = await readFile(join(fixture.checkout, ".git", "config"));
  const result = fixture.prepare();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(readFile(join(fixture.checkout, "hook-ran.txt")), { code: "ENOENT" });
  assert.equal(await readFile(hook, "utf8"), bytes);
  assert.deepEqual(await readFile(join(fixture.checkout, ".git", "config")), configuration);
  assert.equal(fixture.checked("config", "core.hooksPath"), hooks);
});

test("PR preparation preserves an ignored configured foreign hook when the pinned base tracks a colliding path", async t => {
  const fixture = await repository(t);
  fixture.checked("checkout", "--quiet", "--detach", fixture.head);
  await writeFile(join(fixture.checkout, ".gitignore"), "artifacts/\n");
  fixture.checked("add", ".gitignore");
  fixture.checked("commit", "--quiet", "-m", "Ignore generated artifacts");
  const head = fixture.checked("rev-parse", "HEAD");
  const relativeHooks = join("artifacts", "foreign-hooks");
  const relativeHook = join(relativeHooks, "post-checkout");
  const hook = join(fixture.checkout, relativeHook);
  fixture.checked("checkout", "--quiet", "--detach", fixture.base);
  await mkdir(join(fixture.checkout, relativeHooks), { recursive: true });
  await writeFile(hook, "#!/bin/sh\nprintf 'incoming tracked hook\\n'\n");
  fixture.checked("add", "--force", "--", relativeHook);
  fixture.checked("commit", "--quiet", "-m", "Track an incoming hook-path collision");
  const base = fixture.checked("rev-parse", "HEAD");
  fixture.checked("checkout", "--quiet", "--detach", head);
  await mkdir(join(fixture.checkout, relativeHooks), { recursive: true });
  const foreignBytes = Buffer.from("#!/bin/sh\nprintf 'preserve foreign hook bytes\\n'\n");
  await writeFile(hook, foreignBytes);
  await chmod(hook, 0o755);
  fixture.checked("config", "core.hooksPath", relativeHooks);
  fixture.checked("check-ignore", "--quiet", "--", relativeHook);
  assert.equal(fixture.checked("status", "--porcelain"), "");
  const configuration = await readFile(join(fixture.checkout, ".git", "config"));
  const refs = fixture.checked("for-each-ref", "--format=%(refname) %(objectname)");
  const result = fixture.prepare(["--head-commit", head, "--base-commit", base]);
  assert.deepEqual(await readFile(hook), foreignBytes, result.stdout + result.stderr);
  assert.deepEqual(await readFile(join(fixture.checkout, ".git", "config")), configuration);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stderr);
  assert.equal(report.preparation_succeeded, false);
  assert.deepEqual(report.errors, ["prepared_checkout_failed"]);
  assert.equal(report.evaluated_commit, null);
  assert.equal(fixture.checked("rev-parse", "HEAD"), head);
  assert.equal(fixture.checked("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.equal(fixture.checked("status", "--porcelain"), "");
});

test("PR preparation accepts a fresh CRLF checkout under normal on-disk global Git configuration", async t => {
  const fixture = await repository(t);
  const home = join(fixture.directory, "synthetic runner home");
  await mkdir(home);
  delete fixture.environment.GIT_CONFIG_GLOBAL;
  Object.assign(fixture.environment, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") });
  fixture.checked("config", "--unset", "core.autocrlf");
  fixture.checked("config", "--global", "core.autocrlf", "true");
  fixture.checked("checkout", "--quiet", "--detach", fixture.base);
  fixture.checked("checkout", "--quiet", "--detach", fixture.staleMerge);
  assert.equal(await readFile(join(fixture.checkout, "head-only.txt"), "utf8"), "submitted head content\r\n");
  assert.equal(fixture.checked("status", "--porcelain"), "");
  const globalConfiguration = await readFile(join(home, ".gitconfig"));
  const result = fixture.prepare();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).preparation_succeeded, true);
  assert.equal(fixture.checked("status", "--porcelain"), "");
  assert.equal(await readFile(join(fixture.checkout, "base-only.txt"), "utf8"), "new base content\r\n");
  await writeFile(join(fixture.checkout, "shared.txt"), "preserve a real tracked CRLF edit\r\n");
  const dirty = fixture.prepare();
  assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
  assert.deepEqual(JSON.parse(dirty.stderr).checkout_state, {
    status_nonempty: true, index_visibility_restricted: false
  });
  assert.deepEqual(JSON.parse(dirty.stderr).errors, ["clean_visible_checkout_required"]);
  assert.equal(await readFile(join(fixture.checkout, "shared.txt"), "utf8"), "preserve a real tracked CRLF edit\r\n");
  assert.deepEqual(await readFile(join(home, ".gitconfig")), globalConfiguration);
});

test("PR preparation ignores inherited foreign Git selectors and leaves the owner unchanged", async t => {
  const fixture = await repository(t);
  const owner = await repository(t);
  const snapshot = async () => {
    const files = await readdir(owner.checkout, { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(files.filter(file => file.isFile()).map(async file => {
      const path = join(file.parentPath, file.name);
      return [path, createHash("sha256").update(await readFile(path)).digest("hex")];
    })));
  };
  const before = await snapshot();
  const result = fixture.prepare(undefined, {
    GIT_DIR: join(owner.checkout, ".git"),
    GIT_COMMON_DIR: join(owner.checkout, ".git"),
    GIT_WORK_TREE: owner.checkout,
    GIT_INDEX_FILE: join(owner.checkout, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(owner.checkout, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(owner.checkout, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true"
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).evaluated_commit, fixture.checked("rev-parse", "HEAD"));
  assert.equal(await readFile(join(fixture.checkout, "base-only.txt"), "utf8"), "new base content\n");
  assert.deepEqual(await snapshot(), before);
});

test("PR preparation rejects missing or nonliteral event pins without moving HEAD or refs", async t => {
  const fixture = await repository(t);
  const refs = fixture.checked("for-each-ref", "--format=%(refname) %(objectname)");
  for (const [head, error] of [
    ["HEAD", "full_event_commit_ids_required"],
    ["0".repeat(40), "event_commit_unavailable_restore_complete_checkout_history"]
  ]) {
    const result = fixture.prepare(["--head-commit", head, "--base-commit", fixture.base]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stderr).errors, [error]);
    assert.equal(fixture.checked("rev-parse", "HEAD"), fixture.staleMerge);
    assert.equal(fixture.checked("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  }
});

test("PR preparation fails a conflicting pinned merge without checking out partial content", async t => {
  const fixture = await repository(t);
  const commits = [];
  for (const content of ["head change\n", "base change\n"]) {
    fixture.checked("checkout", "--quiet", "--detach", fixture.originalBase);
    await writeFile(join(fixture.checkout, "shared.txt"), content);
    fixture.checked("add", "shared.txt");
    fixture.checked("commit", "--quiet", "-m", "Synthetic conflicting change");
    commits.push(fixture.checked("rev-parse", "HEAD"));
  }
  fixture.checked("checkout", "--quiet", "--detach", fixture.staleMerge);
  const refs = fixture.checked("for-each-ref", "--format=%(refname) %(objectname)");
  const result = fixture.prepare(["--head-commit", commits[0], "--base-commit", commits[1]]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stderr).errors, ["pinned_merge_conflict_or_failure"]);
  assert.equal(fixture.checked("rev-parse", "HEAD"), fixture.staleMerge);
  assert.equal(await readFile(join(fixture.checkout, "shared.txt"), "utf8"), "original content\n");
  assert.equal(fixture.checked("status", "--porcelain"), "");
  assert.equal(fixture.checked("for-each-ref", "--format=%(refname) %(objectname)"), refs);
});

test("PR preparation supports ancestor and identical pins without dropping base content", async t => {
  const fixture = await repository(t);
  for (const head of [fixture.originalBase, fixture.base]) {
    const result = fixture.prepare(["--head-commit", head, "--base-commit", fixture.base]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).evaluated_tree, fixture.checked("rev-parse", `${fixture.base}^{tree}`));
    assert.equal(await readFile(join(fixture.checkout, "base-only.txt"), "utf8"), "new base content\n");
  }
});
