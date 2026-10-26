import { spawnSync } from "node:child_process";
import { isolatedGitEnvironment } from "./git-environment.mjs";

export const fullCommit = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? "");

export class ReceiptError extends Error {}

export function requireEvidence(condition, code) {
  if (!condition) throw new ReceiptError(code);
}

export function git(args, code) {
  const result = spawnSync("git", [
    "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
    "-c", "trace2.normalTarget=0", "-c", "trace2.perfTarget=0", "-c", "trace2.eventTarget=0", ...args
  ], {
    env: isolatedGitEnvironment({
      GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1"
    }),
    encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024
  });
  requireEvidence(!result.error && result.status === 0, code);
  return result.stdout.trim();
}

export function commit(value) {
  requireEvidence(fullCommit(value), "full_commit_required");
  requireEvidence(git(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`],
    "commit_object_unavailable") === value, "commit_identity_mismatch");
  return value;
}
