import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;

function gitEnvironment() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: gitEnvironment(),
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout;
  } catch {
    throw new Error("git_release_history_failed");
  }
}

export async function isGitAncestor(cwd, ancestor, descendant) {
  if (!SHA_PATTERN.test(ancestor ?? "") || !SHA_PATTERN.test(descendant ?? "")) {
    throw new Error("invalid_commit");
  }
  try {
    await execFileAsync("git", ["-C", cwd, "merge-base", "--is-ancestor", ancestor, descendant], {
      encoding: "utf8",
      windowsHide: true,
      env: gitEnvironment(),
      timeout: 15_000,
      maxBuffer: 1024 * 1024
    });
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw new Error("git_release_history_failed");
  }
}

export async function mainCommitsAfter(cwd, checkpoint, through) {
  if (!SHA_PATTERN.test(checkpoint ?? "") || !SHA_PATTERN.test(through ?? "")) {
    throw new Error("invalid_commit");
  }
  if (await isGitAncestor(cwd, through, checkpoint)) return [];
  if (!(await isGitAncestor(cwd, checkpoint, through))) throw new Error("main_history_gap");
  const commits = (await git(cwd, [
    "rev-list", "--first-parent", "--reverse", `${checkpoint}..${through}`
  ])).trim().split(/\r?\n/).filter(Boolean);
  const records = [];
  let expectedParent = checkpoint;
  for (const commit of commits) {
    const metadata = (await git(cwd, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
    if (metadata[0] !== commit || metadata[1] !== expectedParent) {
      throw new Error("main_history_gap");
    }
    const rawPaths = await git(cwd, ["diff", "--no-renames", "--name-only", "-z", expectedParent, commit]);
    records.push({ commit, parent: expectedParent, paths: rawPaths.split("\0").filter(Boolean) });
    expectedParent = commit;
  }
  if (expectedParent !== through) throw new Error("main_history_gap");
  return records;
}

export async function changedPathsBetween(cwd, from, to) {
  if (!SHA_PATTERN.test(from ?? "") || !SHA_PATTERN.test(to ?? "")) throw new Error("invalid_commit");
  return (await git(cwd, ["diff", "--no-renames", "--name-only", "-z", from, to]))
    .split("\0").filter(Boolean);
}
