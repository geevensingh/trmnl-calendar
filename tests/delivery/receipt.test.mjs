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
      body: "Routine change; incidental #8 is not a delivery declaration."
    },
    timeline: [{ event: "merged", actor: human, commit_id: landing, created_at: "2026-10-26T20:00:00Z" }],
    reviews: [{ id: 55, state: "COMMENTED", user: human, commit_id: head, submitted_at: "2026-10-26T19:00:00Z" }],
    permission: { permission: "admin", user: human },
    run: { id: 100, run_attempt: 1, event: "workflow_dispatch", head_sha: base, head_branch: "main",
      path: ".github/workflows/delivery-receipt.yml", repository: { full_name: repository } },
    jobs: [],
    comments: [], writes: [], unavailable: null, writeFailure: false, writeFailures: new Set()
  };
  state.associations = { [landing]: [67] };
  state.associationResponses = {};
  state.additional = {};
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(`/repos/${repository}`, "");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
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
      const associated = path.match(/^\/commits\/([a-f0-9]+)\/pulls$/);
      if (associated) data = state.associationResponses[associated[1]] ??
        (state.associations[associated[1]] ?? []).map(number =>
          number === 67 ? state.pr : state.additional[number].pr);
      const other = path.match(/^\/(?:pulls|issues)\/(\d+)(\/(?:timeline|reviews|comments|commits))?$/);
      if (other && state.additional[other[1]]) {
        const entry = state.additional[other[1]];
        data = other[2] ? entry[other[2].slice(1)] : entry.pr;
      }
    } else {
      let text = "";
      for await (const chunk of request) text += chunk;
      const payload = JSON.parse(text);
      state.writes.push({ method: request.method, path, payload });
      if (state.writeFailure || state.writeFailures.has(path)) {
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
        const number = Number(path.split("/")[2]);
        const entry = state.additional[number];
        data = { id: 900 + number, user: bot, performed_via_github_app: { id: 15368 }, body: payload.body };
        entry.comments.push(data);
      }
    }
    if (Array.isArray(data)) {
      const page = Number(url.searchParams.get("page") ?? 1);
      data = data.slice((page - 1) * 100, page * 100);
    } else if (data?.jobs) {
      const page = Number(url.searchParams.get("page") ?? 1);
      data = { ...data, jobs: data.jobs.slice((page - 1) * 100, page * 100) };
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
  async function push(phase = "admit", batch = null, eventOverrides = {}, overrides = {}) {
    const path = join(directory, phase === "admit" ? "push-event.json" : "push-batch.json");
    const event = { repository: { full_name: repository }, ref: "refs/heads/main", before: base,
      after: landing, deleted: false, forced: false, ...eventOverrides };
    await writeFile(path, JSON.stringify(batch ?? event));
    return invoke(join(root, "scripts", "delivery-push.mjs"), [phase, "--repository", repository,
      "--run-id", "100", "--attempt", "1", "--orchestration-commit", state.run.head_sha,
      "--api-url", api, phase === "admit" ? "--event" : "--batch", path], overrides);
  }
  async function landingCollect(entry, phase = "prepare", plan = null) {
    const args = [phase, "--repository", repository, "--pr", `${entry.pr_number}`, "--run-id", "100",
      "--attempt", "1", "--orchestration-commit", state.run.head_sha, "--api-url", api,
      "--landing-commit", entry.landing_commit];
    if (plan) {
      const path = join(directory, `plan-${entry.pr_number}.json`);
      await writeFile(path, JSON.stringify(plan));
      args.push("--plan", path);
    }
    return invoke(command, args);
  }
  function pushFull(entry, plan, conclusion = "success") {
    assert.equal(plan.provenance.landing_commit, entry.landing_commit);
    assert.equal(plan.provenance.landing_tree, git("rev-parse", `${entry.landing_commit}^{tree}`));
    state.jobs.push({
      id: 200 + entry.pr_number, name: `Receipt PR ${entry.pr_number} / ${entry.landing_commit} / Exact landing Full`,
      run_id: 100, run_attempt: 1, head_sha: state.run.head_sha, status: "completed", conclusion,
      steps: ["Check out the exact landing", "Verify the exact checkout", "Run the shared Full validation"]
        .map(name => ({ name, status: "completed",
          conclusion: name === "Run the shared Full validation" ? conclusion : "success" }))
    });
  }
  function published(entry, conclusion = "success") {
    state.jobs.push({
      id: 400 + entry.pr_number,
      name: `Receipt PR ${entry.pr_number} / ${entry.landing_commit} / Persist the delivery assessment`,
      run_id: 100, run_attempt: 1, head_sha: state.run.head_sha, status: "completed", conclusion
    });
  }
  function asPush(after = landing) {
    Object.assign(state.run, { event: "push", head_sha: after, path: ".github/workflows/delivery-receipt-push.yml" });
  }
  async function land(number, squash = false) {
    const parent = git("rev-parse", "HEAD");
    git("switch", "--quiet", "-c", `feature-${number}`);
    await writeFile(join(checkout, `feature-${number}.txt`), `Implementation ${number}\n`);
    git("add", ".");
    git("commit", "--quiet", "-m", `Implementation ${number}`);
    const head = git("rev-parse", "HEAD");
    git("switch", "--quiet", "main");
    if (squash) {
      git("merge", "--quiet", "--squash", `feature-${number}`);
      git("commit", "--quiet", "-m", `Human squash ${number}`);
    } else {
      git("merge", "--quiet", "--no-ff", `feature-${number}`, "-m", `Human merge ${number}`);
    }
    const commit = git("rev-parse", "HEAD");
    state.additional[number] = {
      pr: { ...structuredClone(state.pr), number, merge_commit_sha: commit,
        head: { sha: head }, base: { sha: parent, ref: "main", repo: { full_name: repository } } },
      timeline: [{ ...structuredClone(state.timeline[0]), commit_id: commit }],
      reviews: [], comments: []
    };
    state.associations[commit] = [number];
    git("push", "--quiet", "origin", "main");
    return commit;
  }
  return { directory, checkout, git, env, base, head, landing, tree, state, collect, full, invoke,
    push, landingCollect, pushFull, published, asPush, requests, land };
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

function batchOutput(result, status = 0) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

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

test("a main push drives the immutable landing through independent Full to a persisted receipt and truthful batch summary", async t => {
  const f = await fixture(t);
  f.asPush();
  const batch = output(await f.push());
  assert.deepEqual(batch.landings, [{ pr_number: 67, landing_commit: f.landing }]);
  assert.deepEqual(batch.exceptions, []);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  f.state.jobs.unshift(...Array.from({ length: 100 }, (_, index) =>
    ({ id: index + 1000, name: `Unrelated job ${index}` })));
  const result = output(await f.landingCollect(entry, "publish", plan));
  assert.equal(result.assessment, "complete");
  f.published(entry);
  const summary = output(await f.push("summarize", batch));
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.landings.map(item => [item.pr_number, item.persisted, item.assessment]),
    [[67, true, "complete"]]);
  const attempt = receipt(f.state).attempts[0];
  assert.equal(attempt.validation.run_on_commit, f.landing);
  assert.equal(attempt.validation.evaluated_tree, f.tree);
  assert.equal(attempt.validation.orchestration_commit, f.landing);
  assert.ok(f.requests.some(path => path.includes("/jobs?per_page=100&page=2")));
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.pr.state, "closed");
});

