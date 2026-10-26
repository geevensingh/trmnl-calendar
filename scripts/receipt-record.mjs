import { createHash } from "node:crypto";
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
  "prepared_landing_identity_changed", "explicit_delivery_declaration_unsupported",
  "delivery_declaration_malformed", "delivery_declaration_ambiguous", "delivery_issue_required",
  "gate_evidence_missing", "repository_change_not_complete", "ticket_pointer_pending",
  "gate_evidence_ambiguous", "gate_evidence_kind_unsupported", "gate_acceptance_invalid",
  "gate_acceptance_scope_mismatch", "gate_acceptance_not_accepted", "gate_evidence_actor_unauthorized",
  "gate_evidence_source_invalid", "gate_review_not_applicable", "receipt_write_failed",
  "ticket_pointer_invalid", "ticket_pointer_ambiguous", "ticket_pointer_ownership_invalid",
  "ticket_pointer_identity_invalid", "ticket_pointer_persistence_unconfirmed"
]);
const oneOf = values => value => values.includes(value);
const nullable = check => value => value === null || check(value);
const array = check => value => Array.isArray(value) && value.every(check);
const shape = fields => value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const assessment = oneOf(["complete", "pending", "failed"]);
const actor = shape({ id: identifier, login, type: oneOf(["User", "Bot"]) });
const permission = oneOf(["admin", "maintain", "write"]);
const review = shape({ id: identifier, actor, commit: fullCommit,
  state: oneOf(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]), submitted_at: nullable(timestamp) });
const token = value => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unique = (values, key) => new Set(values.map(value => value[key])).size === values.length;
const reference = shape({ kind: oneOf(["issue-comment", "pr-review"]), id: identifier });
const gate = shape({ id: token, kind: oneOf(["acceptance", "review"]), evidence: array(reference) });
const ticket = shape({ issue: identifier, gates: value => array(gate)(value) && value.length <= 20 && unique(value, "id") });
export const validDeclaration = value => shape({ version: oneOf([1]),
  tickets: value => array(ticket)(value) && value.length > 0 && value.length <= 20 && unique(value, "issue")
})(value) && value.tickets.every(ticket => ticket.gates.every(gate =>
  gate.evidence.length <= 20 && new Set(gate.evidence.map(item => `${item.kind}:${item.id}`)).size === gate.evidence.length));
export const requirementsDigest = tickets => createHash("sha256").update(JSON.stringify({ version: 1,
  tickets: tickets.map(ticket => ({ issue: ticket.issue, gates: ticket.gates.map(({ id, kind }) => ({ id, kind })) }))
})).digest("hex");
export const validPointer = shape({
  schema_version: oneOf([1]), repository: value => typeof value === "string" && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value),
  pr_number: identifier, landing_commit: fullCommit, issue_number: identifier, receipt_comment_id: identifier
});
export const validGateAcceptance = shape({
  version: oneOf([1]), repository: value => typeof value === "string" && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value),
  pr_number: identifier, landing_commit: fullCommit, ticket: identifier, gate: token,
  requirements_sha256: digest, outcome: oneOf(["accepted", "rejected"])
});
const gateFact = shape({
  kind: oneOf(["issue-comment", "pr-review"]), id: identifier, assessment: oneOf(["complete", "pending"]),
  actor: nullable(actor), created_at: nullable(timestamp), updated_at: nullable(timestamp), body_sha256: nullable(digest),
  permission_observed: nullable(permission), acceptance: nullable(validGateAcceptance), review: nullable(review),
  blockers: array(value => codes.has(value))
});
const ticketScope = shape({
  declaration: shape({ status: oneOf(["absent", "valid", "malformed", "ambiguous"]), sha256: nullable(digest),
    requirements_sha256: nullable(digest), tickets: array(ticket), blockers: array(value => codes.has(value)) }),
  assessment: oneOf(["not-applicable", "complete", "pending"]),
  tickets: array(shape({ issue: identifier, assessment: oneOf(["complete", "pending"]),
    gates: array(shape({ id: token, kind: oneOf(["acceptance", "review"]), assessment: oneOf(["complete", "pending"]),
      facts: array(gateFact), blockers: array(value => codes.has(value)) })),
    pointer: shape({ outcome: oneOf(["pending", "published", "failed"]), comment_id: nullable(identifier) }),
    blockers: array(value => codes.has(value))
  })), blockers: array(value => codes.has(value))
});
const acceptance = shape({
  kind: oneOf(["authorized-human-merge"]), actor, merged_at: timestamp,
  permission_observed: oneOf(["admin", "maintain", "write"]), final_head: fullCommit, landing_commit: fullCommit
});
const provenance = shape({
  final_head: nullable(fullCommit), api_base: nullable(fullCommit), landing_commit: nullable(fullCommit),
  landing_tree: nullable(fullCommit), landing_parents: array(fullCommit), merge_base: nullable(fullCommit),
  merge_kind: nullable(oneOf(["merge", "squash"])), merged_at: nullable(timestamp), acceptance: nullable(acceptance),
  reviews: array(review)
});
const attemptFields = {
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
};
const attempt = value => shape(attemptFields)(value) || shape({ ...attemptFields, ticket_scope: ticketScope })(value);

