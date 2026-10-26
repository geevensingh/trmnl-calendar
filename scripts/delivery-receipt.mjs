import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { commit, fullCommit, git, ReceiptError, requireEvidence } from "./receipt-git.mjs";
import { publicationProof } from "./check-publication.mjs";
import { assertReceiptRecord, fullCommand, timestamp, identifier, login, validationOutcomes } from "./receipt-record.mjs";
import { declaration, ticketScope, assessTickets, publishPointers } from "./receipt-tickets.mjs";
import { github } from "./receipt-github.mjs";

const workflow = ".github/workflows/delivery-receipt.yml";
const marker = "<!-- delivery-receipt:v1\n";
const actor = value => {
  requireEvidence(identifier(value?.id) && login(value.login) && ["User", "Bot"].includes(value.type),
    "actor_evidence_invalid");
  return { id: value.id, login: value.login, type: value.type };
};

function arguments_() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, tokens: true, options: {
      repository: { type: "string" }, pr: { type: "string" }, "run-id": { type: "string" },
      attempt: { type: "string" }, "orchestration-commit": { type: "string" },
      "api-url": { type: "string", default: "https://api.github.com" }, plan: { type: "string" },
      "landing-commit": { type: "string" }
    } });
  } catch {
    throw new ReceiptError("invalid_arguments");
  }
  const { values: v, positionals, tokens } = parsed;
  const names = tokens.filter(token => token.kind === "option").map(token => token.name);
  requireEvidence(new Set(names).size === names.length && positionals.length === 1 &&
    ["prepare", "publish"].includes(positionals[0]), "invalid_arguments");
  requireEvidence(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(v.repository ?? "") &&
    [v.pr, v["run-id"], v.attempt].every(value => /^[1-9]\d*$/.test(value ?? "") && identifier(Number(value))) &&
    fullCommit(v["orchestration-commit"]) &&
    (v["landing-commit"] === undefined || fullCommit(v["landing-commit"])), "invalid_arguments");
  const url = new URL(v["api-url"]);
  requireEvidence(v["api-url"] === "https://api.github.com" ||
    (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash),
  "unsupported_github_api");
  return { phase: positionals[0], repository: v.repository, pr: Number(v.pr), run: Number(v["run-id"]),
    attempt: Number(v.attempt), orchestration: v["orchestration-commit"], api: url.origin, plan: v.plan,
    landing: v["landing-commit"] };
}