test("multi-landing push paginates and deduplicates associations without certifying constituent or unrelated commits", async t => {
  const f = await fixture(t);
  await writeFile(join(f.checkout, "direct.txt"), "Unassociated target change\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Unassociated target change");
  const direct = f.git("rev-parse", "HEAD");
  const second = await f.land(68, true);
  f.state.associations[f.landing] = Array(101).fill(67);
  f.asPush(second);
  const batch = output(await f.push("admit", null, { after: second }));
  assert.deepEqual(batch.landings, [
    { pr_number: 67, landing_commit: f.landing }, { pr_number: 68, landing_commit: second }
  ]);
  assert.deepEqual(batch.exceptions, [{ commit: direct, code: "push_commit_unassociated" }]);
  assert.ok(f.requests.some(path => path.includes(`/commits/${f.landing}/pulls?per_page=100&page=2`)));
  assert.ok(!f.requests.some(path => path.includes(`/commits/${f.head}/pulls`)));
  const plans = await Promise.all(batch.landings.map(entry => f.landingCollect(entry)));
  f.pushFull(batch.landings[0], output(plans[0]), "failure");
  f.pushFull(batch.landings[1], output(plans[1]));
  // Main may advance after admission; that must not change either immutable evaluation.
  await writeFile(join(f.checkout, "later.txt"), "Later live main\n");
  f.git("add", ".");
  f.git("commit", "--quiet", "-m", "Later live main");
  const liveTip = f.git("rev-parse", "HEAD");
  f.git("push", "--quiet", "origin", "main");
  const results = await Promise.all(batch.landings.map((entry, index) =>
    f.landingCollect(entry, "publish", output(plans[index]))));
  assert.deepEqual(results.map(result => output(result).assessment), ["failed", "complete"]);
  for (const entry of batch.landings) f.published(entry);
  const summary = batchOutput(await f.push("summarize", batch), 1);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.landings.map(item => [item.pr_number, item.persisted, item.assessment]),
    [[67, true, "failed"], [68, true, "complete"]]);
  assert.deepEqual(summary.exceptions, [{ commit: direct, code: "push_commit_unassociated" }]);
  const first = receipt(f.state).attempts[0];
  const other = receipt(f.state.additional[68]).attempts[0];
  assert.equal(first.provenance.merge_kind, "merge");
  assert.equal(other.provenance.merge_kind, "squash");
  assert.equal(other.validation.run_on_commit, second);
  assert.equal(first.publication.remote_commit, liveTip);
  assert.equal(other.publication.remote_commit, liveTip);
  assert.deepEqual(f.state.writes.map(write => write.path).sort(), ["/issues/67/comments", "/issues/68/comments"]);
});

