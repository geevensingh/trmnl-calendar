import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const command = join(root, "scripts", "check-completion.mjs");

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  const globalConfig = join(directory, "global.config");
  await writeFile(globalConfig, "");
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never"
  };
  function git(...args) {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd: checkout, env, encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Synthetic Reviewer");
  git("config", "user.email", "reviewer@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  await writeFile(join(checkout, "implementation.txt"), "Original implementation\n");
  git("add", "implementation.txt");
  git("commit", "--quiet", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("switch", "--quiet", "--create", "integration");
  await writeFile(join(checkout, "implementation.txt"), "Reviewed implementation\n");
  git("commit", "--quiet", "--all", "-m", "Reviewed implementation");
  const reviewed = git("rev-parse", "HEAD");
  function check(values = {}) {
    const args = Object.entries({
      "reviewed-commit": reviewed, "target-branch": "main", publication: "local", ...values
    }).filter(([, value]) => value !== null).flatMap(([name, value]) => [`--${name}`, value]);
    return spawnSync(process.execPath, [command, ...args], {
      cwd: checkout, env, encoding: "utf8", timeout: 20_000
    });
  }
  return { directory, checkout, env, git, check, base, reviewed };
}

function evidence(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr);
  assert.equal(status === 0 ? result.stderr : result.stdout, "");
  const output = status === 0 ? result.stdout : result.stderr;
  assert.match(output, /^\{/, output);
  return JSON.parse(output);
}

async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) {
        files[path] = "directory";
        await visit(path);
      } else {
        files[path] = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
      }
    }
  }
  await visit("");
  return files;
}

async function assertUnchanged(directory, before) {
  const after = await snapshot(directory);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [path, hash] of Object.entries(before))
    assert.equal(after[path], hash, `${path} changed`);
}

test("reviewed integration work is not landed until the target branch contains its commit", async t => {
  const repo = await repository(t);

  const integrated = evidence(repo.check(), 1);
  assert.equal(integrated.git_contract_satisfied, false);
  assert.equal(integrated.delivery_state, "integrated");
  assert.equal(integrated.reviewed_commit, repo.reviewed);
  assert.equal(integrated.head_commit, repo.reviewed);
  assert.equal(integrated.target_commit, repo.base);
  assert.equal(integrated.working_tree_clean, true);
  assert.deepEqual(integrated.errors, ["reviewed_commit_not_on_target"]);

  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--no-ff", "integration", "-m", "Land accepted integration");
  const target = repo.git("rev-parse", "HEAD");

  const landed = evidence(repo.check(), 0);
  assert.equal(landed.git_contract_satisfied, true);
  assert.equal(landed.delivery_state, "landed_locally");
  assert.equal(landed.reviewed_commit, repo.reviewed);
  assert.equal(landed.head_commit, target);
  assert.equal(landed.target_commit, target);
  assert.notEqual(target, repo.reviewed);
  assert.equal(landed.remote_commit, null);
  assert.deepEqual(landed.errors, []);
});

test("publication requires the live remote target even when local tracking references claim otherwise", async t => {
  const repo = await repository(t);
  const remote = join(repo.directory, "origin with spaces.git");
  repo.git("init", "--quiet", "--bare", remote);
  repo.git("remote", "add", "origin", remote);
  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--ff-only", "integration");
  const check = () => repo.check({
    publication: "remote", remote: "origin", "remote-branch": "main"
  });

  const missing = evidence(check(), 1);
  assert.equal(missing.delivery_state, "landed_locally");
  assert.equal(missing.remote_commit, null);
  assert.deepEqual(missing.errors, ["remote_branch_missing"]);

  repo.git("push", "--quiet", "origin", `${repo.base}:refs/heads/main`);
  repo.git("update-ref", "refs/remotes/origin/main", repo.reviewed);

  const unpublished = evidence(check(), 1);
  assert.equal(unpublished.delivery_state, "landed_locally");
  assert.equal(unpublished.remote_commit, repo.base);
  assert.equal(unpublished.target_commit, repo.reviewed);
  assert.deepEqual(unpublished.errors, ["remote_target_mismatch"]);

  repo.git("push", "--quiet", "origin", "main");
  repo.git("update-ref", "refs/remotes/origin/main", repo.base);
  const before = await snapshot(repo.checkout);

  const published = evidence(check(), 0);
  assert.equal(published.git_contract_satisfied, true);
  assert.equal(published.delivery_state, "published");
  assert.equal(published.reviewed_commit, repo.reviewed);
  assert.equal(published.target_commit, repo.reviewed);
  assert.equal(published.remote_commit, repo.reviewed);
  assert.equal(published.remote, "origin");
  assert.equal(published.remote_branch, "main");
  assert.deepEqual(published.errors, []);
  await assertUnchanged(repo.checkout, before);
  assert.equal(repo.git("rev-parse", "refs/remotes/origin/main"), repo.base);
});

