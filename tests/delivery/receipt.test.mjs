import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const command = join(root, "scripts", "delivery-receipt.mjs");
const repository = "geevensingh/trmnl-calendar";
const bot = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const human = { id: 42, login: "maintainer", type: "User" };

async function fixture(t, { squash = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agenda receipt ")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  await mkdir(checkout);
  const env = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never"
  });
  const git = (...args) => {
    const result = spawnSync("git", ["--no-pager", ...args], {
      cwd: checkout, env: isolatedGitEnvironment({}, env), encoding: "utf8", timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main", "--template=");
  git("config", "user.name", "Synthetic maintainer");
  git("config", "user.email", "maintainer@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "core.autocrlf", "false");
  await writeFile(join(checkout, "content.txt"), "base\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("switch", "--quiet", "-c", "feature");
  await writeFile(join(checkout, "content.txt"), "accepted implementation\n");
  git("commit", "--quiet", "-am", "Implementation");
  const head = git("rev-parse", "HEAD");
  git("switch", "--quiet", "main");
  if (squash) {
    git("merge", "--quiet", "--squash", "feature");
    git("commit", "--quiet", "-m", "Human squash");
  } else {
    git("merge", "--quiet", "--no-ff", "feature", "-m", "Human merge");
  }
  const landing = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const remote = join(directory, "origin.git");
  git("init", "--quiet", "--bare", "--template=", remote);
  git("remote", "add", "origin", remote);
  git("push", "--quiet", "origin", "main");
  const state = {
    pr: {
      number: 67, state: "closed", merged: true, merged_at: "2026-10-26T20:00:00Z", merged_by: human,
      merge_commit_sha: landing, head: { sha: head }, base: { sha: base, ref: "main", repo: { full_name: repository } },
      body: "Routine change; incidental #8 and fixes #9 are not a delivery declaration."
    },
    timeline: [{ event: "merged", actor: human, commit_id: landing, created_at: "2026-10-26T20:00:00Z" }],
    reviews: [{ id: 55, state: "COMMENTED", user: human, commit_id: head, submitted_at: "2026-10-26T19:00:00Z" }],
    permission: { permission: "admin", user: human },
    run: { id: 100, run_attempt: 1, event: "workflow_dispatch", head_sha: base, head_branch: "main",
      path: ".github/workflows/delivery-receipt.yml", repository: { full_name: repository } },
    jobs: [],
    comments: [], writes: [], unavailable: null, writeFailure: false,
    issues: { 8: { number: 8, state: "open", title: "Activation", body: "Retain the activation requirements." } },
    ticketComments: { 8: [] }, evidence: {}
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(`/repos/${repository}`, "");
    response.setHeader("Content-Type", "application/json");
    if (state.unavailable === path) {
      response.writeHead(503).end(JSON.stringify({ message: "SECRET /private/machine https://secret.invalid" }));
      return;
    }
    let data;
    if (request.method === "GET") {
      data = {
        "/pulls/67": state.pr, "/issues/67/timeline": state.timeline, "/pulls/67/reviews": state.reviews,
        "/collaborators/maintainer/permission": state.permission,
        "/actions/runs/100/attempts/1": state.run,
        "/actions/runs/100/attempts/2": state.run,
        "/actions/runs/100/attempts/1/jobs": { jobs: state.jobs },
        "/actions/runs/100/attempts/2/jobs": { jobs: state.jobs },
        "/issues/67/comments": state.comments
      }[path];
      if (data === undefined && /^\/issues\/\d+$/.test(path)) data = state.issues[path.split("/")[2]];
      if (data === undefined && /^\/issues\/\d+\/comments$/.test(path)) data = state.ticketComments[path.split("/")[2]];
      if (data === undefined && /^\/issues\/comments\/\d+$/.test(path)) data = state.evidence[path.split("/")[3]];
      if (data === undefined && /^\/collaborators\/[^/]+\/permission$/.test(path)) data = state.permissions?.[path.split("/")[2]];
    } else {
      let text = "";
      for await (const chunk of request) text += chunk;
      const payload = JSON.parse(text);
      state.writes.push({ method: request.method, path, payload });
      if (state.writeFailure || state.writeFailurePath === path) {
        response.writeHead(403).end(JSON.stringify({ message: "SECRET write diagnostic" }));
        return;
      }
      if (request.method === "POST" && path === "/issues/67/comments") {
        data = { id: 900, user: bot, performed_via_github_app: { id: 15368 }, body: payload.body };
        state.comments.push(data);
      } else if (request.method === "PATCH" && path === "/issues/comments/900") {
        data = state.comments.find(comment => comment.id === 900);
        data.body = payload.body;
      } else if (request.method === "POST" && /^\/issues\/\d+\/comments$/.test(path)) {
        const comments = state.ticketComments[path.split("/")[2]];
        if (comments) {
          data = { id: 1000 + state.writes.length, user: bot, performed_via_github_app: { id: 15368 }, body: payload.body };
          comments.push(data);
        }
      } else if (request.method === "PATCH" && /^\/issues\/comments\/\d+$/.test(path)) {
        data = Object.values(state.ticketComments).flat().find(comment => comment.id === Number(path.split("/")[3]));
        if (data) data.body = payload.body;
      }
    }
    if (Array.isArray(data)) {
      const page = Number(url.searchParams.get("page") ?? 1);
      data = data.slice((page - 1) * 100, page * 100);
    }
    if (data === undefined) response.writeHead(404).end("{}");
    else response.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = `http://127.0.0.1:${server.address().port}`;
  function invoke(script, args, overrides = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: checkout, env: { ...env, GH_TOKEN: "synthetic-token", ...overrides }, windowsHide: true
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", status => resolve({ status, stdout, stderr }));
    });
  }
  async function collect(phase = "prepare", plan = null, attempt = 1, overrides = {}) {
    const args = [phase, "--repository", repository, "--pr", "67", "--run-id", "100", "--attempt", `${attempt}`,
      "--orchestration-commit", base, "--api-url", api];
    if (plan) {
      const path = join(directory, "plan.json");
      await writeFile(path, JSON.stringify(plan));
      args.push("--plan", path);
    }
    return invoke(command, args, overrides);
  }
  function full(plan, conclusion = "success") {
    assert.equal(plan.provenance.landing_commit, landing);
    assert.equal(plan.provenance.landing_tree, tree);
    state.jobs = [{
      id: 200, name: "Exact landing Full", status: "completed", conclusion,
      run_id: 100, run_attempt: state.run.run_attempt, head_sha: base,
      steps: ["Check out the exact landing", "Verify the exact checkout", "Run the shared Full validation"]
        .map(name => ({ name, status: "completed",
          conclusion: name === "Run the shared Full validation" ? conclusion : "success" }))
    }];
  }
  return { directory, checkout, git, env, base, head, landing, tree, state, collect, full, invoke };
}

function output(result, status = 0) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(status === 0 ? result.stderr : result.stdout, "");
  return JSON.parse(status === 0 ? result.stdout : result.stderr);
}

function receipt(state) {
  assert.equal(state.comments.length, 1);
  const match = state.comments[0].body.match(/<!-- delivery-receipt:v1\n([\s\S]*?)\n-->/);
  assert.ok(match, state.comments[0].body);
  return JSON.parse(match[1]);
}

function declare(tickets) {
  return `Incidental #9; fixes #10 is not delivery scope.\n\n\`\`\`delivery\n${JSON.stringify({ version: 1, tickets })}\n\`\`\``;
}

function accept(f, requirements, overrides = {}) {
  const record = { version: 1, repository, pr_number: 67, landing_commit: f.landing,
    ticket: 8, gate: "azure-activation", requirements_sha256: requirements, outcome: "accepted", ...overrides };
  f.state.evidence[500] = { id: 500, user: human, issue_url: `https://api.github.com/repos/${repository}/issues/8`,
    created_at: "2026-10-26T21:00:00Z", updated_at: "2026-10-26T21:00:00Z",
    body: `<!-- delivery-acceptance:v1\n${JSON.stringify(record)}\n-->` };
  return record;
}

test("manual dispatch associates only declared delivery issues and preserves their requirements and state", async t => {
  const f = await fixture(t);
  f.state.pr.body = declare([{ issue: 8, gates: [] }]);
  const before = structuredClone({ pr: f.state.pr, issues: f.state.issues });
  const plan = output(await f.collect());
  f.full(plan);
  const result = output(await f.collect("publish", plan));
  assert.equal(result.assessment, "complete");
  const attempt = receipt(f.state).attempts[0];
  assert.equal(attempt.repository_change.assessment, "complete");
  assert.equal(attempt.ticket_scope.assessment, "complete");
  assert.equal(attempt.ticket_scope.declaration.status, "valid");
  assert.deepEqual(attempt.ticket_scope.tickets.map(ticket => ticket.issue), [8]);
  assert.equal(f.state.ticketComments[8].length, 1);
  assert.match(f.state.ticketComments[8][0].body,
    /https:\/\/github\.com\/geevensingh\/trmnl-calendar\/pull\/67#issuecomment-900/);
  assert.deepEqual(f.state.writes.map(write => `${write.method} ${write.path}`),
    ["POST /issues/67/comments", "POST /issues/8/comments", "PATCH /issues/comments/900"]);
  assert.deepEqual({ pr: f.state.pr, issues: f.state.issues }, before);
});

test("later scoped human acceptance reconciles a pending activation gate without rewriting history or duplicating pointers", async t => {
  const f = await fixture(t);
  const gate = { id: "azure-activation", kind: "acceptance", evidence: [{ kind: "issue-comment", id: 500 }] };
  f.state.pr.body = declare([{ issue: 8, gates: [gate] }]);
  const metadata = structuredClone({ pr: f.state.pr, issues: f.state.issues });
  const first = output(await f.collect());
  f.full(first);
  assert.equal(output(await f.collect("publish", first)).assessment, "pending");
  const previous = structuredClone(receipt(f.state).attempts[0]);
  assert.equal(previous.repository_change.assessment, "complete");
  assert.deepEqual(previous.ticket_scope.tickets[0].gates[0].blockers, ["github_evidence_unavailable"]);
  const acceptance = accept(f, previous.ticket_scope.declaration.requirements_sha256);
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "complete");
  const record = receipt(f.state);
  assert.deepEqual(record.attempts[0], previous);
  assert.equal(record.latest_attempt, "100:2");
  const latest = record.attempts[1];
  assert.equal(latest.ticket_scope.declaration.requirements_sha256, previous.ticket_scope.declaration.requirements_sha256);
  assert.equal(latest.ticket_scope.declaration.sha256, previous.ticket_scope.declaration.sha256);
  assert.equal(latest.validation.run_attempt, 2);
  assert.equal(latest.validation.run_on_commit, f.landing);
  const fact = latest.ticket_scope.tickets[0].gates[0].facts[0];
  assert.equal(fact.kind, "issue-comment");
  assert.equal(fact.id, 500);
  assert.deepEqual(fact.actor, human);
  assert.equal(fact.permission_observed, "admin");
  assert.deepEqual(fact.acceptance, acceptance);
  assert.equal(f.state.ticketComments[8].length, 1);
  assert.equal(f.state.writes.filter(write => write.path === "/issues/8/comments").length, 1);
  assert.deepEqual({ pr: f.state.pr, issues: f.state.issues }, metadata);
});

test("a declared review gate requires an actual applicable approval rather than inventing one from human landing", async t => {
  const f = await fixture(t);
  f.state.pr.body = declare([{ issue: 8, gates: [
    { id: "design-review", kind: "review", evidence: [{ kind: "pr-review", id: 55 }] }
  ] }]);
  const first = output(await f.collect());
  f.full(first);
  assert.equal(output(await f.collect("publish", first)).assessment, "pending");
  assert.equal(receipt(f.state).attempts[0].provenance.reviews[0].state, "COMMENTED");
  assert.ok(receipt(f.state).attempts[0].ticket_scope.tickets[0].gates[0].blockers.includes("gate_review_not_applicable"));
  f.state.reviews[0].state = "APPROVED";
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "complete");
  const fact = receipt(f.state).attempts[1].ticket_scope.tickets[0].gates[0].facts[0];
  assert.equal(fact.kind, "pr-review");
  assert.equal(fact.review.commit, f.head);
  assert.equal(fact.review.state, "APPROVED");
  assert.equal(fact.permission_observed, "admin");
  assert.equal(receipt(f.state).attempts[0].provenance.reviews[0].state, "COMMENTED");
});

test("ambiguous, dismissed, stale or superseded review evidence cannot satisfy a declared gate", async t => {
  for (const [name, mutate] of [
    ["another revision", f => { f.state.reviews[0].commit_id = f.base; }],
    ["dismissed", f => { f.state.reviews[0].state = "DISMISSED"; }],
    ["missing", f => { f.state.reviews = []; }],
    ["ambiguous duplicate", f => { f.state.reviews.push(structuredClone(f.state.reviews[0])); }],
    ["later changes requested", f => { f.state.reviews.push({
      ...f.state.reviews[0], id: 56, state: "CHANGES_REQUESTED", submitted_at: "2026-10-26T19:30:00Z"
    }); }]
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    f.state.reviews[0].state = "APPROVED";
    f.state.pr.body = declare([{ issue: 8, gates: [
      { id: "design-review", kind: "review", evidence: [{ kind: "pr-review", id: 55 }] }
    ] }]);
    mutate(f);
    const plan = output(await f.collect());
    f.full(plan);
    assert.equal(output(await f.collect("publish", plan)).assessment, "pending");
    const attempt = receipt(f.state).attempts[0];
    assert.equal(attempt.repository_change.assessment, "complete");
    assert.deepEqual(attempt.ticket_scope.tickets[0].gates[0].blockers, ["gate_review_not_applicable"]);
  });
});

test("a failed ticket pointer remains a durable blocker and cannot erase independent ticket publication", async t => {
  const f = await fixture(t);
  f.state.issues[9] = { number: 9, state: "closed", title: "Another delivery", body: "Preserve closed state." };
  f.state.ticketComments[9] = [];
  f.state.pr.body = declare([{ issue: 8, gates: [] }, { issue: 9, gates: [] }]);
  const metadata = structuredClone({ pr: f.state.pr, issues: f.state.issues });
  f.state.writeFailurePath = "/issues/8/comments";
  const first = output(await f.collect());
  f.full(first);
  const result = output(await f.collect("publish", first), 1);
  assert.deepEqual(result.errors, ["ticket_pointer_publication_failed"]);
  const previous = structuredClone(receipt(f.state).attempts[0]);
  assert.equal(previous.assessment, "pending");
  assert.equal(previous.repository_change.assessment, "complete");
  assert.equal(previous.ticket_scope.tickets[0].pointer.outcome, "failed");
  assert.ok(previous.ticket_scope.tickets[0].blockers.includes("receipt_write_failed"));
  assert.equal(previous.ticket_scope.tickets[1].pointer.outcome, "published");
  assert.equal(f.state.ticketComments[9].length, 1);
  delete f.state.writeFailurePath;
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "complete");
  assert.deepEqual(receipt(f.state).attempts[0], previous);
  assert.equal(f.state.ticketComments[8].length, 1);
  assert.equal(f.state.ticketComments[9].length, 1);
  assert.deepEqual({ pr: f.state.pr, issues: f.state.issues }, metadata);
  assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET/);
});

