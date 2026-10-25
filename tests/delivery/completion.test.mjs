import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const command = join(root, "scripts", "check-completion.mjs");

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda-completion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  const globalConfig = join(directory, "global.config");
  await writeFile(globalConfig, "");
  const env = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never"
  });
  function run(cwd, ...args) {
    return spawnSync("git", ["--no-pager", "--no-optional-locks", ...args], {
      cwd, env, encoding: "utf8", timeout: 10_000
    });
  }
  function gitAt(cwd, ...args) {
    const result = run(cwd, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function git(...args) {
    return gitAt(checkout, ...args);
  }
  git("init", "--quiet", "--initial-branch=main", "--template=");
  await mkdir(join(checkout, ".git", "info"));
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
  function check(values = {}, cwd = checkout) {
    const args = Object.entries({
      "reviewed-commit": reviewed, "target-branch": "main", publication: "local", ...values
    }).filter(([, value]) => value !== null).flatMap(([name, value]) => [`--${name}`, value]);
    return spawnSync(process.execPath, [command, ...args], {
      cwd, env, encoding: "utf8", timeout: 20_000
    });
  }
  return { directory, checkout, env, git, gitAt, run, check, base, reviewed };
}

function evidence(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr);
  assert.equal(status === 0 ? result.stderr : result.stdout, "");
  const output = status === 0 ? result.stdout : result.stderr;
  assert.match(output, /^\{/, output);
  return JSON.parse(output);
}

async function snapshot(directory, excludeGit = false) {
  const files = {};
  async function visit(relative) {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (excludeGit && relative === "" && entry.name === ".git") continue;
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

test("completion repository is isolated before initialization and keeps deliberate fixture configuration", async t => {
  const repo = await repository(t);
  assert.equal(repo.git("rev-parse", "--show-toplevel"), repo.checkout.replaceAll("\\", "/"));
  for (const target of ["index", "objects"])
    assert.equal(repo.git("rev-parse", "--path-format=absolute", "--git-path", target),
      join(repo.checkout, ".git", target).replaceAll("\\", "/"));
  assert.equal(repo.git("config", "--get", "core.bare"), "false");
  assert.equal(repo.git("config", "--get", "user.name"), "Synthetic Reviewer");
  assert.equal(repo.git("show", "-s", "--format=%an|%cn", "HEAD"), "Synthetic Reviewer|Synthetic Reviewer");
  assert.doesNotMatch(repo.git("count-objects", "-v"), /^alternate:/m);
  assert.deepEqual(Object.keys(repo.env).filter(name => name.toUpperCase().startsWith("GIT_")).sort(),
    ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"]);
  const remote = join(repo.directory, "independent.git");
  repo.git("init", "--quiet", "--bare", remote);
  assert.equal(repo.git("config", "--get", "core.bare"), "false");
  assert.equal(repo.git("--git-dir", remote, "config", "--get", "core.bare"), "true");
});

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

// The post-merge recipe runs only in these disposable fixtures, not as a delivery entrypoint.
async function humanLanding(t, { kind = "merge", change, rename = false, context = false } = {}) {
  const repo = await repository(t);
  const implementation = rename ? "renamed implementation.txt" : "implementation.txt";
  if (rename) {
    repo.git("mv", "implementation.txt", implementation);
    repo.git("update-index", "--chmod=+x", implementation);
    repo.git("commit", "--quiet", "-m", "Reviewed rename and executable mode");
    repo.reviewed = repo.git("rev-parse", "HEAD");
  }
  const remote = join(repo.directory, "published origin.git");
  repo.git("init", "--quiet", "--bare", "--initial-branch=main", remote);
  repo.git("remote", "add", "origin", remote);
  repo.git("push", "--quiet", "origin", "main", "integration");
  const target = join(repo.directory, "existing target");
  repo.git("worktree", "add", "--quiet", target, "main");
  const publisher = join(repo.directory, "human publisher");
  repo.git("clone", "--quiet", remote, publisher);
  const human = (...args) => repo.gitAt(publisher, ...args);
  human("config", "user.name", "Synthetic Human");
  human("config", "user.email", "human@example.invalid");
  human("config", "commit.gpgSign", "false");
  human("config", "core.autocrlf", "false");
  if (context) {
    const path = context === "overwritten" ? implementation : "integration-context.txt";
    await writeFile(join(publisher, path), "New target context\n");
    human("add", path);
    human("commit", "--quiet", "-m", "Human target-context change");
  }
  const parent = human("rev-parse", "HEAD");
  if (context === "overwritten") {
    const tree = human("rev-parse", `${repo.reviewed}^{tree}`);
    const landed = human("commit-tree", tree, "-p", parent, "-m", "Human squash overwrites changed input");
    human("push", "--quiet", "origin", `${landed}:refs/heads/main`);
    return { ...repo, remote, target, publisher, human, parent, landed, implementation };
  }
  if (kind === "cherry-pick") {
    human("cherry-pick", "--no-commit", repo.reviewed);
  } else {
    human("merge", "--quiet", ...(kind === "squash" ? ["--squash"] : ["--no-ff", "--no-commit"]),
      "origin/integration");
  }
  if (change === "content") {
    await writeFile(join(publisher, implementation), "Human-adjusted implementation\n");
    human("add", implementation);
  } else if (change === "mode") {
    human("update-index", "--chmod=-x", implementation);
  } else if (change === "paths") {
    await writeFile(join(publisher, "unreviewed.txt"), "Additional landed content\n");
    human("add", "unreviewed.txt");
  }
  human("commit", "--quiet", "-m", `Human ${kind}`);
  const landed = human("rev-parse", "HEAD");
  human("push", "--quiet", "origin", "main");
  return { ...repo, remote, target, publisher, human, parent, landed, implementation };
}

async function localState(repo, cwd) {
  const index = repo.gitAt(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index");
  return {
    branch: repo.run(cwd, "symbolic-ref", "--quiet", "--short", "HEAD").stdout.trim(),
    head: repo.gitAt(cwd, "rev-parse", "HEAD"),
    index: (await readFile(index)).toString("base64"),
    files: await snapshot(cwd, true),
    stash: repo.run(cwd, "rev-parse", "--verify", "refs/stash").stdout.trim()
  };
}

async function synchronizeTarget(repo, {
  approved = true, permitted = true, beforePull, afterPull
} = {}) {
  const commands = [];
  const record = { commands, target_before: null, fetched: null, live: null, target_after: null };
  const finish = outcome => ({ ...record, outcome });
  if (!approved) return finish("approval_missing");
  if (!permitted) return finish("checkout_inaccessible");
  function run(...args) {
    commands.push(args);
    return repo.run(repo.target, ...args);
  }
  function inspect() {
    const branch = run("symbolic-ref", "--quiet", "--short", "HEAD");
    if (branch.status !== 0 || branch.stdout.trim() !== "main") return { error: "wrong_branch" };
    const head = run("rev-parse", "--verify", "HEAD");
    const target = run("rev-parse", "--verify", "refs/heads/main");
    const status = run("status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none");
    const index = run("ls-files", "-v", "-z");
    if ([head, target, status, index].some(result => result.status !== 0))
      return { error: "local_observation_unavailable" };
    if (head.stdout !== target.stdout) return { error: "target_changed" };
    if (index.stdout.split("\0").some(entry => /^[a-zS] /.test(entry)))
      return { error: "index_visibility_restricted" };
    if (status.stdout.length !== 0) return { error: "dirty_checkout" };
    return { head: head.stdout.trim() };
  }
  function liveTip() {
    const result = run("ls-remote", "--exit-code", "--refs", "--heads", "origin", "refs/heads/main");
    if (result.status !== 0) return null;
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\trefs\/heads\/main\r?\n$/.exec(result.stdout);
    return match?.[1] ?? null;
  }
  const initial = inspect();
  if (initial.error) return finish(initial.error);
  record.target_before = initial.head;
  if (run("fetch", "--no-tags", "origin", "main").status !== 0)
    return finish("fetch_unavailable");
  const fetched = run("rev-parse", "--verify", "FETCH_HEAD");
  if (fetched.status !== 0) return finish("fetch_unavailable");
  record.fetched = fetched.stdout.trim();
  record.live = liveTip();
  if (!record.live) return finish("remote_unavailable");
  if (record.live !== record.fetched) return finish("remote_changed");
  const ancestry = run("merge-base", "--is-ancestor", initial.head, record.fetched);
  if (ancestry.status === 1) {
    const reverse = run("merge-base", "--is-ancestor", record.fetched, initial.head);
    if (![0, 1].includes(reverse.status)) return finish("ancestry_unavailable");
    return finish(reverse.status === 0 ? "local_ahead" : "local_divergent");
  }
  if (ancestry.status !== 0) return finish("ancestry_unavailable");
  if (beforePull) await beforePull();
  const current = inspect();
  if (current.error) return finish(current.error);
  if (current.head !== initial.head) return finish("target_changed");
  const pull = run("pull", "--ff-only", "origin", "main");
  record.pull_exit = pull.status;
  if (pull.status !== 0) return finish("pull_failed");
  if (afterPull) await afterPull();
  const final = inspect();
  if (final.error) return finish(final.error);
  record.target_after = final.head;
  record.live = liveTip();
  if (!record.live) return finish("remote_unavailable");
  if (final.head !== record.live) return finish("remote_target_mismatch");
  return finish("synchronized");
}

function landingComparison(repo) {
  function output(...args) {
    const result = repo.run(repo.checkout, ...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const raw = (from, to) => output("diff", "--raw", "--no-abbrev", "--no-renames", "-z", from, to, "--");
  const paths = (from, to) => output("diff", "--name-only", "--no-renames", "-z", from, to, "--")
    .split("\0").filter(Boolean).sort();
  function entries(commit) {
    return new Map(output("ls-tree", "-r", "-z", "--full-tree", commit).split("\0").filter(Boolean)
      .map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t"))]));
  }
  const reviewedPaths = paths(repo.base, repo.reviewed);
  const landedPaths = paths(repo.parent, repo.landed);
  const reviewedEntries = entries(repo.reviewed);
  const landedEntries = entries(repo.landed);
  const comparison = [...new Set([...reviewedPaths, ...landedPaths])].sort().map(path => ({
    path, reviewed: reviewedEntries.get(path) ?? null, landed: landedEntries.get(path) ?? null
  }));
  const ancestry = repo.run(repo.checkout, "merge-base", "--is-ancestor", repo.reviewed, repo.landed);
  assert.ok([0, 1].includes(ancestry.status), ancestry.stderr);
  return {
    reviewed_base: repo.base, reviewed: repo.reviewed, landing_parent: repo.parent, result: repo.landed,
    reviewed_raw: raw(repo.base, repo.reviewed), landed_raw: raw(repo.parent, repo.landed),
    reviewed_paths: reviewedPaths, landed_paths: landedPaths, entries: comparison,
    implementation_matches: JSON.stringify(reviewedPaths) === JSON.stringify(landedPaths)
      && comparison.every(entry => entry.reviewed === entry.landed),
    whole_tree_matches: repo.git("rev-parse", `${repo.reviewed}^{tree}`)
      === repo.git("rev-parse", `${repo.landed}^{tree}`),
    parent_context_matches: repo.git("rev-parse", `${repo.base}^{tree}`)
      === repo.git("rev-parse", `${repo.parent}^{tree}`),
    original_reachable: ancestry.status === 0
  };
}

function publishedProof(repo, accepted = repo.landed) {
  return repo.check({
    "reviewed-commit": accepted, publication: "remote", remote: "origin", "remote-branch": "main"
  }, repo.target);
}

test("recorded approval routes from an isolated feature session to the permitted existing target", async t => {
  const repo = await humanLanding(t);
  const featureBefore = await localState(repo, repo.checkout);
  const targetBefore = await localState(repo, repo.target);
  assert.notEqual(repo.git("rev-parse", "refs/remotes/origin/main"), repo.landed);

  const isolated = await synchronizeTarget(repo, { permitted: false });
  assert.equal(isolated.outcome, "checkout_inaccessible");
  assert.deepEqual(isolated.commands, []);
  assert.deepEqual(await localState(repo, repo.target), targetBefore);

  const synchronized = await synchronizeTarget(repo);
  assert.equal(synchronized.outcome, "synchronized");
  assert.equal(synchronized.target_before, repo.base);
  assert.equal(synchronized.target_after, repo.landed);
  assert.equal(synchronized.live, repo.landed);
  assert.equal(synchronized.pull_exit, 0);
  assert.deepEqual(synchronized.commands.filter(args => args[0] === "pull"),
    [["pull", "--ff-only", "origin", "main"]]);
  assert.deepEqual(await localState(repo, repo.checkout), featureBefore);
  assert.equal(repo.git("--git-dir", repo.remote, "rev-parse", "main"), repo.landed);

  const comparison = landingComparison(repo);
  assert.equal(comparison.original_reachable, true);
  assert.equal(comparison.implementation_matches, true);
  assert.equal(comparison.whole_tree_matches, true);
  assert.equal(comparison.parent_context_matches, true);
  assert.notEqual(repo.landed, repo.reviewed);
  const beforeProof = await snapshot(repo.directory);
  const result = publishedProof(repo);
  const proof = evidence(result, 0);
  assert.equal(proof.reviewed_commit, repo.landed);
  assert.equal(proof.head_commit, repo.landed);
  assert.equal(proof.delivery_state, "published");
  await assertUnchanged(repo.directory, beforeProof);

  const receipt = {
    approval: "Synthetic recorded user approval for this existing target",
    synchronization: synchronized,
    comparison,
    review: { run_on: repo.reviewed, source: "synthetic review fixture", inherited: true },
    validation: { run_on: repo.reviewed, source: "synthetic check fixture", inherited: true },
    accepted_result: repo.landed,
    invocation: [process.execPath, command, "--reviewed-commit", repo.landed,
      "--target-branch", "main", "--publication", "remote", "--remote", "origin", "--remote-branch", "main"],
    exit_status: result.status, proof
  };
  const receiptPath = join(repo.directory, "durable-receipt.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
  assert.equal(receipt.review.inherited, true);
  assert.notEqual(receipt.review.run_on, receipt.accepted_result);

  const repeated = await synchronizeTarget(repo);
  assert.equal(repeated.outcome, "synchronized");
  assert.equal(repeated.target_before, repo.landed);
  assert.equal(repeated.target_after, repo.landed);
});

test("unchanged squash and cherry-pick results need their own accepted identity", async t => {
  for (const kind of ["squash", "cherry-pick"]) {
    await t.test(kind, async t => {
      const repo = await humanLanding(t, { kind });
      assert.equal((await synchronizeTarget(repo)).outcome, "synchronized");
      const comparison = landingComparison(repo);
      assert.equal(comparison.original_reachable, false);
      assert.equal(comparison.implementation_matches, true);
      assert.equal(comparison.whole_tree_matches, true);
      assert.notEqual(repo.landed, repo.reviewed);
      assert.deepEqual(evidence(publishedProof(repo, repo.reviewed), 1).errors,
        ["reviewed_commit_not_on_target"]);
      const proof = evidence(publishedProof(repo), 0);
      assert.equal(proof.reviewed_commit, repo.landed);
      assert.equal(proof.remote_commit, repo.landed);
    });
  }
});

test("comparison includes renamed paths, deletions, executable modes and object IDs", async t => {
  const repo = await humanLanding(t, { kind: "squash", rename: true });
  assert.equal((await synchronizeTarget(repo)).outcome, "synchronized");
  const comparison = landingComparison(repo);
  assert.equal(comparison.implementation_matches, true);
  assert.deepEqual(comparison.reviewed_paths, ["implementation.txt", "renamed implementation.txt"]);
  assert.deepEqual(comparison.entries[0], { path: "implementation.txt", reviewed: null, landed: null });
  assert.match(comparison.entries[1].reviewed, /^100755 blob [a-f0-9]{40}$/);
  assert.equal(comparison.entries[1].reviewed, comparison.entries[1].landed);
  assert.equal(evidence(publishedProof(repo), 0).git_contract_satisfied, true);
});

test("changed resulting content, mode or path sets require renewed acceptance even with green Git proof", async t => {
  for (const options of [
    { kind: "merge", change: "content" },
    { kind: "squash", change: "mode", rename: true },
    { kind: "squash", change: "paths" }
  ]) {
    await t.test(`${options.kind}: ${options.change}`, async t => {
      const repo = await humanLanding(t, options);
      assert.equal((await synchronizeTarget(repo)).outcome, "synchronized");
      const comparison = landingComparison(repo);
      assert.equal(comparison.implementation_matches, false);
      assert.equal(comparison.whole_tree_matches, false);
      assert.equal(comparison.original_reachable, options.kind === "merge");
      const proof = evidence(publishedProof(repo), 0);
      const acceptance = comparison.implementation_matches ? "inherited" : "fresh review/validation pending";
      assert.equal(acceptance, "fresh review/validation pending");
      assert.equal(proof.git_contract_satisfied, true);
      assert.notEqual(acceptance, "inherited", "Git success must not supply content acceptance");
    });
  }
});

test("unchanged implementation on changed target context cannot inherit whole-tree validation", async t => {
  for (const context of [true, "overwritten"]) {
    await t.test(context === true ? "surrounding context changed" : "changed input overwritten", async t => {
      const repo = await humanLanding(t, { kind: "squash", context });
      assert.equal((await synchronizeTarget(repo)).outcome, "synchronized");
      const comparison = landingComparison(repo);
      assert.equal(comparison.implementation_matches, true);
      assert.equal(comparison.whole_tree_matches, context === "overwritten");
      assert.equal(comparison.parent_context_matches, false);
      assert.notEqual(comparison.reviewed_base, comparison.landing_parent);
      assert.equal(evidence(publishedProof(repo), 0).git_contract_satisfied, true);
    });
  }
});

test("missing approval or host capability performs no checkout operation", async t => {
  const repo = await humanLanding(t);
  const before = await snapshot(repo.directory);
  for (const [options, expected] of [
    [{ approved: false }, "approval_missing"],
    [{ permitted: false }, "checkout_inaccessible"]
  ]) {
    const result = await synchronizeTarget(repo, options);
    assert.equal(result.outcome, expected);
    assert.deepEqual(result.commands, []);
    await assertUnchanged(repo.directory, before);
  }
});

test("dirty, hidden-index and wrong-branch targets stop without repairing or losing local state", async t => {
  for (const state of ["staged", "unstaged", "untracked", "assume-unchanged", "skip-worktree",
    "wrong-branch", "detached"]) {
    await t.test(state, async t => {
      const repo = await humanLanding(t);
      const git = (...args) => repo.gitAt(repo.target, ...args);
      if (state === "wrong-branch") git("switch", "--quiet", "--create", "other");
      else if (state === "detached") git("switch", "--quiet", "--detach");
      else {
        await writeFile(join(repo.target, "implementation.txt"), "Pre-existing stash contents\n");
        git("stash", "push", "--quiet", "-m", "Preserve this stash");
        if (["assume-unchanged", "skip-worktree"].includes(state))
          git("update-index", `--${state}`, "implementation.txt");
        await writeFile(join(repo.target, state === "untracked" ? "untracked.txt" : "implementation.txt"),
          "Preserve this local work\n");
        if (state === "staged") git("add", "implementation.txt");
      }
      const before = await localState(repo, repo.target);
      const expected = ["wrong-branch", "detached"].includes(state) ? "wrong_branch"
        : ["assume-unchanged", "skip-worktree"].includes(state) ? "index_visibility_restricted"
          : "dirty_checkout";
      const result = await synchronizeTarget(repo);
      assert.equal(result.outcome, expected);
      assert.equal(result.commands.some(args => ["pull", "fetch"].includes(args[0])), false);
      assert.deepEqual(await localState(repo, repo.target), before);
    });
  }
});

test("ahead, divergent and unavailable-remote cases preserve branch, index, work and stash", async t => {
  for (const state of ["ahead", "divergent", "unavailable-remote", "missing-remote-branch"]) {
    await t.test(state, async t => {
      const repo = await humanLanding(t);
      const git = (...args) => repo.gitAt(repo.target, ...args);
      if (state === "ahead") {
        git("fetch", "--quiet", "origin", "main");
        git("merge", "--quiet", "--ff-only", "FETCH_HEAD");
      }
      if (["ahead", "divergent"].includes(state)) {
        await writeFile(join(repo.target, "local-only.txt"), "Preserve local commit\n");
        git("add", "local-only.txt");
        git("commit", "--quiet", "-m", "Local work outside synchronization");
      } else if (state === "unavailable-remote") {
        git("remote", "set-url", "origin", join(repo.directory, "missing.git"));
      } else {
        repo.git("--git-dir", repo.remote, "update-ref", "-d", "refs/heads/main");
      }
      const before = await localState(repo, repo.target);
      const result = await synchronizeTarget(repo);
      assert.equal(result.outcome, state === "ahead" ? "local_ahead"
        : state === "divergent" ? "local_divergent" : "fetch_unavailable");
      assert.equal(result.commands.some(args => args[0] === "pull"), false);
      assert.deepEqual(await localState(repo, repo.target), before);
    });
  }
});

test("a concurrent local edit blocks the pull and preserves the newly arrived work", async t => {
  const repo = await humanLanding(t);
  let concurrentState;
  const result = await synchronizeTarget(repo, {
    beforePull: async () => {
      await writeFile(join(repo.target, "concurrent.txt"), "Another actor's work\n");
      concurrentState = await localState(repo, repo.target);
    }
  });
  assert.equal(result.outcome, "dirty_checkout");
  assert.equal(result.commands.some(args => args[0] === "pull"), false);
  assert.deepEqual(await localState(repo, repo.target), concurrentState);
});

test("a live remote advance after synchronization leaves publication pending without rollback", async t => {
  const repo = await humanLanding(t);
  let newer;
  const result = await synchronizeTarget(repo, {
    afterPull: async () => {
      await writeFile(join(repo.publisher, "later.txt"), "Later human publication\n");
      repo.human("add", "later.txt");
      repo.human("commit", "--quiet", "-m", "Later human publication");
      repo.human("push", "--quiet", "origin", "main");
      newer = repo.human("rev-parse", "HEAD");
    }
  });
  assert.equal(result.outcome, "remote_target_mismatch");
  assert.equal(result.target_after, repo.landed);
  assert.equal(result.live, newer);
  assert.equal(repo.gitAt(repo.target, "symbolic-ref", "--short", "HEAD"), "main");
  const proof = evidence(publishedProof(repo), 1);
  assert.equal(proof.target_commit, repo.landed);
  assert.equal(proof.remote_commit, newer);
  assert.deepEqual(proof.errors, ["remote_target_mismatch"]);
});
