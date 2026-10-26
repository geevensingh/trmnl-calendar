import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const reference = await readFile(join(root, ".agents", "skills", "code-review", "REVIEW-SCOPE.md"), "utf8");
const recipes = [...reference.matchAll(/```powershell\r?\n([\s\S]*?)\r?\n```/g)].map(match => match[1]);
assert.equal(recipes.length, 2, "Exercise the snapshot and commit-binding recipes from the documentation.");
const [captureRecipe, bindingRecipe] = recipes;

function taskCommand(command, paths, commit) {
  const snippet = [...reference.matchAll(/`git ([^`\r\n]+)`/g)]
    .map(match => match[1]).find(value => value.includes(command) && value.endsWith(" -- <task-paths>"));
  assert.ok(snippet, `Exercise the documented ${command} command.`);
  const args = snippet.split(" ").flatMap(value =>
    value === "<task-paths>" ? paths : value.replace("<commit>", commit));
  if (command === "commit --only") args.splice(args.indexOf("commit") + 1, 0, "--quiet", "-m", "Implementation");
  return args;
}

async function repository(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda review scope "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  const globalConfig = join(directory, "global.config");
  await writeFile(globalConfig, "");
  const env = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never"
  });
  function git(...args) {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd: checkout, env, encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function powershell(script, environment) {
    return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: checkout, env: { ...env, ...environment }, encoding: "utf8", timeout: 20_000
    });
  }
  git("init", "--quiet", "--initial-branch=example", "--template=");
  git("config", "user.name", "Synthetic Reviewer");
  git("config", "user.email", "reviewer@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", join(directory, "unused-hooks"));
  const write = (path, content) => writeFile(join(checkout, path), content);
  await write("task.txt", "Original task\n");
  await write("unrelated.txt", "Original user content\n");
  await write("old.txt", "Rename candidate\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "Baseline");
  const baseline = git("rev-parse", "HEAD");
  const index = join(directory, "snapshot.index");
  const capture = (mode = "working-tree", scope = ["task.txt"], fixedPoint = baseline) =>
    powershell(`
      $inputValues = $env:REVIEW_INPUT | ConvertFrom-Json
      $fixedPoint = $inputValues.baseline
      $mode = $inputValues.mode
      $paths = @($inputValues.scope)
      $snapshotIndex = $env:REVIEW_INDEX
      ${captureRecipe}
    `, { REVIEW_INPUT: JSON.stringify({ baseline: fixedPoint, mode, scope }), REVIEW_INDEX: index });
  const bind = (review, candidate = git("rev-parse", "HEAD")) =>
    powershell(`
      $ErrorActionPreference = 'Stop'
      $review = $env:REVIEW_SNAPSHOT | ConvertFrom-Json
      $candidate = $env:REVIEW_COMMIT
      ${bindingRecipe}
    `, { REVIEW_SNAPSHOT: JSON.stringify(review), REVIEW_COMMIT: candidate });
  const commit = (...paths) => {
    for (const path of paths) {
      if (existsSync(join(checkout, path)) || git("--literal-pathspecs", "ls-files", "--", path)) {
        git(...taskCommand("add --all", [path]));
      }
    }
    git(...taskCommand("commit --only", paths));
    return git("rev-parse", "HEAD");
  };
  return { directory, checkout, env, git, write, baseline, index, capture, bind, commit };
}

function manifest(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

function rejected(result, message) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, message);
  assert.equal(result.stdout, "");
}

function record(t, review, accepted) {
  t.diagnostic(JSON.stringify({
    bundle_for_both_axes: createHash("sha256").update(JSON.stringify(review)).digest("hex"),
    mode: review.mode, baseline: review.baseline, basis: review.basis,
    head: review.head, tree: review.tree, scope: review.scope, commits: review.commits,
    accepted_commit: accepted.accepted_commit
  }));
}

test("committed mode pins committed content and excludes every local layer without a new commit", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Committed task\n");
  const head = repo.commit("task.txt");
  await repo.write("task.txt", "Local staged edit\n");
  repo.git("add", "task.txt");
  await repo.write("task.txt", "Local unstaged edit\n");
  await repo.write("new.txt", "Local untracked edit\n");
  const before = repo.git("status", "--porcelain");

  const review = manifest(repo.capture("committed"));
  assert.equal(review.head, head);
  assert.equal(repo.git("show", `${review.tree}:task.txt`), "Committed task");
  assert.match(review.patch.join("\n"), /\+Committed task/);
  assert.doesNotMatch(review.patch.join("\n"), /Local/);
  assert.deepEqual(review.staged_patch, []);
  assert.deepEqual(review.unstaged_patch, []);
  assert.deepEqual(review.untracked, []);
  const accepted = manifest(repo.bind(review, head));
  assert.equal(accepted.accepted_commit, head);
  assert.equal(repo.git("rev-parse", "HEAD"), head);
  assert.equal(repo.git("status", "--porcelain"), before);
  record(t, review, accepted);
});

test("committed scope uses pinned Git entries when excluded local work replaces a file with a directory", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Committed task\n");
  const head = repo.commit("task.txt");
  await mkdir(join(repo.checkout, "tracked-directory"));
  await repo.write("tracked-directory/child.txt", "Committed directory child\n");
  repo.commit("tracked-directory/child.txt");
  await rm(join(repo.checkout, "task.txt"));
  await mkdir(join(repo.checkout, "task.txt"));
  await repo.write("task.txt/user.txt", "Excluded local directory content\n");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));
  const statusBefore = repo.git("status", "--porcelain");

  const review = manifest(repo.capture("committed"));
  assert.match(review.commits.join("\n"), new RegExp(head));
  assert.equal(repo.git("show", `${review.tree}:task.txt`), "Committed task");
  assert.doesNotMatch(review.patch.join("\n"), /Excluded local|user\.txt/);
  rejected(repo.capture("committed", ["tracked-directory"]), /Scope must contain individual file paths/);
  assert.equal(repo.git("status", "--porcelain"), statusBefore);
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  assert.equal(await readFile(join(repo.checkout, "task.txt", "user.txt"), "utf8"), "Excluded local directory content\n");
  record(t, review, manifest(repo.bind(review)));
});

test("uncommitted-only review reuses a recorded full baseline and accepts its unchanged eventual commit", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Uncommitted task\n");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));

  const review = manifest(repo.capture());
  assert.equal(review.baseline, repo.baseline);
  assert.equal(review.basis, repo.baseline);
  assert.equal(review.head, repo.baseline);
  assert.deepEqual(review.commits, []);
  assert.match(review.patch.join("\n"), /\+Uncommitted task/);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.baseline);
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  await assert.rejects(access(repo.index), { code: "ENOENT" });

  const commit = repo.commit("task.txt");
  const accepted = manifest(repo.bind(review, commit));
  assert.equal(accepted.accepted_commit, commit);
  assert.equal(repo.git("rev-parse", `${commit}^{tree}`), review.tree);
  record(t, review, accepted);
});

test("scoped filename Keys cannot shadow the staged-entry key collection", async t => {
  const repo = await repository(t);
  await repo.write("Keys", "Original named task\n");
  repo.commit("Keys");
  await repo.write("Keys", "Reviewed named task\n");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));

  const review = manifest(repo.capture("working-tree", ["Keys"]));
  assert.equal(repo.git("show", `${review.tree}:Keys`), "Reviewed named task");
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  record(t, review, manifest(repo.bind(review, repo.commit("Keys"))));
});

test("case-distinct scoped Git paths retain separate index-only executable modes", async t => {
  const repo = await repository(t);
  repo.git("config", "core.ignorecase", "false");
  repo.git("config", "core.filemode", "false");
  await repo.write("tool.sh", "Shared script content\n");
  await repo.write("TOOL.sh", "Shared script content\n");
  repo.git("--literal-pathspecs", "add", "--", "tool.sh");
  const blob = repo.git("rev-parse", ":tool.sh");
  repo.git("update-index", "--add", "--cacheinfo", "100644", blob, "TOOL.sh");
  repo.git("commit", "--quiet", "-m", "Case-distinct paths");
  repo.git("--literal-pathspecs", "update-index", "--chmod=+x", "--", "tool.sh");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));

  const review = manifest(repo.capture("working-tree", ["tool.sh", "TOOL.sh"]));
  assert.match(repo.git("--literal-pathspecs", "ls-tree", review.tree, "--", "tool.sh"), /^100755 /);
  assert.match(repo.git("--literal-pathspecs", "ls-tree", review.tree, "--", "TOOL.sh"), /^100644 /);
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  repo.git("commit", "--quiet", "-m", "Reviewed case-distinct mode");
  record(t, review, manifest(repo.bind(review)));
});

test("already-staged task deletion commits without restaging missing paths or including user staging", async t => {
  const repo = await repository(t);
  repo.git("rm", "--", "task.txt");
  await repo.write("unrelated.txt", "User staged\n");
  repo.git("add", "--", "unrelated.txt");
  await repo.write("unrelated.txt", "User staged\nUser unstaged\n");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));
  const review = manifest(repo.capture());
  assert.equal(repo.git("ls-tree", "--name-only", review.tree, "--", "task.txt"), "");
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);

  const commit = repo.commit("task.txt");
  assert.equal(repo.git("ls-tree", "--name-only", commit, "--", "task.txt"), "");
  assert.equal(repo.git("show", ":unrelated.txt"), "User staged");
  assert.equal(await readFile(join(repo.checkout, "unrelated.txt"), "utf8"), "User staged\nUser unstaged\n");
  record(t, review, manifest(repo.bind(review, commit)));
});

test("directory symlinks are literal file scopes in committed and working-tree reviews", async t => {
  for (const mode of ["committed", "working-tree"]) {
    await t.test(mode, async t => {
      const repo = await repository(t);
      repo.git("config", "core.symlinks", "true");
      await mkdir(join(repo.checkout, "target"));
      await repo.write("target/nested.txt", "Directory contents are not the scoped link\n");
      repo.commit("target/nested.txt");
      try {
        await symlink("target", join(repo.checkout, "directory-link"), "dir");
      } catch (error) {
        if (error.code !== "EPERM") throw error;
        throw new Error(
          "Full review fixtures require permission to create directory symbolic links. " +
          "On Windows, explicitly enable Developer Mode or grant the account Create symbolic links permission; " +
          "see README.md Local prerequisites. Tests never enable privileges or substitute junctions.",
          { cause: error }
        );
      }
      if (mode === "committed") repo.commit("directory-link");
      const indexBefore = await readFile(join(repo.checkout, ".git", "index"));
      const review = manifest(repo.capture(mode, ["directory-link"]));

      assert.match(repo.git("ls-tree", review.tree, "--", "directory-link"), /^120000 blob /);
      assert.equal(repo.git("show", `${review.tree}:directory-link`), "target");
      assert.doesNotMatch(review.patch.join("\n"), /nested\.txt|Directory contents/);
      assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
      rejected(repo.capture(mode, ["target"]), /Scope must contain individual file paths/);
      const commit = mode === "committed" ? review.head : repo.commit("directory-link");
      record(t, review, manifest(repo.bind(review, commit)));
    });
  }
});

test("unavailable directory symlink permission fails explicitly with documented prerequisite guidance", () => {
  const injection = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    fs.promises.symlink = async () => {
      const error = new Error("Synthetic missing symbolic-link permission");
      error.code = "EPERM";
      throw error;
    };
    syncBuiltinESMExports();
  `;
  const env = isolatedGitEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(injection)}`,
    "--test", "--test-name-pattern=^directory symlinks",
    fileURLToPath(import.meta.url)
  ], {
    cwd: root, env, encoding: "utf8", timeout: 30_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Full review fixtures require permission to create directory symbolic links/);
  assert.match(result.stdout + result.stderr, /Developer Mode|Create symbolic links/);
  assert.match(result.stdout + result.stderr, /\bfail 3\b/);
  assert.match(result.stdout + result.stderr, /\bskipped 0\b/);
});

test("one snapshot composes committed, staged, unstaged, and untracked task content while preserving user work", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Committed task\n");
  const head = repo.commit("task.txt");
  await repo.write("task.txt", "Committed task\nStaged task\n");
  repo.git("add", "task.txt");
  await repo.write("task.txt", "Committed task\nStaged task\nUnstaged task\n");
  await repo.write("new task.txt", "Untracked task\n");
  await repo.write("unrelated.txt", "User staged\n");
  repo.git("add", "unrelated.txt");
  await repo.write("unrelated.txt", "User staged\nUser unstaged\n");
  await repo.write("user-new.txt", "User untracked\n");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));
  const statusBefore = repo.git("status", "--porcelain");

  const review = manifest(repo.capture("working-tree", ["task.txt", "new task.txt"]));
  assert.equal(review.head, head);
  assert.deepEqual(review.commits, [`${head} Implementation`]);
  assert.match(review.committed_patch.join("\n"), /\+Committed task/);
  assert.match(review.staged_patch.join("\n"), /\+Staged task/);
  assert.match(review.unstaged_patch.join("\n"), /\+Unstaged task/);
  assert.deepEqual(review.untracked, ["new task.txt"]);
  assert.equal(repo.git("show", `${review.tree}:task.txt`), "Committed task\nStaged task\nUnstaged task");
  assert.equal(repo.git("show", `${review.tree}:new task.txt`), "Untracked task");
  assert.equal(repo.git("show", `${review.tree}:unrelated.txt`), "Original user content");
  assert.doesNotMatch(review.patch.join("\n"), /User |unrelated\.txt|user-new\.txt/);
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  assert.equal(repo.git("status", "--porcelain"), statusBefore);

  const commit = repo.commit(...review.scope);
  const accepted = manifest(repo.bind(review, commit));
  assert.equal(accepted.accepted_commit, commit);
  assert.equal(repo.git("show", ":unrelated.txt"), "User staged");
  assert.equal(await readFile(join(repo.checkout, "unrelated.txt"), "utf8"), "User staged\nUser unstaged\n");
  assert.equal(await readFile(join(repo.checkout, "user-new.txt"), "utf8"), "User untracked\n");
  assert.match(repo.git("status", "--porcelain"), /MM unrelated\.txt/);
  record(t, review, accepted);
});

test("an invalid explicit baseline fails instead of substituting the valid recorded baseline", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Task edit\n");
  rejected(repo.capture("working-tree", ["task.txt"], "missing-baseline"), /Review Git command failed: rev-parse/);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.baseline);
  await assert.rejects(access(repo.index), { code: "ENOENT" });
});

test("empty committed, working-tree, and cancelling-layer changes stop before reviewer dispatch", async t => {
  const repo = await repository(t);
  rejected(repo.capture("committed"), /Empty scoped change/);
  rejected(repo.capture(), /Empty scoped change/);
  await repo.write("task.txt", "Staged but cancelled task\n");
  repo.git("add", "task.txt");
  await repo.write("task.txt", "Original task\n");
  rejected(repo.capture(), /Empty scoped change/);
  assert.equal(repo.git("rev-parse", "HEAD"), repo.baseline);
});

test("hidden index flags and invalid mode or scope fail before snapshotting", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Task edit\n");
  rejected(repo.capture("unspecified"), /Specify the review mode/);
  rejected(repo.capture("working-tree", []), /Specify a nonempty literal file scope/);
  rejected(repo.capture("working-tree", ["."]), /Scope must contain individual file paths/);
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    repo.git("update-index", `--${flag}`, "task.txt");
    rejected(repo.capture(), /Scoped index visibility is restricted/);
    repo.git("update-index", `--no-${flag}`, "task.txt");
  }
  await assert.rejects(access(repo.index), { code: "ENOENT" });
});

test("staged executable modes survive a working-tree snapshot when filesystem modes are ignored", async t => {
  const repo = await repository(t);
  repo.git("config", "core.filemode", "false");
  repo.git("update-index", "--chmod=+x", "task.txt");
  const indexBefore = await readFile(join(repo.checkout, ".git", "index"));

  const review = manifest(repo.capture());
  assert.match(repo.git("ls-tree", review.tree, "--", "task.txt"), /^100755 blob /);
  assert.match(review.staged_patch.join("\n"), /new mode 100755/);
  assert.deepEqual(await readFile(join(repo.checkout, ".git", "index")), indexBefore);
  repo.git("commit", "--quiet", "-m", "Implementation with staged executable mode");
  const commit = repo.git("rev-parse", "HEAD");
  const accepted = manifest(repo.bind(review, commit));
  record(t, review, accepted);
});

test("an alternate-index commit preserves staged task modes without committing unrelated staged work", async t => {
  const repo = await repository(t);
  repo.git("config", "core.filemode", "false");
  repo.git("update-index", "--chmod=+x", "task.txt");
  await repo.write("unrelated.txt", "User staged\n");
  repo.git("add", "unrelated.txt");
  await repo.write("unrelated.txt", "User staged\nUser unstaged\n");
  const review = manifest(repo.capture());
  const commitIndex = join(repo.directory, "commit.index");
  try {
    repo.env.GIT_INDEX_FILE = commitIndex;
    repo.git("read-tree", review.tree);
    repo.git("commit", "--quiet", "-m", "Isolated task with staged executable mode");
  } finally {
    delete repo.env.GIT_INDEX_FILE;
    await rm(commitIndex, { force: true });
  }
  const commit = repo.git("rev-parse", "HEAD");
  repo.git(...taskCommand("restore --staged", ["task.txt"], commit));
  const accepted = manifest(repo.bind(review, commit));
  assert.equal(repo.git("show", ":unrelated.txt"), "User staged");
  assert.equal(await readFile(join(repo.checkout, "unrelated.txt"), "utf8"), "User staged\nUser unstaged\n");
  assert.match(repo.git("status", "--porcelain"), /MM unrelated\.txt/);
  assert.match(repo.git("ls-tree", commit, "--", "task.txt"), /^100755 blob /);
  record(t, review, accepted);
});

test("literal task filenames cannot commit unrelated pattern-matching files", async t => {
  const repo = await repository(t);
  await repo.write("task[1].txt", "Original literal task\n");
  await repo.write("task1.txt", "Original matching user file\n");
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", "Filename baseline");
  await repo.write("task[1].txt", "Reviewed literal task\n");
  await repo.write("task1.txt", "User staged\n");
  repo.git("add", "--", "task1.txt");
  await repo.write("task1.txt", "User staged\nUser unstaged\n");
  const review = manifest(repo.capture("working-tree", ["task[1].txt"]));

  const commit = repo.commit(...review.scope);
  assert.equal(repo.git("show", `${commit}:task1.txt`), "Original matching user file");
  assert.equal(repo.git("show", ":task1.txt"), "User staged");
  assert.equal(await readFile(join(repo.checkout, "task1.txt"), "utf8"), "User staged\nUser unstaged\n");
  record(t, review, manifest(repo.bind(review, commit)));
});

test("literal staging refresh preserves unrelated matching entries after an isolated mode commit", async t => {
  const repo = await repository(t);
  await repo.write("task[1].txt", "Original literal task\n");
  await repo.write("task1.txt", "Original matching user file\n");
  repo.git("add", "--all");
  repo.git("commit", "--quiet", "-m", "Filename baseline");
  repo.git("config", "core.filemode", "false");
  repo.git("--literal-pathspecs", "update-index", "--chmod=+x", "--", "task[1].txt");
  await repo.write("task1.txt", "User staged\n");
  repo.git("add", "--", "task1.txt");
  await repo.write("task1.txt", "User staged\nUser unstaged\n");
  const review = manifest(repo.capture("working-tree", ["task[1].txt"]));
  const commitIndex = join(repo.directory, "literal-commit.index");
  try {
    repo.env.GIT_INDEX_FILE = commitIndex;
    repo.git("read-tree", review.tree);
    repo.git("commit", "--quiet", "-m", "Isolated literal task mode");
  } finally {
    delete repo.env.GIT_INDEX_FILE;
    await rm(commitIndex, { force: true });
  }
  const commit = repo.git("rev-parse", "HEAD");
  repo.git(...taskCommand("restore --staged", review.scope, commit));
  assert.equal(repo.git("show", ":task1.txt"), "User staged");
  assert.equal(await readFile(join(repo.checkout, "task1.txt"), "utf8"), "User staged\nUser unstaged\n");
  assert.match(repo.git("--literal-pathspecs", "ls-files", "--stage", "--", "task[1].txt"), /^100755 /);
  record(t, review, manifest(repo.bind(review, commit)));
});

test("a divergent explicit baseline retains the pinned merge-base and relevant full commit list", async t => {
  const repo = await repository(t);
  repo.git("switch", "--quiet", "--create", "baseline-side");
  await repo.write("unrelated.txt", "Other baseline-side change\n");
  const explicitBaseline = repo.commit("unrelated.txt");
  repo.git("switch", "--quiet", "example");
  await repo.write("task.txt", "Task-side change\n");
  const head = repo.commit("task.txt");

  const review = manifest(repo.capture("committed", ["task.txt"], "baseline-side"));
  assert.equal(review.baseline, explicitBaseline);
  assert.equal(review.basis, repo.baseline);
  assert.deepEqual(review.commits, [`${head} Implementation`]);
  const accepted = manifest(repo.bind(review, head));
  record(t, review, accepted);
});

test("scope retains an already committed rename and a working deletion without re-adding missing paths", async t => {
  const repo = await repository(t);
  repo.git("mv", "old.txt", "renamed.txt");
  repo.git("commit", "--quiet", "-m", "Rename task file");
  await rm(join(repo.checkout, "task.txt"));

  const review = manifest(repo.capture("working-tree", ["old.txt", "renamed.txt", "task.txt"]));
  assert.equal(repo.git("ls-tree", "--name-only", review.tree, "--", "old.txt", "task.txt"), "");
  assert.equal(repo.git("show", `${review.tree}:renamed.txt`), "Rename candidate");
  const commit = repo.commit("task.txt");
  const accepted = manifest(repo.bind(review, commit));
  record(t, review, accepted);
});

test("post-review content and newly included task files cannot inherit acceptance", async t => {
  for (const change of ["content", "new scope"]) {
    await t.test(change, async t => {
      const repo = await repository(t);
      await repo.write("task.txt", "Reviewed task\n");
      const review = manifest(repo.capture());
      if (change === "content") {
        await repo.write("task.txt", "Changed after review\n");
        repo.commit("task.txt");
      } else {
        await repo.write("later.txt", "Task added after review\n");
        repo.commit("task.txt", "later.txt");
      }
      rejected(repo.bind(review), /Content changed; renew review and verification/);
    });
  }
});

test("scope reinventory detects changed scope even if the whole candidate tree stays the same", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Reviewed task\n");
  const review = manifest(repo.capture());
  const fresh = manifest(repo.capture("working-tree", ["task.txt", "old.txt"]));
  assert.equal(fresh.tree, review.tree);
  assert.notDeepEqual(fresh.scope, review.scope);
  assert.notEqual(JSON.stringify(fresh), JSON.stringify(review));
});

test("an intervening parent cannot inherit review even when the resulting whole tree matches", async t => {
  const repo = await repository(t);
  await repo.write("task.txt", "Reviewed task\n");
  const review = manifest(repo.capture());
  await repo.write("unrelated.txt", "Intervening committed change\n");
  repo.commit("unrelated.txt");
  await repo.write("unrelated.txt", "Original user content\n");
  const commit = repo.commit("task.txt", "unrelated.txt");
  assert.equal(repo.git("rev-parse", `${commit}^{tree}`), review.tree);
  rejected(repo.bind(review, commit), /Review head changed; renew review and verification/);
});