test("green Full and arbitrary evidence cannot certify an activation gate without scoped attributable acceptance", async t => {
  const cases = [
    ["wrong landing", f => accept(f, f.requirements, { landing_commit: "a".repeat(40) }), "gate_acceptance_scope_mismatch"],
    ["wrong repository", f => accept(f, f.requirements, { repository: "SECRET/private" }), "gate_acceptance_scope_mismatch"],
    ["wrong PR", f => accept(f, f.requirements, { pr_number: 66 }), "gate_acceptance_scope_mismatch"],
    ["wrong ticket", f => accept(f, f.requirements, { ticket: 9 }), "gate_acceptance_scope_mismatch"],
    ["wrong gate", f => accept(f, f.requirements, { gate: "device" }), "gate_acceptance_scope_mismatch"],
    ["changed requirements", f => accept(f, "a".repeat(64)), "gate_acceptance_scope_mismatch"],
    ["rejected", f => accept(f, f.requirements, { outcome: "rejected" }), "gate_acceptance_not_accepted"],
    ["arbitrary prose", f => { f.state.evidence[500].body = "Approved! https://SECRET.invalid /private/machine"; }, "gate_acceptance_invalid"],
    ["extra private field", f => accept(f, f.requirements, { secret: "SECRET /private/machine" }), "gate_acceptance_invalid"],
    ["duplicate field", f => { f.state.evidence[500].body = f.state.evidence[500].body.replace('"version":1', '"version":1,"version":1'); },
      "gate_acceptance_invalid"],
    ["ambiguous acceptance records", f => { f.state.evidence[500].body += "\n<!-- delivery-acceptance:v2\nSECRET\n-->"; },
      "gate_acceptance_invalid"],
    ["wrong comment scope", f => { f.state.evidence[500].issue_url = `https://api.github.com/repos/${repository}/issues/9`; },
      "gate_evidence_source_invalid"],
    ["before landing", f => { f.state.evidence[500].updated_at = "2026-10-25T21:00:00Z"; }, "gate_evidence_source_invalid"],
    ["unavailable", f => { f.state.unavailable = "/issues/comments/500"; }, "github_evidence_unavailable"],
    ["bot", f => { f.state.evidence[500].user = bot; }, "gate_evidence_actor_unauthorized"],
    ["unprivileged author", f => {
      f.state.evidence[500].user = { id: 43, login: "reader", type: "User" };
      f.state.permissions = { reader: { permission: "read", user: f.state.evidence[500].user } };
    }, "gate_evidence_actor_unauthorized"]
  ];
  for (const [name, mutate, code] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    f.state.pr.body = declare([{ issue: 8, gates: [
      { id: "azure-activation", kind: "acceptance", evidence: [{ kind: "issue-comment", id: 500 }] }
    ] }]);
    const plan = output(await f.collect());
    f.requirements = plan.declaration.requirements_sha256;
    accept(f, f.requirements);
    await mutate(f);
    f.full(plan);
    const result = output(await f.collect("publish", plan));
    assert.equal(result.assessment, "pending");
    const attempt = receipt(f.state).attempts[0];
    assert.equal(attempt.repository_change.assessment, "complete");
    assert.deepEqual(attempt.ticket_scope.tickets[0].gates[0].blockers, [code]);
    if (code === "gate_acceptance_scope_mismatch") assert.equal(attempt.ticket_scope.tickets[0].gates[0].facts[0].acceptance, null);
    assert.doesNotMatch(JSON.stringify(f.state.comments) + JSON.stringify(result), /SECRET|\/private\/machine/);
  });
});

