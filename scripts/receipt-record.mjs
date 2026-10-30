import { fullCommit, requireEvidence } from "./receipt-git.mjs";

export const fullCommand = "pwsh -NoLogo -NoProfile -NonInteractive -File ./scripts/validate.ps1 -Scope Full";
export const timestamp = value => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const identifier = value => Number.isSafeInteger(value) && value > 0;
export const login = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/.test(value);
export const validationOutcomes = ["unavailable", "success", "failure", "cancelled", "timed_out", "skipped",
  "action_required", "in_progress", "queued", "neutral", "startup_failure", "stale"];

const codes = new Set([
  "full_commit_required", "commit_object_unavailable", "commit_identity_mismatch", "landing_tree_unavailable",
  "landing_parents_unavailable", "merge_timestamp_unavailable", "actor_evidence_invalid",
  "authorized_human_merge_required", "github_evidence_unavailable", "github_response_too_large",
  "github_evidence_invalid", "github_page_invalid", "github_pagination_limit", "merge_provenance_ambiguous",
  "unsupported_landing_mapping", "landing_merge_base_unavailable", "landing_merge_base_ambiguous",
  "landing_content_comparison_unavailable", "unexpected_landing_content", "review_evidence_invalid",
  "validation_run_provenance_invalid", "validation_job_provenance_invalid", "validation_job_unavailable", "validation_outcome_invalid",
  "exact_landing_checkout_unverified", "full_not_successful", "configured_remote_name_required",
  "remote_configuration_unavailable", "remote_not_configured", "invalid_remote_branch",
  "live_remote_unavailable", "live_remote_evidence_invalid", "landing_not_reachable_or_ancestry_unavailable",
  "prepared_landing_identity_changed", "explicit_delivery_declaration_unsupported", "admitted_landing_identity_changed"
]);
const oneOf = values => value => values.includes(value);
const nullable = check => value => value === null || check(value);
const array = check => value => Array.isArray(value) && value.every(check);
const shape = fields => value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const assessment = oneOf(["complete", "pending", "failed"]);
const actor = shape({ id: identifier, login, type: oneOf(["User", "Bot"]) });
const acceptance = shape({
  kind: oneOf(["authorized-human-merge"]), actor, merged_at: timestamp,
  permission_observed: oneOf(["admin", "maintain", "write"]), final_head: fullCommit, landing_commit: fullCommit
});
const provenance = shape({
  final_head: nullable(fullCommit), api_base: nullable(fullCommit), landing_commit: nullable(fullCommit),
  landing_tree: nullable(fullCommit), landing_parents: array(fullCommit), merge_base: nullable(fullCommit),
  merge_kind: nullable(oneOf(["merge", "squash"])), merged_at: nullable(timestamp), acceptance: nullable(acceptance),
  reviews: array(shape({ id: identifier, actor, commit: fullCommit,
    state: oneOf(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
    submitted_at: nullable(timestamp) }))
});
const attempt = shape({
  id: value => typeof value === "string" && /^[1-9]\d*:[1-9]\d*$/.test(value), checked_at: timestamp,
  scope: oneOf(["repository-change", "ticket-scoped"]), assessment,
  repository_change: shape({ assessment }), provenance,
  validation: shape({
    command: oneOf([fullCommand]), scope: oneOf(["Full"]), run_id: identifier, run_attempt: identifier,
    orchestration_commit: fullCommit, run_on_commit: nullable(fullCommit), evaluated_tree: nullable(fullCommit),
    job_id: nullable(identifier), outcome: oneOf(validationOutcomes)
  }),
  publication: shape({
    checked_at: timestamp, landing_commit: nullable(fullCommit), remote: nullable(oneOf(["origin"])),
    remote_branch: nullable(oneOf(["main"])), remote_commit: nullable(fullCommit),
    reachable: value => typeof value === "boolean", errors: array(value => codes.has(value))
  }),
  blockers: array(value => codes.has(value))
});

export function assertReceiptRecord(record, repository, pr, landing) {
  const valid = shape({
    schema_version: oneOf([1]), repository: oneOf([repository]), pr_number: oneOf([pr]),
    landing_commit: oneOf([landing]), latest_attempt: value => typeof value === "string",
    attempts: array(attempt)
  })(record);
  requireEvidence(valid && record.attempts.length > 0 &&
    record.latest_attempt === record.attempts.at(-1).id &&
    new Set(record.attempts.map(item => item.id)).size === record.attempts.length &&
    record.attempts.every(item => item.provenance.landing_commit === landing &&
      item.id === `${item.validation.run_id}:${item.validation.run_attempt}` &&
      (item.assessment !== "complete" || (item.blockers.length === 0 && item.provenance.acceptance !== null &&
        item.validation.outcome === "success" && item.publication.reachable))), "canonical_receipt_invalid");
}
