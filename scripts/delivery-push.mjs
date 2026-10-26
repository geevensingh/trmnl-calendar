import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { commit, fullCommit, git, ReceiptError, requireEvidence } from "./receipt-git.mjs";
import { github } from "./receipt-github.mjs";
import { assertReceiptRecord, identifier } from "./receipt-record.mjs";

const exceptionCodes = new Set([
  "push_event_invalid", "push_range_unavailable", "full_commit_required", "commit_object_unavailable",
  "commit_identity_mismatch", "push_history_unavailable", "push_range_not_first_parent",
  "github_evidence_unavailable", "github_response_too_large", "github_evidence_invalid", "github_page_invalid",
  "github_pagination_limit", "push_landing_ambiguous", "push_commit_unassociated", "push_association_ambiguous",
  "push_association_changed", "push_matrix_capacity_exceeded"
]);
const fields = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function arguments_() {
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true, tokens: true, options: {
      repository: { type: "string" }, "run-id": { type: "string" }, attempt: { type: "string" },
      "orchestration-commit": { type: "string" }, event: { type: "string" }, batch: { type: "string" },
      "api-url": { type: "string", default: "https://api.github.com" }
    } });
  } catch { throw new ReceiptError("invalid_arguments"); }
  const { values: v, positionals, tokens } = parsed;
  const names = tokens.filter(token => token.kind === "option").map(token => token.name);
  requireEvidence(positionals.length === 1 && ["admit", "summarize"].includes(positionals[0]) &&
    new Set(names).size === names.length &&
    /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(v.repository ?? "") &&
    [v["run-id"], v.attempt].every(value => /^[1-9]\d*$/.test(value ?? "") && identifier(Number(value))) &&
    fullCommit(v["orchestration-commit"]), "invalid_arguments");
  const url = new URL(v["api-url"]);
  requireEvidence(v["api-url"] === "https://api.github.com" ||
    (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash),
  "unsupported_github_api");
  return { phase: positionals[0], repository: v.repository, run: Number(v["run-id"]),
    attempt: Number(v.attempt), orchestration: v["orchestration-commit"], api: url.origin,
    event: v.event, batch: v.batch };
}

async function json(path) {
  try {
    const text = await readFile(path, "utf8");
    requireEvidence(Buffer.byteLength(text) <= 8 * 1024 * 1024, "push_input_too_large");
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError("push_input_unavailable");
  }
}

async function admit(options, api) {
  const event = await json(options.event);
  const batch = { schema_version: 1, repository: options.repository, run_id: options.run,
    run_attempt: options.attempt, orchestration_commit: options.orchestration,
    before: fullCommit(event.before) ? event.before : null,
    after: fullCommit(event.after) ? event.after : null, landings: [], exceptions: [], schedulable: true };
  try {
    requireEvidence(event.repository?.full_name === options.repository && event.ref === "refs/heads/main" &&
      event.after === options.orchestration && event.deleted === false && event.forced === false,
    "push_event_invalid");
    requireEvidence(fullCommit(event.before) && fullCommit(event.after) && !/^0+$/.test(event.before),
      "push_range_unavailable");
    commit(event.before);
    commit(event.after);
    requireEvidence(git(["rev-parse", "--is-shallow-repository"], "push_history_unavailable") === "false",
      "push_history_unavailable");
    const range = git(["rev-list", "--reverse", "--first-parent", `${event.before}..${event.after}`],
      "push_history_unavailable");
    const commits = range ? range.split("\n") : [];
    requireEvidence(event.before === event.after || (commits.length > 0 &&
      git(["show", "-s", "--format=%P", commits[0]], "push_history_unavailable").split(" ")[0] === event.before),
    "push_range_not_first_parent");
    for (const sha of commits) {
      try {
        const associated = await api.pages(`/commits/${sha}/pulls`);
        requireEvidence(associated.every(pr => pr !== null && typeof pr === "object" && identifier(pr.number)),
          "github_evidence_invalid");
        const matches = associated.filter(pr => pr.base?.repo?.full_name === options.repository &&
          pr.base.ref === "main" && pr.merge_commit_sha === sha);
        const numbers = [...new Set(matches.map(pr => pr.number))];
        requireEvidence(numbers.length === 1 && identifier(numbers[0]),
          numbers.length > 1 ? "push_landing_ambiguous" :
            associated.length ? "push_association_ambiguous" : "push_commit_unassociated");
        const pr = await api.request(`/pulls/${numbers[0]}`);
        requireEvidence(pr?.number === numbers[0] && pr.base?.repo?.full_name === options.repository &&
          pr.base.ref === "main" && pr.merged === true && pr.state === "closed" && pr.merge_commit_sha === sha,
        "push_association_changed");
        batch.landings.push({ pr_number: numbers[0], landing_commit: sha });
      } catch (error) {
        if (!(error instanceof ReceiptError)) throw error;
        batch.exceptions.push({ commit: sha, code: error.message });
      }
    }
  } catch (error) {
    if (!(error instanceof ReceiptError)) throw error;
    batch.exceptions.push({ commit: null, code: error.message });
  }
  if (batch.landings.length > 256) {
    batch.schedulable = false;
    batch.exceptions.push({ commit: null, code: "push_matrix_capacity_exceeded" });
  }
  requireEvidence(Buffer.byteLength(JSON.stringify(batch)) <= 400_000, "push_batch_capacity_exceeded");
  return batch;
}

