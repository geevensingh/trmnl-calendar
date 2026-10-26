import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isolatedGitEnvironment } from "./git-environment.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Match checkout's on-disk normalization settings while removing inherited Git selectors.
const environment = isolatedGitEnvironment({
  GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0"
});
const report = {
  preparation_succeeded: false, head_commit: null, base_commit: null,
  evaluated_commit: null, evaluated_tree: null, evaluated_parents: null, checkout_state: null, errors: []
};

function git(args, failure, options = {}) {
  const result = spawnSync("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, ...options
  });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout.trim();
}

function assertCleanCheckout() {
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    "checkout_status_unavailable");
  const index = git(["ls-files", "-v", "-z"], "checkout_index_unavailable");
  report.checkout_state = {
    status_nonempty: status !== "",
    index_visibility_restricted: index.split("\0").some(entry => /^[a-zS] /.test(entry))
  };
  if (report.checkout_state.status_nonempty || report.checkout_state.index_visibility_restricted)
    throw new Error("clean_visible_checkout_required");
}

try {
  let values;
  try {
    ({ values } = parseArgs({
      options: { "head-commit": { type: "string" }, "base-commit": { type: "string" } }
    }));
  } catch {
    throw new Error("invalid_arguments");
  }
  for (const [argument, field] of [["head-commit", "head_commit"], ["base-commit", "base_commit"]]) {
    const value = values[argument];
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value ?? ""))
      throw new Error("full_event_commit_ids_required");
    const commit = git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`],
      "event_commit_unavailable_restore_complete_checkout_history");
    if (commit !== value.toLowerCase()) throw new Error("event_commit_identity_mismatch");
    report[field] = commit;
  }
  const { base_commit: base, head_commit: head } = report;
  if (git(["rev-parse", "--symbolic-full-name", "HEAD"], "checkout_head_unavailable") !== "HEAD")
    throw new Error("detached_checkout_required");
  if (git(["rev-parse", "--is-shallow-repository"], "checkout_history_unavailable") !== "false")
    throw new Error("complete_checkout_history_required");
  assertCleanCheckout();
  const tree = git(["merge-tree", "--write-tree", base, head], "pinned_merge_conflict_or_failure");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
    throw new Error("invalid_prepared_tree");
  const parents = [...new Set([base, head])];
  const dates = git(["show", "-s", "--format=%ct", ...parents], "parent_dates_unavailable")
    .split(/\r?\n/).map(Number);
  if (dates.some(date => !Number.isSafeInteger(date))) throw new Error("invalid_parent_dates");
  const date = `${Math.max(...dates)} +0000`;
  const evaluated = git(["commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])],
    "prepared_commit_creation_failed", {
      input: "CI validation of event-pinned PR head and base\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>\n",
      env: {
        ...environment, GIT_AUTHOR_NAME: "CI validation", GIT_AUTHOR_EMAIL: "ci-validation@example.invalid",
        GIT_COMMITTER_NAME: "CI validation", GIT_COMMITTER_EMAIL: "ci-validation@example.invalid",
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
      }
    });
  const evaluatedParents = git(["show", "-s", "--format=%P", evaluated], "prepared_parents_unavailable").split(" ");
  if (evaluatedParents.join(" ") !== parents.join(" ") ||
      git(["rev-parse", `${evaluated}^{tree}`], "prepared_tree_unavailable") !== tree)
    throw new Error("prepared_revision_identity_mismatch");
  const hooks = mkdtempSync(join(tmpdir(), "agenda CI hooks "));
  try {
    git(["-c", `core.hooksPath=${hooks}`, "checkout", "--quiet", "--detach", "--no-overwrite-ignore", evaluated],
      "prepared_checkout_failed");
  } finally {
    rmSync(hooks, { recursive: true, force: true });
  }
  if (git(["rev-parse", "HEAD"], "evaluated_head_unavailable") !== evaluated ||
      git(["write-tree"], "evaluated_index_unavailable") !== tree)
    throw new Error("evaluated_checkout_identity_mismatch");
  assertCleanCheckout();
  report.evaluated_commit = evaluated;
  report.evaluated_tree = tree;
  report.evaluated_parents = evaluatedParents;
  report.preparation_succeeded = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.errors.push(error.message);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