test("a failed check preserves staged, unstaged, untracked, ignored, stashed and Git metadata state", async t => {
  const repo = await repository(t);
  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--ff-only", "integration");
  await writeFile(join(repo.checkout, "implementation.txt"), "Previously stashed work\n");
  repo.git("stash", "push", "--quiet", "-m", "Pre-existing stash");
  await writeFile(join(repo.checkout, "implementation.txt"), "Pre-existing staged work\n");
  repo.git("add", "implementation.txt");
  await writeFile(join(repo.checkout, "implementation.txt"), "Pre-existing unstaged work\n");
  await writeFile(join(repo.checkout, "untracked.txt"), "Pre-existing untracked work\n");
  await writeFile(join(repo.checkout, ".git", "info", "exclude"), "ignored.log\n");
  await writeFile(join(repo.checkout, "ignored.log"), "Pre-existing ignored output\n");
  await writeFile(join(repo.checkout, ".git", "FETCH_HEAD"), "Pre-existing fetch evidence\n");
  repo.git("config", "core.untrackedCache", "true");
  repo.git("update-index", "--untracked-cache");
  repo.git("config", "trace2.eventTarget", join(repo.checkout, "unexpected-config-trace.json"));
  repo.env.GIT_TRACE = join(repo.checkout, "unexpected-trace.log");
  repo.env.GIT_TRACE2_EVENT = join(repo.checkout, "unexpected-trace2.log");
  const before = await snapshot(repo.checkout);

  const result = evidence(repo.check(), 1);

  assert.equal(result.working_tree_clean, false);
  assert.equal(result.git_contract_satisfied, false);
  assert.equal(result.delivery_state, "landed_locally");
  assert.deepEqual(result.errors, ["uncommitted_changes"]);
  await assertUnchanged(repo.checkout, before);
});

test("missing or invalid contract references fail explicitly without echoing unsafe input", async t => {
  const repo = await repository(t);
  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--ff-only", "integration");
  const cases = [
    ["missing reviewed commit", { "reviewed-commit": null }, "invalid_arguments"],
    ["moving reviewed reference", { "reviewed-commit": "HEAD" }, "invalid_reviewed_commit"],
    ["unknown reviewed commit", { "reviewed-commit": "0".repeat(40) }, "invalid_reviewed_commit"],
    ["non-commit object", { "reviewed-commit": repo.git("rev-parse", "HEAD^{tree}") }, "invalid_reviewed_commit"],
    ["missing target branch", { "target-branch": "missing" }, "target_branch_missing"],
    ["revision instead of branch", { "target-branch": "main~1" }, "invalid_target_branch"],
    ["previous checkout expression", { "target-branch": "@{-1}" }, "invalid_target_branch"],
    ["full ref instead of branch", { "target-branch": "refs/remotes/origin/main" }, "invalid_target_branch"],
    ["missing publication agreement", { publication: null }, "invalid_arguments"],
    ["invalid publication agreement", { publication: "deploy" }, "invalid_arguments"],
    ["remote omitted", { publication: "remote" }, "invalid_arguments"],
    ["remote branch omitted", { publication: "remote", remote: "origin" }, "invalid_arguments"],
    ["remote options on local proof", { remote: "origin" }, "invalid_arguments"],
    ["invalid remote branch", {
      publication: "remote", remote: "origin", "remote-branch": "main~1"
    }, "invalid_remote_branch"],
    ["unconfigured remote", {
      publication: "remote", remote: "missing", "remote-branch": "main"
    }, "remote_not_configured"],
    ["URL instead of configured remote name", {
      publication: "remote", remote: "https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@example.invalid/private.git",
      "remote-branch": "main"
    }, "remote_not_configured"],
    ["unknown argument", { "SYNTHETIC_PRIVATE_ARGUMENT": "secret" }, "invalid_arguments"]
  ];
  for (const [name, values, code] of cases) {
    await t.test(name, () => {
      const result = repo.check(values);
      assert.deepEqual(evidence(result, 1).errors, [code]);
      assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_|https:\/\//);
    });
  }
});

