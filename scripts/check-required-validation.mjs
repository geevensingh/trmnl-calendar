import { parseArgs } from "node:util";

const report = {
  required_validation_succeeded: false, policy_path: "full", full_result: null,
  head_commit: null, base_commit: null, evaluated_commit: null, evaluated_tree: null, errors: []
};
const isCommitId = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

try {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "full-result": { type: "string" }, "event-name": { type: "string" },
        "head-commit": { type: "string" }, "base-commit": { type: "string" },
        preparation: { type: "string" }
      }
    }));
  } catch {
    throw new Error("invalid_arguments");
  }
  report.full_result = values["full-result"] ?? null;
  if (report.full_result !== "success") throw new Error("genuine_full_success_required");
  if (!isCommitId(values["head-commit"])) throw new Error("full_event_commit_ids_required");
  report.head_commit = values["head-commit"];
  if (values["event-name"] === "pull_request") {
    if (!isCommitId(values["base-commit"])) throw new Error("full_event_commit_ids_required");
    report.base_commit = values["base-commit"];
    let revision;
    try {
      revision = JSON.parse(values.preparation ?? "");
    } catch {
      throw new Error("successful_pinned_preparation_required");
    }
    const parents = [...new Set([report.base_commit, report.head_commit])];
    if (revision?.preparation_succeeded !== true ||
        revision.head_commit !== report.head_commit || revision.base_commit !== report.base_commit ||
        !isCommitId(revision.evaluated_commit) || !isCommitId(revision.evaluated_tree) ||
        !Array.isArray(revision.evaluated_parents) ||
        !revision.evaluated_parents.every(isCommitId) ||
        revision.evaluated_parents.join(" ") !== parents.join(" ") ||
        revision.checkout_state?.status_nonempty !== false ||
        revision.checkout_state?.index_visibility_restricted !== false ||
        !Array.isArray(revision.errors) || revision.errors.length !== 0)
      throw new Error("successful_pinned_preparation_required");
    report.evaluated_commit = revision.evaluated_commit;
    report.evaluated_tree = revision.evaluated_tree;
  } else if (values["event-name"] === "workflow_dispatch") {
    report.evaluated_commit = report.head_commit;
  } else {
    throw new Error("unsupported_validation_event");
  }
  report.required_validation_succeeded = true;
  console.log(JSON.stringify(report));
} catch (error) {
  report.errors.push(error.message);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