test("contradictory owned ticket history cannot be promoted or overwritten on reconciliation", async t => {
  const f = await fixture(t);
  f.state.pr.body = declare([{ issue: 8, gates: [
    { id: "azure-activation", kind: "acceptance", evidence: [] }
  ] }]);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const record = receipt(f.state);
  record.attempts[0].ticket_scope.tickets[0].gates[0].assessment = "complete";
  f.state.comments[0].body = `<!-- delivery-receipt:v1\n${JSON.stringify(record)}\n-->`;
  const before = structuredClone(f.state.comments);
  const writes = f.state.writes.length;
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.deepEqual(output(await f.collect("publish", second, 2), 1).errors, ["canonical_receipt_invalid"]);
  assert.deepEqual(f.state.comments, before);
  assert.equal(f.state.writes.length, writes);
});

test("reconciliation reobserves mutable acceptance and preserves the actual earlier complete outcome", async t => {
  const f = await fixture(t);
  f.state.pr.body = declare([{ issue: 8, gates: [
    { id: "azure-activation", kind: "acceptance", evidence: [{ kind: "issue-comment", id: 500 }] }
  ] }]);
  const first = output(await f.collect());
  accept(f, first.declaration.requirements_sha256);
  f.full(first);
  assert.equal(output(await f.collect("publish", first)).assessment, "complete");
  const previous = structuredClone(receipt(f.state).attempts[0]);
  accept(f, first.declaration.requirements_sha256, { outcome: "rejected" });
  f.state.evidence[500].updated_at = "2026-10-26T21:30:00Z";
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "pending");
  const record = receipt(f.state);
  assert.deepEqual(record.attempts[0], previous);
  const latest = record.attempts[1];
  assert.equal(latest.validation.run_attempt, 2);
  assert.equal(latest.ticket_scope.tickets[0].gates[0].facts[0].acceptance.outcome, "rejected");
  assert.notEqual(latest.ticket_scope.tickets[0].gates[0].facts[0].body_sha256,
    previous.ticket_scope.tickets[0].gates[0].facts[0].body_sha256);
  assert.equal(f.state.ticketComments[8].length, 1);
  assert.match(f.state.comments[0].body, /Earlier complete observation: yes; not the latest assessment/);
});

