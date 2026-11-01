import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import { isolatedGitEnvironment } from "../../scripts/git-environment.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("timing disabled by an empty directory does not write Ruby journals", () => {
  const result = spawnSync(process.env.TRMNL_RUBY || "ruby", ["-I", join(root, "display"), "-e", `
    require "timing"
    def ValidationTiming.write(event)
      raise "Disabled instrumentation attempted a journal write"
    end
    ValidationTiming.loaded!
    raise "operation not preserved" unless ValidationTiming.measure("fixture") { "value" } == "value"
  `], { encoding: "utf8", timeout: 15_000, env: { ...process.env, TRMNL_TIMING_DIRECTORY: "" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("validation and cache digests use PowerShell 7.0 compatible APIs without changing hash identities", () => {
  const value = '{"name":"native","version":1}';
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    foreach ($source in @(@('scripts/validation-report.ps1','Get-ValidationDigest'),
        @('scripts/plan-dependency-cache.ps1','Get-CacheDigest'))) {
      $tokens=$null; $errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $env:TIMING_REPOSITORY $source[0]),[ref]$tokens,[ref]$errors)
      if($errors.Count) { throw 'Invalid digest source' }
      $node=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $source[1]},$true)
      if($node.Extent.Text -match '::(HashData|ToHexString)\\s*\\(') {
        throw 'Digest uses an API unavailable on the supported PowerShell 7.0 runtime'
      }
      . ([scriptblock]::Create($node.Extent.Text))
      & $source[1] ([ordered]@{name='native';version=1})
    }
  `], { encoding: "utf8", timeout: 15_000, env: { ...process.env, TIMING_REPOSITORY: root } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/),
    Array(2).fill(createHash("sha256").update(value).digest("hex")));
});

test("async timing retains disposable resource ownership until its end record succeeds", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda timing ownership "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "NuGet.Config"), "<configuration><packageSources><clear /></packageSources></configuration>");
  await cp(join(root, "tests", "CalendarAgenda.Tests", "ValidationTiming.cs"), join(directory, "ValidationTiming.cs"));
  await writeFile(join(directory, "probe.csproj"), `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><TreatWarningsAsErrors>true</TreatWarningsAsErrors></PropertyGroup>
  </Project>`);
  await writeFile(join(directory, "Program.cs"), `
    using System.Reflection;
    using CalendarAgenda.Tests;
    using Microsoft.Playwright;
    var journal = Path.Combine(Environment.GetEnvironmentVariable("TRMNL_TIMING_DIRECTORY")!,
      $"phases-dotnet-{Environment.ProcessId}.jsonl");
    var disposalFails = args[1] == "disposal-failure";
    object resource = args[0] == "sync" ? new SyncResource(disposalFails) : new AsyncResource(disposalFails);
    Func<Task<object>> factory = () => {
      if (args[1] == "oversized") {
        using var file = File.OpenWrite(journal);
        file.SetLength(20 * 1024 * 1024 + 1);
      } else if (args[1] != "success") {
        File.Delete(journal);
        Directory.CreateDirectory(journal);
      }
      return Task.FromResult(resource);
    };
    var method = typeof(ValidationTiming).GetMethod("RunAsync", BindingFlags.NonPublic | BindingFlags.Static)!;
    Exception? failure = null;
    try { await (Task<object>)method.MakeGenericMethod(typeof(object)).Invoke(null, ["fixture.create", factory, "owned"])!; }
    catch (Exception error) { failure = error; }
    var count = resource is SyncResource sync ? sync.Count : ((AsyncResource)resource).Count;
    if (args[1] == "disposal-failure") {
      if (failure is not AggregateException aggregate || aggregate.InnerExceptions.Count != 2 ||
          (aggregate.InnerExceptions[0] is not IOException && aggregate.InnerExceptions[0] is not UnauthorizedAccessException) ||
          aggregate.InnerExceptions[1].Message != "disposal failure")
        throw new Exception("Both timing and disposal failures must remain visible", failure);
    } else if (args[1] == "oversized") {
      if (failure is not InvalidOperationException || !failure.Message.Contains("diagnostic limit"))
        throw new Exception("Actual size-limit failure was not propagated", failure);
    } else if (args[1] != "success" && (failure is not IOException && failure is not UnauthorizedAccessException))
      throw new Exception("Actual journal failure was not propagated", failure);
    if (args[1] == "success" && failure is not null) throw failure;
    if (count != (args[1] != "success" ? 1 : 0)) throw new Exception($"Resource disposed {count} times");
    Console.WriteLine("ownership preserved");
    sealed class SyncResource(bool fail) : IDisposable {
      public int Count;
      public void Dispose() { Count++; if (fail) throw new InvalidOperationException("disposal failure"); }
    }
    sealed class AsyncResource(bool fail) : IAsyncDisposable {
      public int Count;
      public ValueTask DisposeAsync() {
        Count++;
        if (fail) throw new InvalidOperationException("disposal failure");
        return ValueTask.CompletedTask;
      }
    }
    namespace Microsoft.Playwright {
      public interface IPlaywright { IChromium Chromium { get; } }
      public interface IChromium { Task<IBrowser> LaunchAsync(); }
      public interface IBrowser { string Version { get; } }
      public interface IPage { Task<byte[]> ScreenshotAsync(PageScreenshotOptions? options); }
      public class PageScreenshotOptions {}
      public static class Playwright { public static Task<IPlaywright> CreateAsync() => throw new NotSupportedException(); }
    }
    namespace CalendarAgenda.Tests {
      static class AgendaScenarios { public static string[] Ids => ["fixture"]; }
      static class AdaptiveDisplayTests {
        public record NativeView(string Device, string Placement);
        public static object[][] Views => [[new NativeView("og", "full")]];
      }
      static class DisplayCoverage {
        public record Case(string Method);
        public static object Inventory => new {};
        public static bool IsExpected(Case identity) => true;
      }
    }
  `);
  const environment = { ...process.env, DOTNET_GENERATE_ASPNET_CERTIFICATE: "false" };
  const build = spawnSync("dotnet", ["build", join(directory, "probe.csproj"), "--nologo", "--verbosity", "quiet"],
    { encoding: "utf8", timeout: 60_000, env: environment });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  for (const resource of ["sync", "async"]) {
    for (const outcome of ["failure", "oversized", "disposal-failure", "success"]) {
      await t.test(`${resource}-${outcome}`, async () => {
        const report = join(directory, `${resource}-${outcome}`);
        const result = spawnSync("dotnet", [join(directory, "bin", "Debug", "net10.0", "probe.dll"), resource, outcome],
          { encoding: "utf8", timeout: 15_000, env: { ...environment, TRMNL_TIMING_DIRECTORY: report } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /ownership preserved/);
      });
    }
  }
});

test("the public Node reporter retains nested fixture costs without inventing elapsed totals or leaking errors", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda timing "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "fixture.test.mjs");
  await writeFile(source, `
    import test from "node:test";
    test("fixture matrix", async t => {
      await t.test("first selector", () => {});
      await t.test("second selector", () => { throw new Error("CONFIDENTIAL fixture input"); });
    });
  `);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test",
    `--test-reporter=${pathToFileURL(join(root, "scripts", "node-timing-reporter.mjs")).href}`, source],
  { encoding: "utf8", timeout: 15_000, env: environment });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const events = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
  const tests = events.filter(event => event.kind === "test");
  assert.equal(tests.length, 3);
  assert.equal(tests.filter(event => event.nesting === 0).length, 1);
  assert.equal(tests.filter(event => event.nesting === 1).length, 2);
  assert.ok(tests.every(event => event.duration_ms >= 0));
  assert.equal(events.at(-1).kind, "summary");
  assert.equal(events.at(-1).failed, 2);
  assert.ok(!result.stdout.includes("CONFIDENTIAL"));
  assert.ok(!result.stdout.includes("elapsed_total"));
});

async function workbenchFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "agenda workbench timing "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["scripts", "display"])
    await cp(join(root, name), join(directory, name), { recursive: true });
  await mkdir(join(directory, "docs"));
  await cp(join(root, "docs", "agenda-contract.md"), join(directory, "docs", "agenda-contract.md"));
  for (const asset of ["css/3.4.3/plugins.css", "js/3.4.3/plugins.js", "fonts/synthetic.woff2"]) {
    const path = join(directory, ".tools", "framework", ...asset.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset.endsWith(".css") ? '@font-face{src:url("/fonts/synthetic.woff2")}' : "synthetic");
  }
  await writeFile(join(directory, "empty.gitconfig"), "");
  const environment = isolatedGitEnvironment({
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "empty.gitconfig")
  });
  for (const args of [
    ["init", "--quiet", "--template="], ["add", "."],
    ["-c", "user.name=Synthetic", "-c", "user.email=synthetic@invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic baseline"]
  ]) {
    const result = spawnSync("git", args, { cwd: directory, env: environment, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const preload = join(directory, "external-ruby.mjs");
  await writeFile(preload, `
    import tools from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { promisify } from "node:util";
    import { EventEmitter } from "node:events";
    import { PassThrough } from "node:stream";
    import { mkdirSync, openSync, closeSync, ftruncateSync, rmSync } from "node:fs";
    import { join } from "node:path";
    const execute = promisify(tools.execFile);
    const spawn = tools.spawn;
    let timingFailed = false;
    process.on("message", message => { if (message === "shutdown") process.emit("SIGTERM"); });
    tools.execFile = Object.assign(() => {}, {
      [promisify.custom]: (command, ...args) => command === "synthetic-ruby"
        ? Promise.resolve({ stdout: "4.0.0", stderr: "" }) : execute(command, ...args)
    });
    tools.spawn = (command, args, options) => {
      if (command !== "synthetic-ruby") return spawn(command, args, options);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; };
      if (process.env.SYNTHETIC_TIMING_FAILURE) queueMicrotask(() => {
        const journal = join(process.env.TRMNL_TIMING_DIRECTORY, "phases-node-" + process.pid + ".jsonl");
        if (!timingFailed) {
          timingFailed = true;
          if (process.env.SYNTHETIC_TIMING_FAILURE === "unwritable") {
            rmSync(journal, { force: true });
            mkdirSync(journal);
          } else {
            const file = openSync(journal, "r+");
            ftruncateSync(file, 20 * 1024 * 1024 + 1);
            closeSync(file);
          }
        }
        child.stdout.write("synthetic rendered HTML");
        child.emit("close", 0);
      });
      else if (!process.env.SYNTHETIC_RUBY_TIMEOUT) queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("synthetic missing executable"), { code: "ENOENT" }));
        child.emit("close", 1);
      });
      return child;
    };
    syncBuiltinESMExports();
  `);
  return { directory, environment, preload };
}

test("the public workbench reports Ruby spawn errors and deadline termination as failures, not supersession", async t => {
  const { directory, environment, preload } = await workbenchFixture(t);
  for (const timeout of [false, true]) {
    const reports = join(directory, `reports-${timeout}`);
    await mkdir(reports);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href,
      join(directory, "scripts", "agenda-workbench.mjs"), "--workspace", directory, "--port", "0"],
    {
      cwd: directory,
      env: { ...environment, TRMNL_RUBY: "synthetic-ruby", TRMNL_TIMING_DIRECTORY: reports,
        SYNTHETIC_RUBY_TIMEOUT: timeout ? "1" : "" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    try {
      const lines = createInterface({ input: child.stdout });
      const signal = AbortSignal.timeout(35_000);
      const line = await Promise.race([
        once(lines, "line", { signal }).then(([value]) => value),
        once(child, "exit", { signal }).then(() => { throw new Error(diagnostics); })
      ]);
      const { url } = JSON.parse(line);
      const response = await fetch(new URL("/api/comparison?scenario=reference&target=og-full", url),
        { signal: AbortSignal.timeout(25_000) });
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, timeout ? /timed out/ : /Could not start Ruby/);
      const files = await readdir(reports);
      const events = (await Promise.all(files.map(file => readFile(join(reports, file), "utf8"))))
        .join("").trim().split(/\r?\n/).map(JSON.parse);
      const ends = events.filter(event => event.kind === "end");
      assert.ok(ends.length > 0);
      assert.ok(ends.every(event => event.result === "failed"), JSON.stringify(ends));
      assert.ok(ends.every(event => event.terminated === timeout));
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  }
});

test("workbench timing end failures reject requests without crashing or bypassing child cleanup", async t => {
  const { directory, environment, preload } = await workbenchFixture(t);
  for (const failure of ["unwritable", "limit"]) {
    const reports = join(directory, `reports-${failure}`);
    await mkdir(reports);
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href,
      join(directory, "scripts", "agenda-workbench.mjs"), "--workspace", directory, "--port", "0"], {
      cwd: directory,
      env: { ...environment, TRMNL_RUBY: "synthetic-ruby", TRMNL_TIMING_DIRECTORY: reports,
        SYNTHETIC_TIMING_FAILURE: failure },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    let diagnostics = "";
    child.stderr.on("data", chunk => { diagnostics += chunk; });
    const exited = once(child, "exit");
    try {
      const lines = createInterface({ input: child.stdout });
      const signal = AbortSignal.timeout(15_000);
      const line = await Promise.race([
        once(lines, "line", { signal }).then(([value]) => value),
        exited.then(() => { throw new Error(diagnostics); })
      ]);
      const { url } = JSON.parse(line);
      const response = await fetch(new URL("/api/comparison?scenario=reference&target=og-full", url),
        { signal: AbortSignal.timeout(10_000) }).catch(error => {
        throw new Error(`Workbench request disconnected: ${diagnostics}`, { cause: error });
      });
      assert.equal(response.status, 500);
      assert.match((await response.json()).error, /Could not record rendering timing/);
      assert.equal(child.exitCode, null, diagnostics);
      const journal = await readFile(join(reports, `phases-node-${child.pid}.jsonl`), "utf8")
        .catch(error => { assert.equal(error.code, "EISDIR"); return ""; });
      assert.ok(!journal.includes('"kind":"end"'), "Missing timing evidence must not be reported as complete.");
    } finally {
      if (child.exitCode === null && child.connected) {
        child.send("shutdown");
        child.disconnect();
      }
      await exited;
    }
    assert.deepEqual(await readdir(join(directory, "artifacts", "agenda-workbench")), [],
      "Workbench shutdown must remove its owned render directories.");
  }
});