test("index flags that hide tracked edits cannot supply clean-checkout evidence", async t => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    await t.test(flag, async t => {
      const repo = await repository(t);
      repo.git("switch", "--quiet", "main");
      repo.git("merge", "--quiet", "--ff-only", "integration");
      repo.git("update-index", flag, "implementation.txt");
      await writeFile(join(repo.checkout, "implementation.txt"), "Hidden uncommitted work\n");
      assert.equal(repo.git("status", "--porcelain"), "");
      const before = await snapshot(repo.checkout);

      const report = evidence(repo.check(), 1);

      assert.equal(report.git_contract_satisfied, false);
      assert.equal(report.working_tree_clean, null);
      assert.deepEqual(report.errors, ["index_visibility_restricted"]);
      await assertUnchanged(repo.checkout, before);
    });
  }
});

test("unavailable remote evidence fails without leaking credentials from its URL", async t => {
  const repo = await repository(t);
  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--ff-only", "integration");
  repo.git("remote", "add", "origin",
    "https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@/missing.git?SYNTHETIC_SECRET_QUERY");
  const before = await snapshot(repo.checkout);

  const result = repo.check({ publication: "remote", remote: "origin", "remote-branch": "main" });
  const report = evidence(result, 1);

  assert.equal(report.delivery_state, "landed_locally");
  assert.equal(report.remote_commit, null);
  assert.deepEqual(report.errors, ["remote_unavailable"]);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_|https:\/\//);
  await assertUnchanged(repo.checkout, before);
});

test("a different live remote tip fails without fetching its unknown commit into the checkout", async t => {
  const repo = await repository(t);
  const remote = join(repo.directory, "origin.git");
  repo.git("init", "--quiet", "--bare", remote);
  repo.git("remote", "add", "origin", remote);
  repo.git("switch", "--quiet", "main");
  repo.git("merge", "--quiet", "--ff-only", "integration");
  repo.git("push", "--quiet", "origin", "main");
  const tree = repo.git("--git-dir", remote, "rev-parse", `${repo.base}^{tree}`);
  const different = repo.git("-c", "user.name=Synthetic Remote", "-c", "user.email=remote@example.invalid",
    "--git-dir", remote, "commit-tree", tree, "-p", repo.base, "-m", "Divergent remote implementation");
  repo.git("--git-dir", remote, "update-ref", "refs/heads/main", different);
  const before = await snapshot(repo.checkout);

  const report = evidence(repo.check({
    publication: "remote", remote: "origin", "remote-branch": "main"
  }), 1);

  assert.equal(report.delivery_state, "landed_locally");
  assert.equal(report.remote_commit, different);
  assert.equal(report.target_commit, repo.reviewed);
  assert.deepEqual(report.errors, ["remote_target_mismatch"]);
  await assertUnchanged(repo.checkout, before);
});

test("the agreed target and remote branch need not be main or have the same name", async t => {
  const repo = await repository(t);
  const remote = join(repo.directory, "delivery.git");
  repo.git("init", "--quiet", "--bare", remote);
  repo.git("remote", "add", "delivery", remote);
  repo.git("branch", "release/accepted", repo.reviewed);
  repo.git("push", "--quiet", "delivery", `${repo.reviewed}:refs/heads/release/published`);

  const report = evidence(repo.check({
    "target-branch": "release/accepted", publication: "remote",
    remote: "delivery", "remote-branch": "release/published"
  }), 0);

  assert.equal(report.delivery_state, "published");
  assert.equal(report.target_branch, "release/accepted");
  assert.equal(report.remote_branch, "release/published");
  assert.equal(report.remote_commit, repo.reviewed);
  assert.equal(repo.git("rev-parse", "refs/heads/main"), repo.base);
});

test("a directory without a working repository cannot supply completion evidence", async t => {
  const repo = await repository(t);
  const result = spawnSync(process.execPath, [
    command, "--reviewed-commit", repo.reviewed, "--publication", "local"
  ], { cwd: repo.directory, env: repo.env, encoding: "utf8", timeout: 20_000 });

  assert.deepEqual(evidence(result, 1).errors, ["working_repository_required"]);
});