test("satisfied ticket gates cannot override unsuccessful Full, changed provenance or lost live publication", async t => {
  for (const state of ["failure", "cancelled", "provenance changed", "unreachable"]) await t.test(state, async t => {
    const f = await fixture(t);
    f.state.pr.body = declare([{ issue: 8, gates: [
      { id: "azure-activation", kind: "acceptance", evidence: [{ kind: "issue-comment", id: 500 }] }
    ] }]);
    const plan = output(await f.collect());
    accept(f, plan.declaration.requirements_sha256);
    f.full(plan, ["failure", "cancelled"].includes(state) ? state : "success");
    if (state === "provenance changed") f.state.pr.head.sha = f.base;
    if (state === "unreachable") f.git("--git-dir", join(f.directory, "origin.git"), "update-ref", "refs/heads/main", f.base);
    const result = output(await f.collect("publish", plan));
    assert.equal(result.assessment, state === "failure" ? "failed" : "pending");
    const attempt = receipt(f.state).attempts[0];
    assert.equal(attempt.ticket_scope.tickets[0].gates[0].assessment, "complete");
    assert.equal(attempt.ticket_scope.assessment, "pending");
    assert.ok(attempt.blockers.includes("repository_change_not_complete"));
  });
});

test("missing, ambiguous and unrecognized gate evidence and invalid delivery issues stay explicit pending", async t => {
  for (const state of ["missing", "ambiguous", "wrong evidence kind", "issue unavailable", "PR is not a ticket"]) await t.test(state, async t => {
    const f = await fixture(t);
    const evidence = state === "missing" ? [] : state === "wrong evidence kind" ?
      [{ kind: "pr-review", id: 55 }] : [{ kind: "issue-comment", id: 500 }];
    if (state === "ambiguous") evidence.push({ kind: "issue-comment", id: 501 });
    f.state.pr.body = declare([{ issue: 8, gates: [{ id: "azure-activation", kind: "acceptance", evidence }] }]);
    const plan = output(await f.collect());
    accept(f, plan.declaration.requirements_sha256);
    f.state.evidence[501] = { ...f.state.evidence[500], id: 501 };
    if (state === "issue unavailable") f.state.unavailable = "/issues/8";
    if (state === "PR is not a ticket") f.state.issues[8].pull_request = {};
    f.full(plan);
    const result = output(await f.collect("publish", plan));
    assert.equal(result.assessment, "pending");
    assert.ok(result.blockers.includes({
      missing: "gate_evidence_missing", ambiguous: "gate_evidence_ambiguous",
      "wrong evidence kind": "gate_evidence_kind_unsupported", "issue unavailable": "github_evidence_unavailable",
      "PR is not a ticket": "delivery_issue_required"
    }[state]));
    assert.equal(f.state.ticketComments[8].length, ["issue unavailable", "PR is not a ticket"].includes(state) ? 0 : 1);
  });
});