async function provenance(options, api) {
  const pr = await api.request(`/pulls/${options.pr}`);
  requireEvidence(pr.number === options.pr && pr.base?.repo?.full_name === options.repository &&
    pr.base.ref === "main" && pr.state === "closed" && pr.merged === true, "expected_merged_main_pr_required");
  const result = {
    final_head: fullCommit(pr.head?.sha) ? pr.head.sha : null,
    api_base: fullCommit(pr.base?.sha) ? pr.base.sha : null,
    landing_commit: fullCommit(pr.merge_commit_sha) ? pr.merge_commit_sha : null, landing_tree: null,
    landing_parents: [], merge_base: null, merge_kind: null, merged_at: null, acceptance: null, reviews: []
  };
  const blockers = [];
  try {
    commit(result.final_head);
    commit(result.api_base);
    commit(result.landing_commit);
    requireEvidence(options.landing === undefined || options.landing === result.landing_commit,
      "admitted_landing_identity_changed");
    result.landing_tree = git(["rev-parse", `${result.landing_commit}^{tree}`], "landing_tree_unavailable");
    result.landing_parents = git(["show", "-s", "--format=%P", result.landing_commit], "landing_parents_unavailable").split(" ");
    requireEvidence(timestamp(pr.merged_at), "merge_timestamp_unavailable");
    result.merged_at = pr.merged_at;
    const merger = actor(pr.merged_by);
    requireEvidence(merger.type === "User" && !merger.login.endsWith("[bot]"), "authorized_human_merge_required");
    const permission = await api.request(`/collaborators/${merger.login}/permission`);
    requireEvidence(permission.user?.id === merger.id && ["admin", "maintain", "write"].includes(permission.permission),
      "authorized_human_merge_required");
    const events = (await api.pages(`/issues/${options.pr}/timeline`)).filter(event => event.event === "merged");
    requireEvidence(events.length === 1 && events[0].commit_id === result.landing_commit &&
      events[0].actor?.id === merger.id && events[0].created_at === pr.merged_at, "merge_provenance_ambiguous");
    const parents = result.landing_parents;
    requireEvidence(parents.length === 1 || (parents.length === 2 && parents[1] === result.final_head),
      "unsupported_landing_mapping");
    requireEvidence(parents[0] !== result.final_head && result.landing_commit !== result.final_head,
      "unsupported_landing_mapping");
    result.merge_base = git(["merge-base", parents[0], result.final_head], "landing_merge_base_unavailable");
    requireEvidence(fullCommit(result.merge_base), "landing_merge_base_ambiguous");
    const expectedTree = git(["merge-tree", "--write-tree", parents[0], result.final_head],
      "landing_content_comparison_unavailable");
    requireEvidence(expectedTree === result.landing_tree, "unexpected_landing_content");
    result.merge_kind = parents.length === 2 ? "merge" : "squash";
    result.reviews = (await api.pages(`/pulls/${options.pr}/reviews`)).map(review => {
      requireEvidence(identifier(review.id) && fullCommit(review.commit_id) &&
        ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"].includes(review.state) &&
        (review.submitted_at === null || timestamp(review.submitted_at)), "review_evidence_invalid");
      return { id: review.id, actor: actor(review.user), commit: review.commit_id, state: review.state,
        submitted_at: review.submitted_at };
    });
    result.acceptance = { kind: "authorized-human-merge", actor: merger, merged_at: pr.merged_at,
      permission_observed: permission.permission, final_head: result.final_head, landing_commit: result.landing_commit };
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    blockers.push(error.message);
  }
  return { provenance: result, declaration: declaration(pr.body ?? ""), blockers };
}

async function validation(options, api, plan) {
  const result = { command: fullCommand, scope: "Full", run_id: options.run, run_attempt: options.attempt,
    orchestration_commit: options.orchestration, run_on_commit: null, evaluated_tree: null,
    job_id: null, outcome: "unavailable" };
  try {
    const run = await api.request(`/actions/runs/${options.run}/attempts/${options.attempt}`);
    requireEvidence(run.id === options.run && run.run_attempt === options.attempt &&
      run.repository?.full_name === options.repository && run.head_sha === options.orchestration &&
      run.head_branch === "main" &&
      ((run.event === "workflow_dispatch" && run.path === workflow) ||
        (run.event === "push" && run.path === ".github/workflows/delivery-receipt-push.yml" &&
          fullCommit(options.landing) && options.landing === plan.provenance.landing_commit)),
    "validation_run_provenance_invalid");
    const jobName = run.event === "push"
      ? `Receipt PR ${options.pr} / ${options.landing} / Exact landing Full` : "Exact landing Full";
    const jobs = (await api.pages(`/actions/runs/${options.run}/attempts/${options.attempt}/jobs`, "jobs"))
      .filter(job => job.name === jobName);
    requireEvidence(jobs.length === 1 && identifier(jobs[0].id), "validation_job_unavailable");
    const job = jobs[0];
    requireEvidence(job.run_id === options.run && job.run_attempt === options.attempt &&
      job.head_sha === options.orchestration, "validation_job_provenance_invalid");
    result.job_id = job.id;
    const outcome = job.conclusion ?? job.status;
    requireEvidence(validationOutcomes.includes(outcome) && outcome !== "unavailable", "validation_outcome_invalid");
    result.outcome = outcome;
    const succeeded = name => job.steps?.filter(step => step.name === name &&
      step.status === "completed" && step.conclusion === "success").length === 1;
    requireEvidence(succeeded("Check out the exact landing") && succeeded("Verify the exact checkout"),
      "exact_landing_checkout_unverified");
    result.run_on_commit = plan.provenance.landing_commit;
    result.evaluated_tree = plan.provenance.landing_tree;
    requireEvidence(job.status === "completed" && result.outcome === "success" &&
      succeeded("Run the shared Full validation"), "full_not_successful");
    return { validation: result, blockers: [] };
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    return { validation: result, blockers: [error.message] };
  }
}

