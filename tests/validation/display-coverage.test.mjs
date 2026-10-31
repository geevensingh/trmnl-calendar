import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function runHarness(profile, directory = "", filter) {
  const result = spawnSync("dotnet", [
    "test", join(root, "tests", "CalendarAgenda.Tests", "CalendarAgenda.Tests.csproj"),
    "--no-build", "--no-restore", "--nologo", "--verbosity", "quiet",
    ...(filter ? ["--filter", filter, "--logger", "console;verbosity=normal"] : ["--list-tests"])
  ], {
    cwd: root, encoding: "utf8", timeout: filter ? 90_000 : 30_000,
    env: { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
      TRMNL_DISPLAY_COVERAGE: profile, TRMNL_TIMING_DIRECTORY: directory }
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

test("OG-first discovery retains every OG adaptive case and selects six representative families on each other view", () => {
  const adaptive = runHarness("OgFirst").stdout.split(/\r?\n/).filter(line => line.includes("AdaptiveDisplayTests."));
  assert.equal(adaptive.length, 73, "Unexpected adaptive discovery count");
  assert.equal(adaptive.filter(line => line.includes('nativeView: "og/full"')).length, 17);
  for (const [device, placement] of [
    ["og", "half_horizontal"], ["og", "half_vertical"],
    ["v2", "full"], ["v2", "half_horizontal"], ["v2", "half_vertical"]
  ]) {
    assert.equal(adaptive.filter(line => line.includes(`nativeView: "${device}/${placement}"`)).length,
      6, `${device}/${placement}`);
  }
});

test("exhaustive discovery restores all 128 adaptive rows without removing the six-view HTTP coverage", () => {
  const exhaustive = runHarness("Exhaustive").stdout;
  assert.equal(exhaustive.split(/\r?\n/).filter(line => line.includes("AdaptiveDisplayTests.")).length, 128);
  const methods = [
    "Http_emphasis_clock_transitions_reach_all_six_native_views_with_original_source_metadata",
    "Http_response_pressure_retains_both_card_states_over_ordinary_and_all_day_competition_in_native_views",
    "Http_tied_and_overlapping_emphasized_overflow_reaches_native_fitting_before_ordinary_rows",
    "Production_views_display_HTTP_fresh_stale_empty_and_failed_source_states",
    "Scheduled_source_freshness_remains_visible_in_every_production_native_view"
  ];
  const selected = runHarness("OgFirst").stdout;
  for (const method of methods) {
    assert.ok(selected.includes(method), `OG-first must retain ${method}`);
    assert.ok(exhaustive.includes(method), `Exhaustive must retain ${method}`);
  }
});

test("a focused real-render run reports the full selected inventory but completes only its actual assertion case", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda display coverage "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  runHarness("OgFirst", directory, "FullyQualifiedName~Empty_days_keep_date_and_message_on_one_line_without_a_zero_count");
  const files = await readdir(directory);
  const inventories = files.filter(name => /^inventory-.*\.json$/.test(name));
  assert.equal(inventories.length, 1, "Rendering must expose its expected coverage inventory");
  const inventory = JSON.parse(await readFile(join(directory, inventories[0]), "utf8"));
  assert.equal(inventory.coverage.profile, "OgFirst");
  assert.equal(inventory.coverage.policy_id, "og-first-v1");
  assert.match(inventory.coverage.policy_sha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.coverage.expected.length, 136);
  assert.equal(inventory.coverage.omitted.length, 140);
  assert.equal(new Set(inventory.coverage.expected.map(item => JSON.stringify(item))).size, 136);
  const scenarios = inventory.coverage.expected.filter(item => item.scenario !== null);
  assert.equal(scenarios.length, 67);
  assert.equal(scenarios.filter(item => item.view === "og/full").length, 22);
  assert.deepEqual(scenarios.filter(item => item.view === "og/half_horizontal").map(item => item.scenario).sort(), [
    "dense-primary", "dense-secondary", "emphasis-in-progress", "emphasis-upcoming", "empty-both",
    "empty-primary", "error-unknown", "long-text", "normal-mixed"
  ]);
  const completions = files.filter(name => /^coverage-.*\.jsonl$/.test(name));
  assert.equal(completions.length, 1);
  const completed = (await readFile(join(directory, completions[0]), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(completed.length, 1, "A focused run cannot claim the full selected workload completed");
  assert.equal(completed[0].view, "og/full");
  assert.equal(completed[0].variant, "default");
  assert.match(completed[0].method, /Empty_days_keep_date_and_message_on_one_line_without_a_zero_count$/);
});

test("the real harness rejects unknown profiles and unclassified scenarios or test families before rendering", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda invalid display policy "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join("tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0");
  await cp(join(root, output), join(directory, output), { recursive: true });
  await cp(join(root, "display", "scenarios"), join(directory, "display", "scenarios"), { recursive: true });
  const policy = JSON.parse(await readFile(join(root, "tests", "display-coverage.json"), "utf8"));
  for (const fault of ["unknown-profile", "unclassified-scenario", "unclassified-family"]) {
    await t.test(fault, async () => {
      const candidate = structuredClone(policy);
      if (fault === "unclassified-family") candidate.adaptive_families.New_unclassified_family = "all";
      if (fault === "unclassified-scenario")
        await writeFile(join(directory, "display", "scenarios", "new-unclassified.json"), "{}");
      await writeFile(join(directory, "tests", "display-coverage.json"), JSON.stringify(candidate));
      const report = join(directory, fault);
      await mkdir(report);
      const result = spawnSync("dotnet", [
        "test", join(directory, output, "CalendarAgenda.Tests.dll"),
        "--nologo", "--verbosity", "quiet", "--logger", "console;verbosity=normal",
        "--filter", "FullyQualifiedName~Empty_days_keep_date_and_message_on_one_line_without_a_zero_count"
      ], {
        cwd: directory, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
          TRMNL_DISPLAY_COVERAGE: fault === "unknown-profile" ? "NotApproved" : "OgFirst",
          TRMNL_TIMING_DIRECTORY: report }
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, fault === "unknown-profile"
        ? /Unknown display coverage profile/ : /does not classify the complete/);
      assert.ok(!(await readdir(report)).some(name => name.startsWith("coverage-")),
        "Invalid policy input cannot produce successful assertion completions");
      if (fault === "unclassified-scenario")
        await rm(join(directory, "display", "scenarios", "new-unclassified.json"));
    });
  }
});

test("an actual additional legacy-signature view theory cannot escape policy classification", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda unclassified theory "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0");
  await cp(join(root, "tests", "CalendarAgenda.Tests", "bin", "Debug", "net10.0"), output, { recursive: true });
  await cp(join(root, "display", "scenarios"), join(directory, "display", "scenarios"), { recursive: true });
  await cp(join(root, "tests", "display-coverage.json"), join(directory, "tests", "display-coverage.json"));
  const inputs = spawnSync("dotnet", [
    "msbuild", join(root, "tests", "CalendarAgenda.Tests", "CalendarAgenda.Tests.csproj"),
    "-nologo", "-verbosity:quiet", "-target:ResolveReferences", "-property:BuildProjectReferences=false",
    "-getItem:Compile,ReferencePath", "-getProperty:MSBuildToolsPath"
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(inputs.status, 0, inputs.stdout + inputs.stderr);
  const { Items, Properties } = JSON.parse(inputs.stdout);
  const adaptive = join(root, "tests", "CalendarAgenda.Tests", "AdaptiveDisplayTests.cs");
  const injected = join(directory, "AdaptiveDisplayTests.cs");
  const source = await readFile(adaptive, "utf8");
  const candidate = source.replace(/public sealed class AdaptiveDisplayTests\s*\{/, `$&
    [Theory]
    [MemberData(nameof(Views))]
    public void New_unclassified_view_theory(NativeView view)
        => DisplayTests.Render(view.Placement, new object(), view.Device);
`);
  assert.notEqual(candidate, source);
  await writeFile(injected, candidate);
  const assembly = join(output, "CalendarAgenda.Tests.dll");
  const args = [
    "/nologo", "/target:library", "/nullable:enable", "/langversion:latest", `/out:${assembly}`,
    ...Items.ReferencePath.map(item => `/reference:${item.FullPath}`),
    ...Items.Compile.map(item => item.FullPath === adaptive ? injected : item.FullPath),
    join(root, "tests", "CalendarAgenda.Tests", "obj", "Debug", "net10.0", "CalendarAgenda.Tests.GlobalUsings.g.cs")
  ];
  const response = join(directory, "compiler.rsp");
  await writeFile(response, args.map(argument => `"${argument}"`).join("\n"));
  const compiled = spawnSync("dotnet", [
    join(Properties.MSBuildToolsPath, "Roslyn", "bincore", "csc.dll"), `@${response}`
  ], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const result = spawnSync("dotnet", [
    "test", assembly, "--nologo", "--verbosity", "quiet", "--logger", "console;verbosity=normal",
    "--filter", "FullyQualifiedName~New_unclassified_view_theory"
  ], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
      TRMNL_DISPLAY_COVERAGE: "OgFirst", TRMNL_TIMING_DIRECTORY: join(directory, "report") }
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /does not classify the complete adaptive test families/);
});