test("foreign, malformed and ambiguous ticket pointers are never overwritten or silently duplicated", async t => {
  for (const state of ["foreign owner", "malformed", "ambiguous", "wrong identity"]) await t.test(state, async t => {
    const f = await fixture(t);
    f.state.pr.body = declare([{ issue: 8, gates: [] }]);
    const first = output(await f.collect());
    f.full(first);
    output(await f.collect("publish", first));
    const pointer = f.state.ticketComments[8][0];
    if (state === "foreign owner") pointer.user = human;
    if (state === "malformed") pointer.body = "<!-- delivery-receipt-pointer:v1\nSECRET /private/machine\n-->";
    if (state === "ambiguous") f.state.ticketComments[8].push({ ...pointer, id: 1005 });
    if (state === "wrong identity") pointer.body = pointer.body.replace('"issue_number":8', '"issue_number":9');
    const before = structuredClone(f.state.ticketComments);
    f.state.run.run_attempt = 2;
    const second = output(await f.collect("prepare", null, 2));
    f.full(second);
    assert.deepEqual(output(await f.collect("publish", second, 2), 1).errors, ["ticket_pointer_publication_failed"]);
    assert.deepEqual(f.state.ticketComments, before);
    const attempt = receipt(f.state).attempts[1];
    assert.equal(attempt.assessment, "pending");
    assert.equal(attempt.ticket_scope.tickets[0].pointer.outcome, "failed");
    assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET|\/private\/machine/);
  });
});

test("sequential reconciliation retains original v1 attempts without retrofitting ticket evidence", async t => {
  const f = await fixture(t);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const original = receipt(f.state);
  delete original.attempts[0].ticket_scope;
  f.state.comments[0].body = `<!-- delivery-receipt:v1\n${JSON.stringify(original)}\n-->`;
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "complete");
  assert.deepEqual(receipt(f.state).attempts[0], original.attempts[0]);
  assert.equal(receipt(f.state).attempts[1].ticket_scope.assessment, "not-applicable");
});

test("pointer discovery paginates without modifying foreign ticket comments or creating a duplicate", async t => {
  const f = await fixture(t);
  f.state.pr.body = declare([{ issue: 8, gates: [] }]);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const pointer = f.state.ticketComments[8][0];
  const foreign = Array.from({ length: 100 }, (_, index) =>
    ({ id: index + 10, user: human, body: `Preserve unrelated issue comment ${index} byte-for-byte.` }));
  f.state.ticketComments[8] = [...structuredClone(foreign), pointer];
  const writes = f.state.writes.length;
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  assert.equal(output(await f.collect("publish", second, 2)).assessment, "complete");
  assert.deepEqual(f.state.ticketComments[8].slice(0, 100), foreign);
  assert.equal(f.state.ticketComments[8].at(-1).id, pointer.id);
  assert.equal(f.state.ticketComments[8].length, 101);
  assert.deepEqual(f.state.writes.slice(writes).map(write => write.path),
    ["/issues/comments/900", "/issues/comments/900"]);
});

async function snapshot(directory) {
  const files = {};
  async function visit(relative) {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files[path] = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
    }
  }
  await visit("");
  return files;
}