async function persist(options, api, attempt, replace = false) {
  const matches = (await api.pages(`/issues/${options.pr}/comments`)).filter(comment => comment.body?.includes(marker));
  requireEvidence(matches.length <= 1, "canonical_receipt_ambiguous");
  const existing = matches[0];
  let record = { schema_version: 1, repository: options.repository, pr_number: options.pr,
    landing_commit: attempt.provenance.landing_commit, latest_attempt: attempt.id, attempts: [] };
  if (existing) {
    requireEvidence(identifier(existing.id) && existing.user?.id === 41898282 && existing.user.login === "github-actions[bot]" &&
      existing.user.type === "Bot" && existing.performed_via_github_app?.id === 15368, "receipt_ownership_invalid");
    requireEvidence(existing.body.split(marker).length === 2, "canonical_receipt_invalid");
    try {
      const match = existing.body.match(/<!-- delivery-receipt:v1\n([\s\S]*?)\n-->/);
      record = JSON.parse(match?.[1]);
    } catch { throw new ReceiptError("canonical_receipt_invalid"); }
    requireEvidence(record.schema_version === 1 && record.repository === options.repository &&
      record.pr_number === options.pr && record.landing_commit === attempt.provenance.landing_commit &&
      Array.isArray(record.attempts), "canonical_receipt_identity_invalid");
    assertReceiptRecord(record, options.repository, options.pr, attempt.provenance.landing_commit);
    requireEvidence(replace ? record.latest_attempt === attempt.id :
      !record.attempts.some(previous => previous.id === attempt.id), "attempt_already_recorded");
  }
  if (replace) record.attempts[record.attempts.length - 1] = attempt;
  else record.attempts.push(attempt);
  record.latest_attempt = attempt.id;
  assertReceiptRecord(record, options.repository, options.pr, attempt.provenance.landing_commit);
  const historical = record.attempts.slice(0, -1).some(previous => previous.assessment === "complete");
  const acceptance = attempt.provenance.acceptance;
  const runUrl = `https://github.com/${options.repository}/actions/runs/${options.run}/attempts/${options.attempt}`;
  const body = `Delivery receipt: **${attempt.assessment}** (${attempt.scope}).\n\n` +
    `Latest attempt: \`${attempt.id}\`. Landing: \`${record.landing_commit ?? "unresolved"}\`.\n\n` +
    `Human acceptance: ${acceptance ? `authorized human merge by ${acceptance.actor.login}; not a separate review approval` : "pending"}. ` +
    `Actual review records retained: ${attempt.provenance.reviews.length}.\n\n` +
    `Full: **${attempt.validation.outcome}**, run-on \`${attempt.validation.run_on_commit ?? "unverified"}\`, ` +
    `tree \`${attempt.validation.evaluated_tree ?? "unverified"}\`; [run/attempt](${runUrl}).\n\n` +
    `Live publication: ${attempt.publication.reachable ? "reachable" : "pending"}, ` +
    `observed \`${attempt.publication.remote_commit ?? "unavailable"}\` at ${attempt.publication.checked_at}.\n\n` +
    `Blockers: ${attempt.blockers.length ? attempt.blockers.join(", ") : "none"}.\n\n` +
    `Repository-change: **${attempt.repository_change.assessment}**. ` +
    (attempt.ticket_scope ? `Ticket scope: **${attempt.ticket_scope.assessment}**; declaration **${attempt.ticket_scope.declaration.status}**.\n\n` +
      attempt.ticket_scope.tickets.map(ticket => `Issue #${ticket.issue}: **${ticket.assessment}**; ` +
        `gates: ${ticket.gates.map(gate => `${gate.id}=${gate.assessment}`).join(", ") || "none declared"}; ` +
        `pointer ${ticket.pointer.outcome}.\n\n`).join("") : "\n\n") +
    `Earlier complete observation: ${historical ? "yes; not the latest assessment" : "none"}.\n\n` +
    `${marker}${JSON.stringify(record)}\n-->`;
  requireEvidence(Buffer.byteLength(body, "utf8") <= 60_000, "receipt_capacity_exceeded");
  const saved = await api.request(existing ? `/issues/comments/${existing.id}` : `/issues/${options.pr}/comments`,
    existing ? "PATCH" : "POST", { body });
  requireEvidence(identifier(saved.id) && (!existing || saved.id === existing.id) &&
    saved.body === body && saved.user?.id === 41898282 &&
    saved.user.login === "github-actions[bot]" && saved.user.type === "Bot" &&
    saved.performed_via_github_app?.id === 15368, "receipt_persistence_unconfirmed");
  return saved.id;
}

