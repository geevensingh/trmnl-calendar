import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { commit, fullCommit, git, ReceiptError, requireEvidence } from "./receipt-git.mjs";

export function publicationProof(landing, remote = "origin", branch = "main") {
  const report = {
    checked_at: new Date().toISOString(), landing_commit: fullCommit(landing) ? landing : null,
    remote: null, remote_branch: null, remote_commit: null, reachable: false, errors: []
  };
  try {
    commit(landing);
    requireEvidence(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote), "configured_remote_name_required");
    report.remote = remote;
    requireEvidence(git(["remote"], "remote_configuration_unavailable").split(/\r?\n/).includes(remote),
      "remote_not_configured");
    requireEvidence(branch && !branch.startsWith("-") && !branch.startsWith("refs/") &&
      git(["check-ref-format", "--branch", branch], "invalid_remote_branch") === branch, "invalid_remote_branch");
    report.remote_branch = branch;
    const ref = `refs/heads/${branch}`;
    const observation = git(["ls-remote", "--exit-code", "--refs", "--heads", remote, ref], "live_remote_unavailable");
    report.checked_at = new Date().toISOString();
    const lines = observation.split(/\r?\n/);
    const [tip, observedRef] = lines[0].split("\t");
    requireEvidence(lines.length === 1 && fullCommit(tip) && observedRef === ref, "live_remote_evidence_invalid");
    report.remote_commit = tip;
    commit(tip);
    git(["merge-base", "--is-ancestor", landing, tip], "landing_not_reachable_or_ancestry_unavailable");
    report.reachable = true;
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    report.errors.push(error.message);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    const { values } = parseArgs({ options: {
      "landing-commit": { type: "string" }, remote: { type: "string" }, "remote-branch": { type: "string" }
    } });
    report = publicationProof(values["landing-commit"], values.remote, values["remote-branch"]);
  } catch {
    report = { reachable: false, errors: ["invalid_arguments"] };
  }
  console[report.reachable ? "log" : "error"](JSON.stringify(report));
  process.exitCode = report.reachable ? 0 : 1;
}