async function summarize(options, api) {
  const batch = await json(options.batch);
  requireEvidence(fields(batch, ["schema_version", "repository", "run_id", "run_attempt", "orchestration_commit",
    "before", "after", "landings", "exceptions", "schedulable"]) &&
    batch.schema_version === 1 && batch.repository === options.repository &&
    batch.run_id === options.run && batch.run_attempt === options.attempt &&
    batch.orchestration_commit === options.orchestration &&
    (batch.before === null || fullCommit(batch.before)) && (batch.after === null || fullCommit(batch.after)) &&
    typeof batch.schedulable === "boolean" &&
    Array.isArray(batch.landings) && batch.landings.every(entry =>
      fields(entry, ["pr_number", "landing_commit"]) && identifier(entry.pr_number) && fullCommit(entry.landing_commit)) &&
    new Set(batch.landings.map(entry => entry.pr_number)).size === batch.landings.length &&
    new Set(batch.landings.map(entry => entry.landing_commit)).size === batch.landings.length &&
    Array.isArray(batch.exceptions) && batch.exceptions.every(entry => fields(entry, ["commit", "code"]) &&
      (entry.commit === null || fullCommit(entry.commit)) && exceptionCodes.has(entry.code)), "push_batch_invalid");
  const summary = { ...batch, complete: false, landings: [] };
  for (const entry of batch.landings) {
    requireEvidence(identifier(entry.pr_number) && fullCommit(entry.landing_commit), "push_batch_invalid");
    const result = { ...entry, persisted: false, assessment: "pending", blockers: [] };
    try {
      const allComments = await api.pages(`/issues/${entry.pr_number}/comments`);
      requireEvidence(allComments.every(comment => identifier(comment?.id) && typeof comment.body === "string"),
        "github_evidence_invalid");
      const comments = allComments.filter(comment => comment.body.includes("<!-- delivery-receipt:v1\n"));
      requireEvidence(comments.length === 1, "push_receipt_unavailable");
      const comment = comments[0];
      requireEvidence(identifier(comment.id) && comment.user?.id === 41898282 && comment.user.login === "github-actions[bot]" &&
        comment.user.type === "Bot" && comment.performed_via_github_app?.id === 15368,
      "receipt_ownership_invalid");
      requireEvidence(comment.body.split("<!-- delivery-receipt:v1\n").length === 2, "canonical_receipt_invalid");
      let record;
      try { record = JSON.parse(comment.body.match(/<!-- delivery-receipt:v1\n([\s\S]*?)\n-->/)?.[1]); }
      catch { throw new ReceiptError("canonical_receipt_invalid"); }
      assertReceiptRecord(record, options.repository, entry.pr_number, entry.landing_commit);
      const attempt = record.attempts.find(item => item.id === `${options.run}:${options.attempt}`);
      requireEvidence(attempt && attempt.validation.orchestration_commit === options.orchestration,
        "push_receipt_attempt_unavailable");
      requireEvidence(record.latest_attempt === attempt.id, "push_receipt_superseded");
      result.persisted = true;
      result.assessment = attempt.assessment;
      result.blockers.push(...attempt.blockers);
      const allJobs = await api.pages(`/actions/runs/${options.run}/attempts/${options.attempt}/jobs`, "jobs");
      requireEvidence(allJobs.every(job => identifier(job?.id) && typeof job.name === "string"),
        "github_evidence_invalid");
      const jobs = allJobs.filter(job => job.name ===
          `Receipt PR ${entry.pr_number} / ${entry.landing_commit} / Persist the delivery assessment`);
      requireEvidence(jobs.length === 1 && jobs[0].run_id === options.run &&
        jobs[0].run_attempt === options.attempt && jobs[0].head_sha === options.orchestration &&
        jobs[0].status === "completed" && jobs[0].conclusion === "success", "push_publication_job_unsuccessful");
    } catch (error) {
      if (!(error instanceof ReceiptError)) throw error;
      result.assessment = "pending";
      result.blockers.push(error.message);
    }
    summary.landings.push(result);
  }
  summary.complete = summary.exceptions.length === 0 &&
    summary.landings.every(item => item.persisted && item.assessment === "complete");
  return summary;
}

try {
  const options = arguments_();
  const api = github(options);
  const result = options.phase === "admit" ? await admit(options, api) : await summarize(options, api);
  console.log(JSON.stringify(result));
  if (options.phase === "summarize" && !result.complete) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ complete: false,
    errors: [error instanceof ReceiptError ? error.message : "push_internal_error"] }));
  process.exitCode = 1;
}