try {
  const options = arguments_();
  const api = github(options);
  const resolved = await provenance(options, api);
  const plan = { schema_version: 1, repository: options.repository, pr_number: options.pr,
    run_id: options.run, run_attempt: options.attempt, orchestration_commit: options.orchestration, ...resolved };
  if (options.phase === "prepare") {
    console.log(JSON.stringify(plan));
  } else {
    let prepared;
    try { prepared = JSON.parse(await readFile(options.plan, "utf8")); }
    catch { throw new ReceiptError("prepared_plan_unavailable"); }
    requireEvidence(prepared.schema_version === 1 && prepared.repository === options.repository &&
      prepared.pr_number === options.pr && prepared.run_id === options.run &&
      prepared.run_attempt === options.attempt && prepared.orchestration_commit === options.orchestration &&
      prepared.provenance && ["landing_commit", "landing_tree", "final_head"].every(field =>
        prepared.provenance[field] === null || fullCommit(prepared.provenance[field])), "prepared_plan_invalid");
    if (["final_head", "landing_commit", "landing_tree", "landing_parents"].some(field =>
      JSON.stringify(prepared.provenance[field]) !== JSON.stringify(plan.provenance[field]))) {
      plan.blockers.push("prepared_landing_identity_changed");
      plan.provenance.acceptance = null;
    }
    const full = await validation(options, api, prepared);
    const publication = publicationProof(plan.provenance.landing_commit);
    const blockers = [...plan.blockers, ...full.blockers, ...publication.errors];
    const failed = ["failure", "timed_out", "startup_failure"].includes(full.validation.outcome);
    const assessment = failed ? "failed" : blockers.length ? "pending" : "complete";
    const attempt = { id: `${options.run}:${options.attempt}`, checked_at: new Date().toISOString(),
      scope: plan.declaration.status === "absent" ? "repository-change" : "ticket-scoped", assessment,
      repository_change: { assessment: failed ? "failed" :
        plan.blockers.length || full.blockers.length || publication.errors.length ? "pending" : "complete" },
      provenance: plan.provenance, validation: full.validation, publication, blockers,
      ticket_scope: await ticketScope(options, api, plan.declaration, plan.provenance) };
    assessTickets(attempt, blockers);
    const commentId = await persist(options, api, attempt);
    if (attempt.ticket_scope.tickets.length) {
      const pointersPublished = await publishPointers(options, api, attempt, commentId);
      assessTickets(attempt, blockers);
      await persist(options, api, attempt, true);
      requireEvidence(pointersPublished, "ticket_pointer_publication_failed");
    }
    console.log(JSON.stringify({ persisted: true, assessment: attempt.assessment, comment_id: commentId,
      attempt_id: attempt.id, blockers: attempt.blockers }));
  }
} catch (error) {
  console.error(JSON.stringify({ persisted: false, assessment: "pending",
    errors: [error instanceof ReceiptError ? error.message : "receipt_internal_error"] }));
  process.exitCode = 1;
}