function consistentTickets(item, repository, pr, landing) {
  if (!item.ticket_scope) return true;
  const scope = item.ticket_scope, declared = scope.declaration;
  if (declared.status === "valid") {
    if (!validDeclaration({ version: 1, tickets: declared.tickets }) || !digest(declared.sha256) ||
      declared.requirements_sha256 !== requirementsDigest(declared.tickets) || declared.blockers.length) return false;
  } else if (declared.tickets.length || declared.requirements_sha256 !== null ||
    (declared.status === "absent" ? declared.sha256 !== null || declared.blockers.length :
      !digest(declared.sha256) || declared.blockers.join() !== `delivery_declaration_${declared.status}`)) return false;
  if (item.scope !== (declared.status === "absent" ? "repository-change" : "ticket-scoped") ||
    scope.tickets.length !== declared.tickets.length) return false;
  for (const [index, ticket] of scope.tickets.entries()) {
    const requirement = declared.tickets[index];
    if (ticket.issue !== requirement.issue || ticket.gates.length !== requirement.gates.length ||
      (ticket.pointer.outcome === "published" ? !identifier(ticket.pointer.comment_id) : ticket.pointer.comment_id !== null)) return false;
    for (const [gateIndex, gate] of ticket.gates.entries()) {
      const required = requirement.gates[gateIndex];
      if (gate.id !== required.id || gate.kind !== required.kind || gate.facts.length !== required.evidence.length) return false;
      for (const [factIndex, fact] of gate.facts.entries()) {
        const reference = required.evidence[factIndex];
        if (fact.id !== reference.id || fact.kind !== reference.kind) return false;
        if (fact.assessment !== "complete") {
          if (!fact.blockers.length) return false;
          continue;
        }
        if (fact.blockers.length || !fact.actor || fact.actor.type !== "User" || fact.actor.login.endsWith("[bot]") ||
          !permission(fact.permission_observed)) return false;
        if (gate.kind === "acceptance") {
          const accepted = fact.acceptance;
          if (fact.kind !== "issue-comment" || !timestamp(fact.created_at) || !timestamp(fact.updated_at) ||
            !digest(fact.body_sha256) || fact.review !== null || !accepted || accepted.repository !== repository ||
            accepted.pr_number !== pr || accepted.landing_commit !== landing || accepted.ticket !== ticket.issue ||
            accepted.gate !== gate.id || accepted.requirements_sha256 !== declared.requirements_sha256 ||
            accepted.outcome !== "accepted") return false;
        } else if (fact.kind !== "pr-review" || fact.acceptance !== null || !fact.review ||
          fact.review.id !== fact.id || fact.review.state !== "APPROVED" ||
          fact.review.commit !== item.provenance.final_head || fact.review.actor.id !== fact.actor.id ||
          !item.provenance.reviews.some(review => JSON.stringify(review) === JSON.stringify(fact.review))) return false;
      }
      const complete = gate.blockers.length === 0 && gate.facts.length === 1 && gate.facts[0].assessment === "complete";
      if ((gate.assessment === "complete") !== complete) return false;
    }
    const complete = item.repository_change.assessment === "complete" && ticket.blockers.length === 0 &&
      ticket.pointer.outcome === "published" && ticket.gates.every(gate => gate.assessment === "complete");
    if ((ticket.assessment === "complete") !== complete) return false;
  }
  const expected = declared.status === "absent" ? "not-applicable" :
    declared.status === "valid" && scope.blockers.length === 0 && scope.tickets.every(ticket => ticket.assessment === "complete") ?
      "complete" : "pending";
  return scope.assessment === expected && item.assessment === (item.repository_change.assessment === "failed" ? "failed" :
    item.repository_change.assessment === "complete" && expected !== "pending" ? "complete" : "pending");
}

export function assertReceiptRecord(record, repository, pr, landing) {
  const valid = shape({
    schema_version: oneOf([1]), repository: oneOf([repository]), pr_number: oneOf([pr]),
    landing_commit: oneOf([landing]), latest_attempt: value => typeof value === "string",
    attempts: array(attempt)
  })(record);
  requireEvidence(valid && record.attempts.length > 0 &&
    record.latest_attempt === record.attempts.at(-1).id &&
    new Set(record.attempts.map(item => item.id)).size === record.attempts.length &&
    record.attempts.every(item => consistentTickets(item, repository, pr, landing) && item.provenance.landing_commit === landing &&
      item.id === `${item.validation.run_id}:${item.validation.run_attempt}` &&
      (item.assessment !== "complete" || (item.blockers.length === 0 && item.provenance.acceptance !== null &&
        item.validation.outcome === "success" && item.publication.reachable &&
        (!item.ticket_scope || ["complete", "not-applicable"].includes(item.ticket_scope.assessment))))),
  "canonical_receipt_invalid");
}