test("manual dispatch persists exact human-merge acceptance, Full and live publication in one durable receipt", async t => {
  const f = await fixture(t);
  const refs = f.git("for-each-ref", "--format=%(refname) %(objectname)");
  const config = await readFile(join(f.checkout, ".git", "config"));
  const plan = output(await f.collect());
  f.full(plan);
  const result = output(await f.collect("publish", plan));
  assert.equal(result.persisted, true);
  assert.equal(result.assessment, "complete");
  const record = receipt(f.state);
  assert.equal(record.repository, repository);
  assert.equal(record.pr_number, 67);
  assert.equal(record.landing_commit, f.landing);
  assert.equal(record.latest_attempt, "100:1");
  const attempt = record.attempts[0];
  assert.equal(attempt.scope, "repository-change");
  assert.equal(attempt.provenance.final_head, f.head);
  assert.deepEqual(attempt.provenance.landing_parents, [f.base, f.head]);
  assert.equal(attempt.provenance.acceptance.kind, "authorized-human-merge");
  assert.equal(attempt.provenance.reviews[0].state, "COMMENTED");
  assert.equal(attempt.validation.run_on_commit, f.landing);
  assert.equal(attempt.validation.evaluated_tree, f.tree);
  assert.equal(attempt.validation.command, "pwsh -NoLogo -NoProfile -NonInteractive -File ./scripts/validate.ps1 -Scope Full");
  assert.equal(attempt.validation.job_id, 200);
  assert.equal(attempt.publication.remote_commit, f.landing);
  assert.equal(attempt.publication.reachable, true);
  assert.ok(Date.parse(attempt.publication.checked_at));
  assert.deepEqual(attempt.blockers, []);
  assert.deepEqual(f.state.writes.map(write => `${write.method} ${write.path}`), ["POST /issues/67/comments"]);
  assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)"), refs);
  assert.deepEqual(await readFile(join(f.checkout, ".git", "config")), config);
  assert.equal(f.state.pr.state, "closed");
  assert.match(f.state.pr.body, /incidental #8/);
});

test("a later failed Full updates the canonical receipt without hiding an earlier complete observation", async t => {
  const f = await fixture(t, { squash: true });
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const previous = structuredClone(receipt(f.state).attempts[0]);
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second, "failure");
  const result = output(await f.collect("publish", second, 2));
  assert.equal(result.assessment, "failed");
  assert.equal(f.state.comments[0].id, 900);
  const record = receipt(f.state);
  assert.equal(record.latest_attempt, "100:2");
  assert.equal(record.attempts.length, 2);
  assert.deepEqual(record.attempts[0], previous);
  assert.equal(record.attempts[0].provenance.merge_kind, "squash");
  assert.equal(record.attempts[1].validation.outcome, "failure");
  assert.equal(record.attempts[1].validation.run_on_commit, f.landing);
  assert.deepEqual(record.attempts[1].blockers, ["full_not_successful"]);
  assert.match(f.state.comments[0].body, /Earlier complete observation: yes; not the latest assessment/);
  assert.deepEqual(f.state.writes.map(write => write.method), ["POST", "PATCH"]);
});

test("live publication accepts an older reachable landing and redacts invalid remote arguments", async t => {
  const f = await fixture(t);
  await writeFile(join(f.checkout, "new-main.txt"), "later main change\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Later published history");
  const tip = f.git("rev-parse", "HEAD");
  f.git("push", "--quiet", "origin", "main");
  f.git("update-ref", "refs/remotes/origin/main", f.base);
  const proof = join(root, "scripts", "check-publication.mjs");
  const actual = output(await f.invoke(proof, ["--landing-commit", f.landing]));
  assert.equal(actual.remote_commit, tip);
  assert.equal(actual.reachable, true);
  const invalid = await f.invoke(proof, ["--landing-commit", f.landing, "--remote", "https://SECRET@private.invalid"]);
  const rejected = output(invalid, 1);
  assert.deepEqual(rejected.errors, ["configured_remote_name_required"]);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /SECRET|private\.invalid/);
  const plan = output(await f.collect());
  f.full(plan);
  output(await f.collect("publish", plan));
  assert.equal(receipt(f.state).attempts[0].publication.remote_commit, tip);
});

test("untrusted validation API diagnostics cannot become durable receipt data", async t => {
  const f = await fixture(t);
  const plan = output(await f.collect());
  f.full(plan);
  f.state.jobs[0].conclusion = "SECRET https://private.invalid /private/machine";
  const result = output(await f.collect("publish", plan));
  assert.equal(result.assessment, "pending");
  assert.deepEqual(result.blockers, ["validation_outcome_invalid"]);
  assert.equal(receipt(f.state).attempts[0].validation.outcome, "unavailable");
  assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET|private\.invalid|\/private\/machine/);
});

test("unavailable review evidence at finalization persists pending rather than inheriting prepared acceptance", async t => {
  const f = await fixture(t);
  const plan = output(await f.collect());
  f.full(plan);
  f.state.unavailable = "/pulls/67/reviews";
  const result = output(await f.collect("publish", plan));
  assert.equal(result.assessment, "pending");
  assert.deepEqual(result.blockers, ["github_evidence_unavailable"]);
  const attempt = receipt(f.state).attempts[0];
  assert.equal(attempt.provenance.acceptance, null);
  assert.equal(attempt.validation.run_on_commit, f.landing);
  assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET|private\.invalid|\/private\/machine/);
});

test("malformed owned receipt history is preserved byte-for-byte and never echoed into a new write", async t => {
  const f = await fixture(t);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const tampered = receipt(f.state);
  tampered.attempts[0].unexpected = "SECRET /private/machine";
  f.state.comments[0].body = `<!-- delivery-receipt:v1\n${JSON.stringify(tampered)}\n-->`;
  const before = structuredClone(f.state.comments);
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  const result = output(await f.collect("publish", second, 2), 1);
  assert.deepEqual(result.errors, ["canonical_receipt_invalid"]);
  assert.deepEqual(f.state.comments, before);
  assert.equal(f.state.writes.length, 1);
});

test("missing objects retain the authoritative full landing and head identities but cannot establish acceptance", async t => {
  const f = await fixture(t);
  f.state.pr.head.sha = "a".repeat(40);
  const plan = output(await f.collect());
  assert.equal(plan.provenance.final_head, "a".repeat(40));
  assert.equal(plan.provenance.landing_commit, f.landing);
  assert.equal(plan.provenance.acceptance, null);
  assert.deepEqual(plan.blockers, ["commit_object_unavailable"]);
  const result = output(await f.collect("publish", plan));
  assert.equal(result.assessment, "pending");
  assert.equal(receipt(f.state).attempts[0].provenance.landing_commit, f.landing);
});

