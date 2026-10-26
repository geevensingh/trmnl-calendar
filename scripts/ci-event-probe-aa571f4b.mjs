// Disposable external acceptance fixture. Never integrate into product branches.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const report = { fixture_assertions_passed: false, checks: {} };
const git = (...args) => execFileSync("git", ["--no-pager", ...args], {
  encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"]
}).trim();
function check(name, condition) {
  report.checks[name] = condition;
  assert.equal(condition, true);
}

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const head = event.pull_request.head.sha;
  const base = event.pull_request.base.sha;
  const baseRef = event.pull_request.base.ref;
  const synthetic = baseRef === "ci-event-probe-base-aa571f4b-c4e6-4b4b-a1c7-03f1a5795251";
  const expectedBase = synthetic
    ? "a58dedef4dd221650751bc3a1f7b0022f92d4fe1"
    : "80062fd2a27de65ea1424599f71d6b8be2770b30";
  const sentinel = "CI-EVENT-PROBE-aa571f4b-c4e6-4b4b-a1c7-03f1a5795251.txt";
  const literal = "DISPOSABLE CI EVENT PROBE ONLY. Session aa571f4b-c4e6-4b4b-a1c7-03f1a5795251. Synthetic base sentinel; never integrate.";
  report.event_action = event.action;
  report.event_base_ref = baseRef;
  report.event_base = base;
  report.event_head = head;
  report.checkout_head = git("rev-parse", "HEAD");
  report.parents = git("show", "-s", "--format=%P", "HEAD").split(" ");
  report.tree = git("rev-parse", "HEAD^{tree}");
  check("owned_pr", event.number === 51);
  check("expected_base_ref", synthetic || baseRef === "main");
  check("literal_base_pin", base === expectedBase);
  check("full_event_head_pin", /^[a-f0-9]{40}$/.test(head));
  check("exact_parents", report.parents.join(" ") === `${base} ${head}`);
  check("detached", git("rev-parse", "--symbolic-full-name", "HEAD") === "HEAD");
  check("complete_history", git("rev-parse", "--is-shallow-repository") === "false");
  git("merge-base", "--is-ancestor", "5f6bc0950c974002f4a409e6a5e01adf9c84a910", head);
  check("reviewed_candidate_ancestor", true);
  check("head_excludes_sentinel", git("ls-tree", head, "--", sentinel) === "");
  const delta = git("diff", "--name-status", head, "HEAD", "--");
  check("exact_tree_delta", delta === (synthetic ? `A\t${sentinel}` : ""));
  const treeEntry = git("ls-tree", "HEAD", "--", sentinel);
  check("sentinel_tree_identity", treeEntry === (synthetic
    ? `100644 blob c443ebc5c2443d2b6d146d98bfec1acde00e97c9\t${sentinel}` : ""));
  check("sentinel_disk_presence", existsSync(sentinel) === synthetic);
  if (synthetic) {
    const blob = execFileSync("git", ["show", `HEAD:${sentinel}`]);
    check("sentinel_literal_blob_bytes", blob.equals(Buffer.from(`${literal}\n`)));
    const autocrlf = git("config", "--get", "core.autocrlf");
    const expectedDisk = Buffer.from(`${literal}${autocrlf === "true" ? "\r\n" : "\n"}`);
    check("sentinel_literal_disk_bytes", readFileSync(sentinel).equals(expectedDisk));
    report.sentinel_disk_eol = autocrlf === "true" ? "CRLF" : "LF";
  } else {
    check("exact_head_tree", report.tree === git("rev-parse", `${head}^{tree}`));
  }
  git("diff", "--cached", "--quiet", "HEAD", "--");
  check("index_matches_head", true);
  check("clean_checkout", git("status", "--porcelain=v1", "--untracked-files=all") === "");
  check("visible_index", !git("ls-files", "-v").split(/\r?\n/).some(line => /^[a-zS] /.test(line)));
  report.fixture_assertions_passed = true;
  console.log(JSON.stringify(report));
} catch {
  report.error = "fixture_independent_assertion_failed";
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