test("a failed landing comment write does not hide another landing's independently persisted receipt", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.asPush(second);
  const batch = output(await f.push("admit", null, { after: second }));
  f.state.writeFailures.add("/issues/67/comments");
  for (const entry of batch.landings) {
    const plan = output(await f.landingCollect(entry));
    f.pushFull(entry, plan);
    const result = await f.landingCollect(entry, "publish", plan);
    if (entry.pr_number === 67) {
      assert.deepEqual(output(result, 1).errors, ["receipt_write_failed"]);
      f.published(entry, "failure");
    } else {
      assert.equal(output(result).assessment, "complete");
      f.published(entry);
    }
  }
  const summary = batchOutput(await f.push("summarize", batch), 1);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.landings.map(item => [item.persisted, item.assessment]),
    [[false, "pending"], [true, "complete"]]);
  assert.deepEqual(summary.landings[0].blockers, ["push_receipt_unavailable"]);
  assert.equal(f.state.comments.length, 0);
  assert.equal(f.state.additional[68].comments.length, 1);
});

test("push admission refuses stale or unmerged association evidence while preserving other landings", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.asPush(second);
  f.state.pr.merged = false;
  const batch = output(await f.push("admit", null, { after: second }));
  assert.deepEqual(batch.landings, [{ pr_number: 68, landing_commit: second }]);
  assert.deepEqual(batch.exceptions, [{ commit: f.landing, code: "push_association_changed" }]);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry);
  const summary = batchOutput(await f.push("summarize", batch), 1);
  assert.equal(summary.landings[0].persisted, true);
  assert.equal(f.state.comments.length, 0);
});

