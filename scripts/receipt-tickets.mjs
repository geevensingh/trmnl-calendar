import { createHash } from "node:crypto";
import { fullCommit, ReceiptError, requireEvidence } from "./receipt-git.mjs";
import { identifier, login, timestamp, requirementsDigest, validDeclaration, validGateAcceptance, validPointer } from "./receipt-record.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const declarationSignal = /(?:<!--\s*delivery\b|^[ \t]*#{1,6}[ \t]+delivery\b|(?:`{3,}|~{3,})[ \t]*delivery\b)/im;
const pointerMarker = "<!-- delivery-receipt-pointer:v1\n";

function structuredJson(text) {
  requireEvidence(typeof text === "string" && Buffer.byteLength(text, "utf8") <= 60_000, "structured_data_invalid");
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new ReceiptError("structured_data_invalid"); }
  const stack = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && stack.at(-1)) stack.at(-1).key = true;
    else if (token.startsWith('"') && stack.at(-1)?.key) {
      const current = stack.at(-1), key = JSON.parse(token);
      requireEvidence(!current.keys.has(key), "structured_data_invalid");
      current.keys.add(key);
      current.key = false;
    }
    requireEvidence(stack.length <= 20, "structured_data_invalid");
  }
  return parsed;
}

export function declaration(body) {
  const result = { status: "absent", sha256: null, requirements_sha256: null, tickets: [], blockers: [] };
  if (!declarationSignal.test(body)) return result;
  result.sha256 = hash(body);
  const starts = [...body.matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*delivery\b.*$/gim),
    ...body.matchAll(/<!--\s*delivery\b/gi)];
  const headings = [...body.matchAll(/^[ \t]*#{1,6}[ \t]+delivery\b.*$/gim)];
  const blocks = [...body.matchAll(/^[ \t]*```delivery[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?$)/gm)];
  result.status = starts.length > 1 || headings.length > 1 ? "ambiguous" : "malformed";
  if (result.status !== "ambiguous" && starts.length === 1 && blocks.length === 1) {
    let parsed;
    try { parsed = structuredJson(blocks[0][1]); }
    catch (error) { if (!(error instanceof ReceiptError)) throw error; }
    if (validDeclaration(parsed)) {
      result.status = "valid";
      result.tickets = parsed.tickets;
      result.requirements_sha256 = requirementsDigest(parsed.tickets);
    }
  }
  if (result.status !== "valid") result.blockers.push(`delivery_declaration_${result.status}`);
  return result;
}

async function gateFact(options, api, declared, provenance, ticket, gate, reference) {
  const fact = { ...reference, assessment: "pending", actor: null, created_at: null, updated_at: null,
    body_sha256: null, permission_observed: null, acceptance: null, review: null, blockers: [] };
  try {
    if (gate.kind === "review") {
      requireEvidence(reference.kind === "pr-review", "gate_evidence_kind_unsupported");
      const matches = provenance.reviews.filter(review => review.id === reference.id);
      const review = matches[0];
      requireEvidence(matches.length === 1 && review.state === "APPROVED" && review.commit === provenance.final_head &&
        review.submitted_at !== null && Date.parse(review.submitted_at) <= Date.now(), "gate_review_not_applicable");
      fact.review = review;
      fact.actor = review.actor;
      const decisive = provenance.reviews.filter(item => item.actor.id === review.actor.id &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state) && item.submitted_at !== null);
      requireEvidence(!decisive.some(item => Date.parse(item.submitted_at) > Date.parse(review.submitted_at) ||
        (item.submitted_at === review.submitted_at && item.id !== review.id)), "gate_review_not_applicable");
      fact.permission_observed = await authorizedHuman(api, review.actor);
      fact.assessment = "complete";
      return fact;
    }
    requireEvidence(gate.kind === "acceptance" && reference.kind === "issue-comment", "gate_evidence_kind_unsupported");
    const comment = await api.request(`/issues/comments/${reference.id}`);
    requireEvidence(comment.id === reference.id &&
      comment.issue_url === `https://api.github.com/repos/${options.repository}/issues/${ticket.issue}` &&
      timestamp(comment.created_at) && timestamp(comment.updated_at) &&
      Date.parse(comment.created_at) <= Date.parse(comment.updated_at) &&
      Date.parse(comment.updated_at) >= Date.parse(provenance.merged_at) &&
      Date.parse(comment.updated_at) <= Date.now() && typeof comment.body === "string", "gate_evidence_source_invalid");
    fact.created_at = comment.created_at;
    fact.updated_at = comment.updated_at;
    fact.body_sha256 = hash(comment.body);
    requireEvidence(identifier(comment.user?.id) && login(comment.user.login) && comment.user.type === "User" &&
      !comment.user.login.endsWith("[bot]"), "gate_evidence_actor_unauthorized");
    fact.actor = { id: comment.user.id, login: comment.user.login, type: comment.user.type };
    fact.permission_observed = await authorizedHuman(api, fact.actor);
    const marker = "<!-- delivery-acceptance:v1\n";
    requireEvidence(comment.body.split(marker).length === 2 &&
      [...comment.body.matchAll(/<!--\s*delivery-acceptance\b/gi)].length === 1, "gate_acceptance_invalid");
    let accepted;
    try { accepted = structuredJson(comment.body.match(/<!-- delivery-acceptance:v1\n([\s\S]*?)\n-->/)?.[1]); }
    catch { throw new ReceiptError("gate_acceptance_invalid"); }
    requireEvidence(validGateAcceptance(accepted), "gate_acceptance_invalid");
    requireEvidence(accepted.repository === options.repository && accepted.pr_number === options.pr &&
      accepted.landing_commit === provenance.landing_commit && accepted.ticket === ticket.issue &&
      accepted.gate === gate.id && accepted.requirements_sha256 === declared.requirements_sha256,
    "gate_acceptance_scope_mismatch");
    fact.acceptance = accepted;
    requireEvidence(accepted.outcome === "accepted", "gate_acceptance_not_accepted");
    fact.assessment = "complete";
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    fact.blockers.push(error.message);
  }
  return fact;
}

async function authorizedHuman(api, actor) {
  requireEvidence(actor.type === "User" && !actor.login.endsWith("[bot]"), "gate_evidence_actor_unauthorized");
  const permission = await api.request(`/collaborators/${actor.login}/permission`);
  requireEvidence(permission.user?.id === actor.id && ["admin", "maintain", "write"].includes(permission.permission),
    "gate_evidence_actor_unauthorized");
  return permission.permission;
}

export async function ticketScope(options, api, declared, provenance) {
  const scope = { declaration: declared, assessment: declared.status === "absent" ? "not-applicable" : "pending",
    tickets: [], blockers: [...declared.blockers] };
  for (const ticket of declared.tickets) {
    const result = { issue: ticket.issue, assessment: "pending", gates: [],
      pointer: { outcome: "pending", comment_id: null }, blockers: [] };
    try {
      const issue = await api.request(`/issues/${ticket.issue}`);
      requireEvidence(issue.number === ticket.issue && !issue.pull_request, "delivery_issue_required");
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      result.blockers.push(error.message);
    }
    for (const gate of ticket.gates) {
      const evaluated = { id: gate.id, kind: gate.kind, assessment: "pending", facts: [], blockers: [] };
      if (!gate.evidence.length) evaluated.blockers.push("gate_evidence_missing");
      if (gate.evidence.length > 1) evaluated.blockers.push("gate_evidence_ambiguous");
      for (const reference of gate.evidence) {
        const fact = await gateFact(options, api, declared, provenance, ticket, gate, reference);
        evaluated.facts.push(fact);
        evaluated.blockers.push(...fact.blockers);
      }
      if (!evaluated.blockers.length) evaluated.assessment = "complete";
      result.gates.push(evaluated);
    }
    scope.tickets.push(result);
  }
  return scope;
}

export function assessTickets(attempt, repositoryBlockers) {
  const scope = attempt.ticket_scope;
  scope.blockers = [...scope.declaration.blockers];
  for (const ticket of scope.tickets) {
    ticket.blockers = ticket.blockers.filter(code => !["repository_change_not_complete", "ticket_pointer_pending"].includes(code));
    if (attempt.repository_change.assessment !== "complete") ticket.blockers.push("repository_change_not_complete");
    if (ticket.pointer.outcome !== "published") ticket.blockers.push("ticket_pointer_pending");
    ticket.assessment = ticket.blockers.length || ticket.gates.some(gate => gate.assessment !== "complete") ? "pending" : "complete";
    scope.blockers.push(...ticket.blockers, ...ticket.gates.flatMap(gate => gate.blockers));
  }
  scope.blockers = [...new Set(scope.blockers)];
  if (scope.declaration.status !== "absent") scope.assessment =
    scope.declaration.status === "valid" && scope.tickets.every(ticket => ticket.assessment === "complete") ? "complete" : "pending";
  attempt.blockers = [...new Set([...repositoryBlockers, ...scope.blockers])];
  attempt.assessment = attempt.repository_change.assessment === "failed" ? "failed" :
    attempt.repository_change.assessment === "complete" && ["complete", "not-applicable"].includes(scope.assessment) ? "complete" : "pending";
}

export async function publishPointers(options, api, attempt, receiptId) {
  let successful = true;
  for (const ticket of attempt.ticket_scope.tickets) {
    if (ticket.blockers.some(code => !["repository_change_not_complete", "ticket_pointer_pending"].includes(code))) continue;
    if (!fullCommit(attempt.provenance.landing_commit)) continue;
    try {
      const identity = { schema_version: 1, repository: options.repository, pr_number: options.pr,
        landing_commit: attempt.provenance.landing_commit, issue_number: ticket.issue, receipt_comment_id: receiptId };
      const matches = [];
      for (const comment of await api.pages(`/issues/${ticket.issue}/comments`)) {
        if (!comment.body?.includes(pointerMarker)) continue;
        let pointer;
        try {
          requireEvidence(comment.body.split(pointerMarker).length === 2, "ticket_pointer_invalid");
          pointer = structuredJson(comment.body.match(/<!-- delivery-receipt-pointer:v1\n([\s\S]*?)\n-->/)?.[1]);
        }
        catch { throw new ReceiptError("ticket_pointer_invalid"); }
        requireEvidence(validPointer(pointer), "ticket_pointer_invalid");
        if (pointer.repository === options.repository && pointer.pr_number === options.pr &&
          pointer.landing_commit === identity.landing_commit) {
          requireEvidence(pointer.issue_number === ticket.issue && pointer.receipt_comment_id === receiptId,
            "ticket_pointer_identity_invalid");
          matches.push(comment);
        }
      }
      requireEvidence(matches.length <= 1, "ticket_pointer_ambiguous");
      const existing = matches[0];
      if (existing) requireEvidence(ownedComment(existing), "ticket_pointer_ownership_invalid");
      const body = `Delivery receipt for PR #${options.pr}: ` +
        `[canonical evidence](https://github.com/${options.repository}/pull/${options.pr}#issuecomment-${receiptId}).\n\n` +
        `Landing: \`${identity.landing_commit}\`. See the receipt's latest attempt and individual gates; this pointer does not close this issue.\n\n` +
        `${pointerMarker}${JSON.stringify(identity)}\n-->`;
      if (existing?.body === body) {
        ticket.pointer = { outcome: "published", comment_id: existing.id };
        continue;
      }
      const saved = await api.request(existing ? `/issues/comments/${existing.id}` : `/issues/${ticket.issue}/comments`,
        existing ? "PATCH" : "POST", { body });
      requireEvidence(ownedComment(saved) && saved.body === body && (!existing || saved.id === existing.id),
        "ticket_pointer_persistence_unconfirmed");
      ticket.pointer = { outcome: "published", comment_id: saved.id };
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      successful = false;
      ticket.pointer = { outcome: "failed", comment_id: null };
      ticket.blockers.push(error.message);
    }
  }
  return successful;
}

function ownedComment(comment) {
  return identifier(comment.id) && comment.user?.id === 41898282 && comment.user.login === "github-actions[bot]" &&
    comment.user.type === "Bot" && comment.performed_via_github_app?.id === 15368;
}