test("malformed and ambiguous explicit declarations stay pending without inferring incidental ticket scope", async t => {
  for (const declaration of [
    ["<!-- delivery\n{not json", "malformed"], ["## Delivery\nTickets: #8", "malformed"], ["```delivery\n{}", "malformed"],
    ["``` delivery\n{not json", "malformed"], ["   ## Delivery\nTickets: #8", "malformed"], ["~~~delivery\n{}", "malformed"],
    ['```delivery\n{"version":1,"version":1,"tickets":[{"issue":8,"gates":[]}]}\n```', "malformed"],
    [declare([{ issue: 8, gates: [] }]) + "\n<!-- delivery\nbroken", "ambiguous"],
    [declare([{ issue: 8, gates: [] }]) + "\n" + declare([{ issue: 8, gates: [] }]), "ambiguous"],
    [declare([{ issue: 8, gates: [] }, { issue: 8, gates: [] }]), "malformed"],
    [declare([{ issue: 8, gates: [{ id: "activation", kind: "acceptance", evidence: ["https://SECRET.invalid"] }] }]), "malformed"]
  ]) {
    await t.test(declaration[0].split("\n")[0], async t => {
      const f = await fixture(t);
      f.state.pr.body = declaration[0];
      const plan = output(await f.collect());
      f.full(plan);
      const result = output(await f.collect("publish", plan));
      assert.equal(result.assessment, "pending");
      assert.deepEqual(result.blockers, [`delivery_declaration_${declaration[1]}`]);
      const attempt = receipt(f.state).attempts[0];
      assert.equal(attempt.scope, "ticket-scoped");
      assert.equal(attempt.repository_change.assessment, "complete");
      assert.equal(f.state.writes.length, 1);
      assert.equal(f.state.writes[0].path, "/issues/67/comments");
      assert.equal(attempt.ticket_scope.declaration.status, declaration[1]);
      assert.equal(f.state.pr.body, declaration[0]);
      assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET/);
    });
  }
});

test("nonhuman, unauthorized, ambiguous and unexpected landing provenance cannot yield acceptance", async t => {
  const cases = [
    ["bot", f => { f.state.pr.merged_by = bot; }, "authorized_human_merge_required"],
    ["permission", f => { f.state.permission.permission = "read"; }, "authorized_human_merge_required"],
    ["timeline", f => { f.state.timeline.push(structuredClone(f.state.timeline[0])); }, "merge_provenance_ambiguous"],
    ["wrong head", f => { f.state.pr.head.sha = f.base; }, "unsupported_landing_mapping"],
    ["unexpected content", async f => {
      await writeFile(join(f.checkout, "unrelated.txt"), "unexpected landing edit\n");
      f.git("add", ".");
      f.git("commit", "--quiet", "-m", "Unexpected result");
      f.state.pr.merge_commit_sha = f.git("rev-parse", "HEAD");
      f.state.timeline[0].commit_id = f.state.pr.merge_commit_sha;
    }, "unexpected_landing_content"]
  ];
  for (const [name, mutate, blocker] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t);
      await mutate(f);
      const plan = output(await f.collect());
      assert.deepEqual(plan.blockers, [blocker]);
      assert.equal(plan.provenance.acceptance, null);
      const result = output(await f.collect("publish", plan));
      assert.equal(result.assessment, "pending");
      assert.ok(result.blockers.includes(blocker));
      assert.equal(receipt(f.state).attempts[0].provenance.acceptance, null);
    });
  }
});

test("wrong repository, target or unmerged PR is rejected without touching comments or PR metadata", async t => {
  for (const change of [
    pr => { pr.base.repo.full_name = "other/repository"; },
    pr => { pr.base.ref = "other"; },
    pr => { pr.merged = false; }
  ]) {
    const f = await fixture(t);
    change(f.state.pr);
    const result = output(await f.collect(), 1);
    assert.deepEqual(result.errors, ["expected_merged_main_pr_required"]);
    assert.deepEqual(f.state.writes, []);
  }
});

test("cancelled, blocked or another run's validation cannot satisfy exact-landing Full", async t => {
  for (const state of ["cancelled", "skipped", "missing job", "wrong revision", "wrong attempt", "wrong workflow", "inherited job"]) {
    await t.test(state, async t => {
      const f = await fixture(t);
      const plan = output(await f.collect());
      f.full(plan, ["cancelled", "skipped"].includes(state) ? state : "success");
      if (state === "missing job") f.state.jobs = [];
      if (state === "wrong revision") f.state.run.head_sha = f.head;
      if (state === "wrong attempt") f.state.run.run_attempt = 2;
      if (state === "wrong workflow") f.state.run.path = ".github/workflows/full-validation.yml";
      if (state === "inherited job") f.state.jobs[0].run_attempt = 2;
      const result = output(await f.collect("publish", plan));
      assert.equal(result.assessment, "pending");
      assert.notEqual(receipt(f.state).attempts[0].repository_change.assessment, "complete");
    });
  }
});

test("unreachable, unavailable and missing-object live observations block publication without cached-ref fallback", async t => {
  for (const state of ["unreachable", "unavailable", "missing object"]) {
    await t.test(state, async t => {
      const f = await fixture(t);
      if (state === "unreachable") f.git("--git-dir", join(f.directory, "origin.git"),
        "update-ref", "refs/heads/main", f.base);
      if (state === "unavailable") f.git("remote", "set-url", "origin", join(f.directory, "SECRET-missing.git"));
      if (state === "missing object") {
        const remote = join(f.directory, "origin.git");
        const tree = f.git("--git-dir", remote, "mktree");
        const tip = f.git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid",
          "--git-dir", remote, "commit-tree", tree, "-p", f.landing, "-m", "Remote-only commit");
        f.git("--git-dir", remote, "update-ref", "refs/heads/main", tip);
      }
      const plan = output(await f.collect());
      f.full(plan);
      const result = output(await f.collect("publish", plan));
      assert.equal(result.assessment, "pending");
      assert.equal(receipt(f.state).attempts[0].publication.reachable, false);
      assert.doesNotMatch(JSON.stringify(f.state.comments), /SECRET|agenda receipt|origin\.git/);
    });
  }
});