test("the automatic workflow independently calls the existing isolated exact-landing process without superseding work", async () => {
  const automatic = await readFile(join(root, ".github/workflows/delivery-receipt-push.yml"), "utf8");
  const landing = await readFile(join(root, ".github/workflows/delivery-receipt.yml"), "utf8");
  assert.match(automatic, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(automatic, /fail-fast: false/);
  assert.match(automatic, /uses: \.\/\.github\/workflows\/delivery-receipt\.yml/);
  assert.match(automatic, /name: Receipt PR \$\{\{ matrix\.pr_number \}\} \/ \$\{\{ matrix\.landing_commit \}\}/);
  assert.match(automatic, /--event "\$env:GITHUB_EVENT_PATH"/);
  assert.match(automatic, /if: always\(\) && needs\.admit\.result == 'success'/);
  assert.doesNotMatch(automatic + landing, /concurrency:|cancel-in-progress:/);
  assert.match(landing, /workflow_call:/);
  assert.match(landing, /EXPECTED_COMMIT: \$\{\{ needs\.prepare\.outputs\.landing \}\}/);
  assert.match(landing, /--landing-commit/);
  assert.match(landing, /validation:[\s\S]*?permissions:\s*\n\s+contents: read\s*\n\s+defaults:/);
  assert.match(landing, /ref: \$\{\{ needs\.prepare\.outputs\.landing \}\}/);
});

test("batch summaries reject untrusted fields instead of echoing arbitrary input or claiming completion", async t => {
  const f = await fixture(t);
  f.asPush();
  const batch = output(await f.push());
  batch.private_diagnostic = "SECRET /private/machine https://private.invalid";
  const result = await f.push("summarize", batch);
  assert.deepEqual(output(result, 1).errors, ["push_batch_invalid"]);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|private\.invalid|\/private\/machine/);
  assert.deepEqual(f.state.writes, []);
});

test("event admission reports missing or unsafe ranges rather than substituting the current main tip", async t => {
  for (const [name, overrides, code] of [
    ["missing before object", { before: "a".repeat(40) }, "commit_object_unavailable"],
    ["initial branch creation", { before: "0".repeat(40) }, "push_range_unavailable"],
    ["wrong event revision", { after: "a".repeat(40) }, "push_event_invalid"],
    ["other branch", { ref: "refs/heads/feature" }, "push_event_invalid"],
    ["other repository", { repository: { full_name: "other/repository" } }, "push_event_invalid"],
    ["rewritten target", { forced: true }, "push_event_invalid"],
    ["deleted target", { deleted: true }, "push_event_invalid"],
    ["missing history", {}, "push_history_unavailable"],
    ["non-first-parent range", null, "push_range_not_first_parent"]
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      f.asPush();
      if (name === "missing history") await writeFile(join(f.checkout, ".git", "shallow"), `${f.base}\n`);
      const batch = output(await f.push("admit", null, overrides ?? { before: f.head }));
      assert.deepEqual(batch.landings, []);
      assert.deepEqual(batch.exceptions, [{ commit: null, code }]);
      const summary = batchOutput(await f.push("summarize", batch), 1);
      assert.equal(summary.complete, false);
      assert.deepEqual(f.state.writes, []);
    });
  }
});

test("an unavailable association page leaves an explicit exception while the other landing completes", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.asPush(second);
  f.state.unavailable = `/commits/${f.landing}/pulls`;
  const batch = output(await f.push("admit", null, { after: second }));
  assert.deepEqual(batch.landings, [{ pr_number: 68, landing_commit: second }]);
  assert.deepEqual(batch.exceptions, [{ commit: f.landing, code: "github_evidence_unavailable" }]);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry);
  assert.equal(batchOutput(await f.push("summarize", batch), 1).landings[0].persisted, true);
  assert.doesNotMatch(JSON.stringify(f.state.additional[68].comments), /SECRET|private\.invalid|\/private\/machine/);
});

