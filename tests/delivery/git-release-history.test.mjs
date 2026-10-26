import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  changedPathsBetween,
  isGitAncestor,
  mainCommitsAfter
} from "../../scripts/git-release-history.mjs";
import { classifyPaths } from "../../scripts/release-controller.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("main history preserves first-parent merge order and changed paths", async t => {
  const directory = await mkdtemp(join(tmpdir(), "release-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ["init", "--quiet", "-b", "main"]);
  await git(directory, ["config", "user.name", "Release Test"]);
  await git(directory, ["config", "user.email", "release@example.invalid"]);
  await writeFile(join(directory, "README.md"), "baseline\n");
  await git(directory, ["add", "README.md"]);
  await git(directory, ["commit", "--quiet", "-m", "baseline"]);
  const baseline = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  await mkdir(join(directory, "display", "src"), { recursive: true });
  await writeFile(join(directory, "display", "src", "settings.yml"), "template\n");
  await git(directory, ["add", "display/src/settings.yml"]);
  await git(directory, ["commit", "--quiet", "-m", "plugin change"]);
  const pluginCommit = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  await writeFile(join(directory, "src-placeholder"), "unknown\n");
  await git(directory, ["add", "src-placeholder"]);
  await git(directory, ["commit", "--quiet", "-m", "unknown change"]);
  const head = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();

  const records = await mainCommitsAfter(directory, baseline, head);
  assert.deepEqual(records.map(item => item.commit), [pluginCommit, head]);
  assert.deepEqual(records.map(item => item.parent), [baseline, pluginCommit]);
  assert.deepEqual(records[0].paths, ["display/src/settings.yml"]);
  assert.deepEqual(await changedPathsBetween(directory, baseline, head), [
    "display/src/settings.yml", "src-placeholder"
  ]);
  assert.equal(await isGitAncestor(directory, baseline, head), true);
  assert.deepEqual(await mainCommitsAfter(directory, head, head), []);
});

test("main history refuses unrelated or invalid commit checkpoints", async () => {
  await assert.rejects(mainCommitsAfter(".", "not-a-commit", "a".repeat(40)), {
    message: "invalid_commit"
  });
});

test("renames retain both path identities for production target classification", async t => {
  const directory = await mkdtemp(join(tmpdir(), "release-history-rename-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, ["init", "--quiet", "-b", "main"]);
  await git(directory, ["config", "user.name", "Release Test"]);
  await git(directory, ["config", "user.email", "release@example.invalid"]);
  await mkdir(join(directory, "src", "CalendarAgenda"), { recursive: true });
  await writeFile(join(directory, "src", "CalendarAgenda", "AgendaFunction.cs"), "production\n");
  await git(directory, ["add", "."]);
  await git(directory, ["commit", "--quiet", "-m", "baseline"]);
  const baseline = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  await mkdir(join(directory, "docs"), { recursive: true });
  await git(directory, ["mv", "src/CalendarAgenda/AgendaFunction.cs", "docs/AgendaFunction.cs"]);
  await git(directory, ["commit", "--quiet", "-m", "move production source"]);
  const head = (await git(directory, ["rev-parse", "HEAD"])).stdout.trim();
  const expected = ["docs/AgendaFunction.cs", "src/CalendarAgenda/AgendaFunction.cs"];
  const records = await mainCommitsAfter(directory, baseline, head);
  assert.deepEqual(records[0].paths, expected);
  assert.deepEqual(await changedPathsBetween(directory, baseline, head), expected);
  assert.deepEqual(classifyPaths(records[0].paths), ["azure"]);
});