test("foreign receipt markers and failed comment writes remain explicit failures without claiming persistence", async t => {
  for (const state of ["foreign owner", "write failure"]) {
    await t.test(state, async t => {
      const f = await fixture(t);
      if (state === "foreign owner") f.state.comments.push({
        id: 901, user: human, body: "<!-- delivery-receipt:v1\n{\"foreign\":\"preserve\"}\n-->"
      });
      if (state === "write failure") f.state.writeFailure = true;
      const before = structuredClone(f.state.comments);
      const plan = output(await f.collect());
      f.full(plan);
      const result = output(await f.collect("publish", plan), 1);
      assert.equal(result.persisted, false);
      assert.deepEqual(result.errors, [state === "foreign owner" ? "receipt_ownership_invalid" : "receipt_write_failed"]);
      assert.deepEqual(f.state.comments, before);
      assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    });
  }
});

test("inherited Git selectors cannot inspect or alter a foreign owner's repository", async t => {
  const f = await fixture(t);
  const foreign = join(f.directory, "foreign.git");
  f.git("init", "--quiet", "--bare", "--template=", foreign);
  await writeFile(join(foreign, "owner-state.txt"), "preserve owner content\n");
  const before = await snapshot(foreign);
  const overrides = {
    GIT_DIR: foreign, GIT_WORK_TREE: f.directory, GIT_COMMON_DIR: foreign,
    GIT_INDEX_FILE: join(foreign, "foreign-index"), GIT_OBJECT_DIRECTORY: join(foreign, "objects"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "SECRET"
  };
  const plan = output(await f.collect("prepare", null, 1, overrides));
  f.full(plan);
  output(await f.collect("publish", plan, 1, overrides));
  assert.deepEqual(await snapshot(foreign), before);
  assert.equal(receipt(f.state).attempts[0].publication.remote_commit, f.landing);
});

test("paginated review provenance and canonical comments are fully retained without altering foreign comments", async t => {
  const f = await fixture(t);
  f.state.reviews = Array.from({ length: 101 }, (_, index) => ({ ...f.state.reviews[0], id: index + 1 }));
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const canonical = f.state.comments[0];
  assert.equal(receipt(f.state).attempts[0].provenance.reviews.length, 101);
  const foreign = Array.from({ length: 100 }, (_, index) =>
    ({ id: index + 1, user: human, body: `Foreign owner comment ${index}; preserve bytes.` }));
  f.state.comments = [...structuredClone(foreign), canonical];
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  output(await f.collect("publish", second, 2));
  assert.equal(f.state.comments.length, 101);
  assert.deepEqual(f.state.comments.slice(0, 100), foreign);
  assert.equal(f.state.comments[100].id, 900);
  assert.deepEqual(f.state.writes.map(write => write.method), ["POST", "PATCH"]);
});

test("exhausted durable-comment capacity fails without truncating any existing attempt", async t => {
  const f = await fixture(t);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  const record = receipt(f.state);
  const original = JSON.stringify(record);
  const template = f.state.comments[0].body;
  for (let run = 200; ; run++) {
    const next = structuredClone(record.attempts[0]);
    next.id = `${run}:1`;
    next.validation.run_id = run;
    const candidate = { ...record, attempts: [...record.attempts, next], latest_attempt: next.id };
    const body = template.replace(original, JSON.stringify(candidate));
    if (Buffer.byteLength(body, "utf8") > 60_000) break;
    record.attempts.push(next);
    record.latest_attempt = next.id;
  }
  f.state.comments[0].body = template.replace(original, JSON.stringify(record));
  const before = structuredClone(f.state.comments);
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  const result = output(await f.collect("publish", second, 2), 1);
  assert.deepEqual(result.errors, ["receipt_capacity_exceeded"]);
  assert.deepEqual(f.state.comments, before);
  assert.equal(f.state.writes.length, 1);
});

test("a changed scheduled landing identity remains pending even if the original Full succeeds", async t => {
  const f = await fixture(t);
  const plan = output(await f.collect());
  f.full(plan);
  f.state.pr.head.sha = f.base;
  const result = output(await f.collect("publish", plan));
  assert.equal(result.assessment, "pending");
  assert.ok(result.blockers.includes("prepared_landing_identity_changed"));
  const attempt = receipt(f.state).attempts[0];
  assert.equal(attempt.provenance.acceptance, null);
  assert.equal(attempt.validation.run_on_commit, f.landing);
});

test("an ambiguous canonical envelope fails without discarding either stored envelope", async t => {
  const f = await fixture(t);
  const first = output(await f.collect());
  f.full(first);
  output(await f.collect("publish", first));
  f.state.comments[0].body += "\n" + f.state.comments[0].body;
  const before = structuredClone(f.state.comments);
  f.state.run.run_attempt = 2;
  const second = output(await f.collect("prepare", null, 2));
  f.full(second);
  const result = output(await f.collect("publish", second, 2), 1);
  assert.deepEqual(result.errors, ["canonical_receipt_invalid"]);
  assert.deepEqual(f.state.comments, before);
  assert.equal(f.state.writes.length, 1);
});