test("malformed association records cannot abort discovery of the remaining push landings", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.asPush(second);
  f.state.associationResponses[f.landing] = [null];
  const batch = output(await f.push("admit", null, { after: second }));
  assert.deepEqual(batch.landings, [{ pr_number: 68, landing_commit: second }]);
  assert.deepEqual(batch.exceptions, [{ commit: f.landing, code: "github_evidence_invalid" }]);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry);
  assert.equal(batchOutput(await f.push("summarize", batch), 1).landings[0].persisted, true);
});

test("ambiguous landing associations stay exceptions rather than choosing an arbitrary PR", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.state.additional[69] = structuredClone(f.state.additional[68]);
  Object.assign(f.state.additional[69].pr, { number: 69, merge_commit_sha: f.landing });
  f.state.associations[f.landing] = [67, 69];
  f.asPush(second);
  const batch = output(await f.push("admit", null, { after: second }));
  assert.deepEqual(batch.exceptions, [{ commit: f.landing, code: "push_landing_ambiguous" }]);
  assert.deepEqual(batch.landings, [{ pr_number: 68, landing_commit: second }]);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry);
  assert.equal(batchOutput(await f.push("summarize", batch), 1).landings[0].persisted, true);
  assert.equal(f.state.comments.length, 0);
  assert.equal(f.state.additional[69].comments.length, 0);
});

test("matrix capacity reports every landing and a visible exception instead of silently truncating the batch", async t => {
  const f = await fixture(t);
  let after = f.landing;
  for (let number = 1000; number < 1257; number++) {
    after = f.git("commit-tree", f.tree, "-p", after, "-m", `Synthetic target result ${number}`);
    f.state.additional[number] = {
      pr: { ...structuredClone(f.state.pr), number, merge_commit_sha: after },
      comments: []
    };
    f.state.associations[after] = [number];
  }
  f.git("update-ref", "refs/heads/main", after);
  f.git("push", "--quiet", "origin", "main");
  f.asPush(after);
  const batch = output(await f.push("admit", null, { before: f.landing, after }));
  assert.equal(batch.schedulable, false);
  assert.equal(batch.landings.length, 257);
  assert.equal(batch.landings[0].pr_number, 1000);
  assert.deepEqual(batch.landings.at(-1), { pr_number: 1256, landing_commit: after });
  assert.deepEqual(batch.exceptions, [{ commit: null, code: "push_matrix_capacity_exceeded" }]);
  assert.deepEqual(f.state.writes, []);
});

test("a persisted complete receipt does not conceal failure of that landing's publication job", async t => {
  const f = await fixture(t);
  f.asPush();
  const batch = output(await f.push());
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry, "failure");
  const summary = batchOutput(await f.push("summarize", batch), 1);
  assert.deepEqual(summary.landings.map(item => [item.persisted, item.assessment, item.blockers]),
    [[true, "pending", ["push_publication_job_unsuccessful"]]]);
  assert.equal(receipt(f.state).attempts[0].assessment, "complete");
});

test("an admitted landing pin cannot silently move to another result when preparation rereads the PR", async t => {
  const f = await fixture(t);
  f.asPush();
  const batch = output(await f.push());
  const changed = { ...batch.landings[0], landing_commit: f.base };
  const plan = output(await f.landingCollect(changed));
  assert.deepEqual(plan.blockers, ["admitted_landing_identity_changed"]);
  assert.equal(plan.provenance.acceptance, null);
  assert.deepEqual(f.state.writes, []);
});

test("automatic provenance blockers produce pending receipts without running Full on an unaccepted mapping", async t => {
  for (const reason of ["nonhuman", "unexpected mapping"]) {
    await t.test(reason, async t => {
      const f = await fixture(t);
      f.asPush();
      if (reason === "nonhuman") f.state.pr.merged_by = bot;
      else f.state.pr.head.sha = f.base;
      const batch = output(await f.push());
      const entry = batch.landings[0];
      const plan = output(await f.landingCollect(entry));
      assert.deepEqual(plan.blockers, [
        reason === "nonhuman" ? "authorized_human_merge_required" : "unsupported_landing_mapping"
      ]);
      f.state.jobs.push({
        id: 267, name: `Receipt PR 67 / ${f.landing} / Exact landing Full`, run_id: 100, run_attempt: 1,
        head_sha: f.landing, status: "completed", conclusion: "skipped", steps: []
      });
      assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "pending");
      f.published(entry);
      const summary = batchOutput(await f.push("summarize", batch), 1);
      assert.equal(summary.landings[0].persisted, true);
      assert.equal(receipt(f.state).attempts[0].validation.outcome, "skipped");
      assert.equal(receipt(f.state).attempts[0].validation.run_on_commit, null);
    });
  }
});

