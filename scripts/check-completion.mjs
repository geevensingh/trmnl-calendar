import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const gitEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.toUpperCase().startsWith("GIT_TRACE")));

class CompletionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new CompletionFailure(code);
}

function git(args, failureCode = "git_check_failed") {
  // Status accelerators and tracing can write files even for read-only commands.
  const result = spawnSync("git", [
    "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
    "-c", "trace2.normalTarget=0", "-c", "trace2.perfTarget=0", "-c", "trace2.eventTarget=0", ...args
  ], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...gitEnvironment, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never"
    }
  });
  if (result.error) {
    if (result.error.code === "ENOENT") fail("git_unavailable");
    if (result.error.code === "ETIMEDOUT" && failureCode === "git_check_failed")
      fail("git_timed_out");
    fail(failureCode);
  }
  if (result.status === null) fail(failureCode);
  return result;
}

function branch(name, code = "invalid_target_branch") {
  if (!name || name.startsWith("-") || name.startsWith("refs/"))
    fail(code);
  const result = git(["check-ref-format", "--branch", name]);
  if (result.status !== 0 || result.stdout.trim() !== name)
    fail(code);
  return `refs/heads/${name}`;
}

function commit(ref, code) {
  const result = git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (result.status !== 0) fail(code);
  return result.stdout.trim();
}

function inspect(values, report) {
  if (!values["reviewed-commit"] || !["local", "remote"].includes(values.publication)
    || (values.publication === "local" && (values.remote !== undefined || values["remote-branch"] !== undefined))
    || (values.publication === "remote" && (!values.remote || !values["remote-branch"])))
    fail("invalid_arguments");
  report.publication = values.publication;
  const target = values["target-branch"] ?? "main";
  const targetRef = branch(target);
  report.target_branch = target;
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true")
    fail("working_repository_required");
  const reviewed = values["reviewed-commit"];
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reviewed))
    fail("invalid_reviewed_commit");
  report.reviewed_commit = commit(reviewed, "invalid_reviewed_commit");
  if (report.reviewed_commit !== reviewed.toLowerCase())
    fail("invalid_reviewed_commit");
  report.head_commit = commit("HEAD", "head_commit_unavailable");
  report.target_commit = commit(targetRef, "target_branch_missing");
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.status !== 0) fail("working_tree_status_unavailable");
  const index = git(["ls-files", "-v", "-z"]);
  if (index.status !== 0) fail("working_tree_status_unavailable");
  const visibilityRestricted = index.stdout.split("\0").some(entry => /^[a-zS] /.test(entry));
  report.working_tree_clean = visibilityRestricted ? null : status.stdout.length === 0;
  if (visibilityRestricted) report.errors.push("index_visibility_restricted");
  if (status.stdout.length !== 0) report.errors.push("uncommitted_changes");
  const ancestry = git(["merge-base", "--is-ancestor", report.reviewed_commit, report.target_commit]);
  if (![0, 1].includes(ancestry.status)) fail("ancestry_unavailable");
  if (ancestry.status === 1) {
    report.delivery_state = "integrated";
    report.errors.push("reviewed_commit_not_on_target");
  } else {
    report.delivery_state = "landed_locally";
  }
  if (values.publication === "remote") {
    const remoteRef = branch(values["remote-branch"], "invalid_remote_branch");
    report.remote_branch = values["remote-branch"];
    const remotes = git(["remote"]);
    if (remotes.status !== 0) fail("remote_configuration_unavailable");
    if (!remotes.stdout.split(/\r?\n/).includes(values.remote))
      fail("remote_not_configured");
    report.remote = values.remote;
    const actual = git(["ls-remote", "--exit-code", "--refs", "--heads", values.remote, remoteRef],
      "remote_unavailable");
    if (actual.status === 2) fail("remote_branch_missing");
    if (actual.status !== 0) fail("remote_unavailable");
    const lines = actual.stdout.trim().split(/\r?\n/);
    const [hash, ref] = lines[0].split("\t");
    if (lines.length !== 1 || ref !== remoteRef || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash))
      fail("remote_evidence_invalid");
    report.remote_commit = hash;
    if (hash !== report.target_commit) {
      report.errors.push("remote_target_mismatch");
    } else if (report.delivery_state === "landed_locally") {
      report.delivery_state = "published";
    }
  }
}

const report = {
  checked_at: new Date().toISOString(),
  git_contract_satisfied: false,
  delivery_state: "unknown",
  publication: null,
  reviewed_commit: null,
  head_commit: null,
  target_branch: null,
  target_commit: null,
  remote: null,
  remote_branch: null,
  remote_commit: null,
  working_tree_clean: null,
  errors: []
};

try {
  let options;
  try {
    options = parseArgs({
      options: {
        "reviewed-commit": { type: "string" },
        "target-branch": { type: "string" },
        publication: { type: "string" },
        remote: { type: "string" },
        "remote-branch": { type: "string" },
        help: { type: "boolean", short: "h" }
      },
      tokens: true
    });
  } catch (error) {
    if (error.code?.startsWith("ERR_PARSE_ARGS_")) fail("invalid_arguments");
    throw error;
  }
  const names = options.tokens.filter(token => token.kind === "option").map(token => token.name);
  if (new Set(names).size !== names.length) fail("invalid_arguments");
  if (options.values.help) {
    console.log("Read-only Git completion proof. Run from the repository checkout.\n"
      + "Required: --reviewed-commit <full-commit-id> --publication <local|remote>\n"
      + "Optional: --target-branch <local-branch> (default: main)\n"
      + "Remote publication also requires: --remote <configured-name> --remote-branch <branch>\n"
      + "The live remote tip must equal the local target tip; tracking refs are not proof.\n"
      + "Exit 0 means the Git conditions passed, not that tests, review, or deployment passed.");
    process.exit(0);
  }
  inspect(options.values, report);
} catch (error) {
  if (!(error instanceof CompletionFailure)) throw error;
  report.errors.push(error.code);
}

report.git_contract_satisfied = report.errors.length === 0;
console[report.git_contract_satisfied ? "log" : "error"](JSON.stringify(report, null, 2));
process.exitCode = report.git_contract_satisfied ? 0 : 1;