test("another landing's successful Full job cannot certify a missing exact-landing evaluation", async t => {
  const f = await fixture(t);
  const second = await f.land(68, true);
  f.asPush(second);
  const batch = output(await f.push("admit", null, { after: second }));
  const plans = await Promise.all(batch.landings.map(entry => f.landingCollect(entry)));
  f.pushFull(batch.landings[0], output(plans[0]));
  for (const [index, entry] of batch.landings.entries()) {
    const result = output(await f.landingCollect(entry, "publish", output(plans[index])));
    assert.equal(result.assessment, index === 0 ? "complete" : "pending");
    f.published(entry);
  }
  const summary = batchOutput(await f.push("summarize", batch), 1);
  assert.deepEqual(summary.landings.map(item => item.assessment), ["complete", "pending"]);
  assert.deepEqual(summary.landings[1].blockers, ["validation_job_unavailable"]);
  assert.equal(receipt(f.state.additional[68]).attempts[0].validation.run_on_commit, null);
});

test("push collection preserves foreign Git state and foreign comments across admission and publication", async t => {
  const f = await fixture(t);
  f.asPush();
  const foreign = join(f.directory, "foreign.git");
  f.git("init", "--quiet", "--bare", "--template=", foreign);
  await writeFile(join(foreign, "owner-state.txt"), "preserve foreign state\n");
  const before = await snapshot(foreign);
  const batch = output(await f.push("admit", null, {}, {
    GIT_DIR: foreign, GIT_WORK_TREE: f.directory, GIT_COMMON_DIR: foreign,
    GIT_INDEX_FILE: join(foreign, "foreign-index")
  }));
  const foreignComments = Array.from({ length: 100 }, (_, index) =>
    ({ id: index + 1, user: human, body: `Owner bytes ${index}; keep unchanged.` }));
  f.state.comments = structuredClone(foreignComments);
  const entry = batch.landings[0];
  const plan = output(await f.landingCollect(entry));
  f.pushFull(entry, plan);
  assert.equal(output(await f.landingCollect(entry, "publish", plan)).assessment, "complete");
  f.published(entry);
  assert.equal(batchOutput(await f.push("summarize", batch)).complete, true);
  assert.deepEqual(f.state.comments.slice(0, 100), foreignComments);
  assert.deepEqual(await snapshot(foreign), before);
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

test("unsupported or malformed explicit declarations remain pending without inferring ticket scope from incidental mentions", async t => {
  for (const declaration of [
    "<!-- delivery\n{not json", "## Delivery\nTickets: #8", "```delivery\n{}",
    "``` delivery\n{not json", "   ## Delivery\nTickets: #8", "~~~delivery\n{}"
  ]) {
    await t.test(declaration.split("\n")[0], async t => {
      const f = await fixture(t);
      f.state.pr.body = declaration;
      const plan = output(await f.collect());
      f.full(plan);
      const result = output(await f.collect("publish", plan));
      assert.equal(result.assessment, "pending");
      assert.deepEqual(result.blockers, ["explicit_delivery_declaration_unsupported"]);
      const attempt = receipt(f.state).attempts[0];
      assert.equal(attempt.scope, "ticket-scoped");
      assert.equal(attempt.repository_change.assessment, "complete");
      assert.equal(f.state.writes.length, 1);
      assert.equal(f.state.writes[0].path, "/issues/67/comments");
      assert.equal(f.state.pr.body, declaration);
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
