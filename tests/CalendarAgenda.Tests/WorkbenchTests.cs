using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using Xunit;
using Xunit.Abstractions;

namespace CalendarAgenda.Tests;

[CollectionDefinition("Workbench", DisableParallelization = true)]
public sealed class WorkbenchCollection;

[Collection("Workbench")]
public sealed class WorkbenchTests(ITestOutputHelper output)
{
    private static readonly string[] Targets = ["og-full", "v2-full", "v2-half_horizontal", "v2-half_vertical"];

    [Fact]
    public async Task Startup_HEAD_is_immutable_and_live_template_and_scenario_inputs_remain_like_for_like()
    {
        await using var fixture = await Workspace.Create();
        var template = fixture.Template;
        await fixture.WriteTemplate(template.Replace("data-agenda-state=", "data-workbench-probe=\"uncommitted\" data-agenda-state="));
        var running = await fixture.Start();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await Page(browser, running);
        await Ready(page);
        await Assertions.Expect(page.Locator("#baseline-commit")).ToHaveTextAsync(fixture.Baseline);
        Assert.Null(await (await Frame(page, "og-full", "baseline")).Locator(".agenda").GetAttributeAsync("data-workbench-probe"));
        Assert.Equal("uncommitted", await (await Frame(page, "og-full", "candidate")).Locator(".agenda").GetAttributeAsync("data-workbench-probe"));
        await SameInputs(page, "og-full");

        await fixture.Commit("Another synthetic UI revision");
        Assert.NotEqual(fixture.Baseline, await fixture.Git("rev-parse", "HEAD"));
        await page.ReloadAsync();
        await Ready(page);
        await Assertions.Expect(page.Locator("#baseline-commit")).ToHaveTextAsync(fixture.Baseline);
        Assert.Null(await (await Frame(page, "og-full", "baseline")).Locator(".agenda").GetAttributeAsync("data-workbench-probe"));

        await page.Locator("#target").SelectOptionAsync("v2-half_vertical");
        await Ready(page);
        var old = await ComparisonId(page, "v2-half_vertical");
        var scenario = fixture.Scenario("normal-mixed");
        scenario["agenda"]!["primary"]!["occurrences"]![0]!["title"] = "Changed synthetic scenario on both sides";
        await fixture.WriteScenario("normal-mixed", scenario);
        await NewComparison(page, "v2-half_vertical", old);
        await Assertions.Expect(page.Locator("#scenario")).ToHaveValueAsync("normal-mixed");
        await Assertions.Expect(page.Locator("#target")).ToHaveValueAsync("v2-half_vertical");
        foreach (var side in new[] { "baseline", "candidate" })
            await Assertions.Expect((await Frame(page, "v2-half_vertical", side))
                .GetByText("Changed synthetic scenario on both sides", new() { Exact = true })).ToBeVisibleAsync();
        await SameInputs(page, "v2-half_vertical");
        await Assertions.Expect(page.Locator("#baseline-commit")).ToHaveTextAsync(fixture.Baseline);

        var explicitBaseline = await fixture.Start(fixture.Baseline);
        var explicitPage = await Page(browser, explicitBaseline);
        await Ready(explicitPage);
        await Assertions.Expect(explicitPage.Locator("#baseline-commit")).ToHaveTextAsync(fixture.Baseline);
        Assert.Null(await (await Frame(explicitPage, "og-full", "baseline")).Locator(".agenda").GetAttributeAsync("data-workbench-probe"));
        Assert.Equal("uncommitted", await (await Frame(explicitPage, "og-full", "candidate")).Locator(".agenda").GetAttributeAsync("data-workbench-probe"));
    }

    [Fact]
    public async Task Focused_and_overview_targets_keep_native_geometry_isolation_and_shared_on_demand_checks()
    {
        await using var fixture = await Workspace.Create();
        await fixture.WriteTemplate(fixture.Template + """

            <script>
            window.candidateOnly = true;
            document.body.style.backgroundColor = "rgb(1, 2, 3)";
            try { parent.document.body.dataset.leaked = "true"; } catch { window.parentAccessBlocked = true; }
            </script>
            """);
        var running = await fixture.Start();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await Page(browser, running);
        foreach (var target in Targets)
        {
            await page.Locator("#target").SelectOptionAsync(target);
            await Ready(page);
            await Assertions.Expect(page.Locator(".comparison")).ToHaveCountAsync(1);
            await Assertions.Expect(page.Locator("iframe")).ToHaveCountAsync(2);
            await SameInputs(page, target);
            var before = await Geometry(await Frame(page, target, "candidate"));
            await page.Locator("#zoom").SelectOptionAsync("100");
            await page.SetViewportSizeAsync(1200, 900);
            Assert.Equal(before, await Geometry(await Frame(page, target, "candidate")));
            await page.Locator("#zoom").SelectOptionAsync("fit");
            Assert.Equal(before, await Geometry(await Frame(page, target, "candidate")));
            Assert.True(await (await Frame(page, target, "candidate")).EvaluateAsync<bool>("window.parentAccessBlocked === true"));
            Assert.Null(await (await Frame(page, target, "baseline")).EvaluateAsync<bool?>("window.candidateOnly"));
            Assert.Null(await page.Locator("body").GetAttributeAsync("data-leaked"));
            await Check(page);
        }
        foreach (var scenario in new[] { "empty-primary", "all-day-multiday", "long-text", "stale", "error-source" })
        {
            await page.Locator("#scenario").SelectOptionAsync(scenario);
            await Ready(page);
            await SameInputs(page, "v2-half_vertical");
            var selected = await (await Frame(page, "v2-half_vertical", "candidate"))
                .EvaluateAsync<string>("JSON.parse(document.querySelector('#workbench-render').textContent).scenarioId");
            Assert.Equal(scenario, selected);
            await Check(page);
        }
        await page.Locator("#overview").ClickAsync();
        await OverviewReady(page);
        await Assertions.Expect(page.Locator(".comparison")).ToHaveCountAsync(4);
        await Assertions.Expect(page.Locator("iframe")).ToHaveCountAsync(8);
        foreach (var target in Targets) await SameInputs(page, target);
        await Check(page);
        var old = await ComparisonId(page, "og-full");
        await fixture.WriteTemplate(fixture.Template);
        await page.WaitForFunctionAsync("""
            old => document.querySelector('.comparison[data-target="og-full"]')?.dataset.comparisonId
              && document.querySelector('.comparison[data-target="og-full"]').dataset.comparisonId !== old
            """, old);
        await OverviewReady(page);
        await NewComparison(page, "og-full", old);
        await Assertions.Expect(page.Locator("#checks")).ToHaveAttributeAsync("data-state", "unchecked");
        await page.Locator("#overview").ClickAsync();
        await Ready(page);
        await Assertions.Expect(page.Locator("#target")).ToHaveValueAsync("v2-half_vertical");
    }

    [Fact]
    public async Task Invalid_inputs_rendering_assets_readiness_and_disconnects_never_leave_an_old_success_current()
    {
        await using var fixture = await Workspace.Create();
        var running = await fixture.Start();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await Page(browser, running);
        await Ready(page);
        await Check(page);

        await fixture.WriteScenarioText("normal-mixed", "{");
        await Failed(page, "normal-mixed.json");
        await Assertions.Expect(page.Locator("#checks")).ToHaveAttributeAsync("data-state", "unchecked");
        var invalid = fixture.Scenario("reference");
        invalid["id"] = "normal-mixed";
        invalid["agenda"]!["primary"]!["eligible_total"] = -1;
        await fixture.WriteScenario("normal-mixed", invalid);
        await Failed(page, "agenda.primary.eligible_total");
        await fixture.RestoreScenario("normal-mixed");
        await Ready(page);

        var name = fixture.ScenarioPath("normal-mixed");
        File.Move(name, name + ".removed");
        await Failed(page, "missing");
        File.Move(name + ".removed", name);
        await Ready(page);

        await fixture.WriteTemplate(fixture.Template + "\n<!-- Superseded pending save -->");
        await Assertions.Expect(page.Locator("body")).ToHaveAttributeAsync("data-state", "loading");
        await fixture.WriteTemplate(fixture.Template + "\n{{ missing_workbench_variable }}");
        await Failed(page, "Strict Liquid");
        await fixture.WriteTemplate(fixture.Template);
        await Ready(page);

        await fixture.WriteTemplate(fixture.Template + "\n<script>throw new Error('Synthetic preview script failed');</script>");
        await Failed(page, "Synthetic preview script failed");
        await fixture.WriteTemplate(fixture.Template);
        await Ready(page);

        await fixture.WriteTemplate(fixture.Template + """

            <script>Object.defineProperty(window, "TRMNL_PLUGINS_READY", { configurable: true, get: () => false, set: () => {} });</script>
            """);
        await Failed(page, "readiness");
        await fixture.WriteTemplate(fixture.Template);
        await Ready(page);

        var missingAsset = await browser.NewPageAsync();
        await missingAsset.RouteAsync("**/js/3.4.3/plugins.js", route => route.AbortAsync());
        await missingAsset.GotoAsync(running.Url);
        await Failed(missingAsset, "Asset failed");
        await missingAsset.CloseAsync();

        var missingFont = await browser.NewPageAsync();
        await missingFont.RouteAsync("**/fonts/TRMNL21-*", route => route.AbortAsync());
        await missingFont.GotoAsync(running.Url);
        await Failed(missingFont, "font");
        await missingFont.CloseAsync();

        await running.Stop();
        await Failed(page, "disconnected");
        await Assertions.Expect(page.Locator("iframe")).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task Warm_template_and_scenario_saves_finish_the_actual_selected_pair_within_five_seconds()
    {
        await using var fixture = await Workspace.Create();
        var running = await fixture.Start();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await Page(browser, running);
        var measurements = new List<object>();
        try
        {
            await Ready(page);
            foreach (var target in Targets)
            {
                await page.Locator("#target").SelectOptionAsync(target);
                await Ready(page);
                var old = await ComparisonId(page, target);
                var clock = Stopwatch.StartNew();
                await fixture.WriteTemplate(fixture.Template.Replace("data-agenda-state=", $"data-warm-probe=\"{target}\" data-agenda-state="));
                await NewComparison(page, target, old);
                Assert.Equal(target, await (await Frame(page, target, "candidate")).Locator(".agenda").GetAttributeAsync("data-warm-probe"));
                Assert.Null(await (await Frame(page, target, "baseline")).Locator(".agenda").GetAttributeAsync("data-warm-probe"));
                clock.Stop();
                measurements.Add(new { target, kind = "template-save", milliseconds = clock.ElapsedMilliseconds });
                output.WriteLine($"{target} template-save: {clock.ElapsedMilliseconds} ms");
                Assert.True(clock.ElapsedMilliseconds <= 5000, $"{target} template-save took {clock.ElapsedMilliseconds} ms.");

                var scenario = fixture.Scenario("normal-mixed");
                var title = $"Warm scenario {target}";
                scenario["agenda"]!["primary"]!["occurrences"]![0]!["title"] = title;
                old = await ComparisonId(page, target);
                clock.Restart();
                await fixture.WriteScenario("normal-mixed", scenario);
                await NewComparison(page, target, old);
                foreach (var side in new[] { "baseline", "candidate" })
                {
                    var frame = await Frame(page, target, side);
                    Assert.Equal(title, await frame.EvaluateAsync<string>("JSON.parse(document.querySelector('#workbench-render').textContent).agenda.primary.occurrences[0].title"));
                    Assert.True(await frame.EvaluateAsync<bool>("window.TRMNL_PLUGINS_READY === true && document.querySelector('.agenda').dataset.agendaReady === 'true' && document.fonts.status === 'loaded'"));
                }
                clock.Stop();
                measurements.Add(new { target, kind = "scenario-save", milliseconds = clock.ElapsedMilliseconds });
                output.WriteLine($"{target} scenario-save: {clock.ElapsedMilliseconds} ms");
                Assert.True(clock.ElapsedMilliseconds <= 5000, $"{target} scenario-save took {clock.ElapsedMilliseconds} ms.");
                await Assertions.Expect(page.Locator("#scenario")).ToHaveValueAsync("normal-mixed");
                await Assertions.Expect(page.Locator("#target")).ToHaveValueAsync(target);
            }
        }
        finally
        {
            await File.WriteAllTextAsync(Path.Combine(DisplayTests.Root, "artifacts", "workbench-latency.json"),
                JsonSerializer.Serialize(measurements, new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    [Fact]
    public async Task Public_launcher_rejects_unavailable_or_incompatible_history_and_missing_prerequisites()
    {
        await using var fixture = await Workspace.Create();
        await fixture.StartFailure("unavailable-synthetic-revision", "baseline");
        var contractPath = Path.Combine(fixture.Root, "docs", "agenda-contract.md");
        var contract = await File.ReadAllTextAsync(contractPath);
        await File.WriteAllTextAsync(contractPath, contract.Replace(
            "# Agenda HTTP and display contract, version 1", "# Agenda HTTP and display contract, version 2"));
        await fixture.Commit("Synthetic incompatible schema");
        await fixture.StartFailure("HEAD", "Incompatible baseline");
        await File.WriteAllTextAsync(contractPath, contract);
        var rendererPath = Path.Combine(fixture.Root, "display", "render.rb");
        var renderer = await File.ReadAllTextAsync(rendererPath);
        await File.WriteAllTextAsync(rendererPath, renderer.Replace("3.4.3", "9.9.9"));
        await fixture.Commit("Synthetic incompatible framework");
        await fixture.StartFailure("HEAD", "Incompatible baseline");
        await fixture.StartFailure(fixture.Baseline, "Ruby 4", missingRuby: true);

        var scripts = Path.Combine(fixture.Root, "uninstalled", "scripts");
        Directory.CreateDirectory(scripts);
        foreach (var file in new[] { "agenda-workbench.mjs", "agenda-contract.mjs" })
            File.Copy(Path.Combine(DisplayTests.Root, "scripts", file), Path.Combine(scripts, file));
        await fixture.StartFailure(fixture.Baseline, "Missing framework asset",
            launcher: Path.Combine(scripts, "agenda-workbench.mjs"));
    }

    private async Task<IPage> Page(IBrowser browser, Running running)
    {
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 1600, Height = 1100 } });
        page.SetDefaultTimeout(30_000);
        page.PageError += (_, message) => output.WriteLine($"Browser script error: {message}");
        page.RequestFailed += (_, request) => output.WriteLine($"Browser request failed: {request.Url} {request.Failure}");
        page.Console += (_, message) =>
        {
            if (message.Type == "error") output.WriteLine($"Browser console: {message.Text}");
        };
        await page.GotoAsync(running.Url);
        return page;
    }

    private static async Task Ready(IPage page)
    {
        try
        {
            await Assertions.Expect(page.Locator("body")).ToHaveAttributeAsync("data-state", "ready", new() { Timeout = 30_000 });
        }
        catch (PlaywrightException error)
        {
            Assert.Fail($"{error.Message}\nSelected scenario: {await page.Locator("#scenario").InputValueAsync()}\nCurrent workbench status: {await page.Locator("#status").InnerTextAsync()}");
        }
    }

    private static async Task Failed(IPage page, string message)
    {
        await Assertions.Expect(page.Locator("body")).ToHaveAttributeAsync("data-state", "failed", new() { Timeout = 30_000 });
        await Assertions.Expect(page.Locator("#status")).ToContainTextAsync(message, new() { IgnoreCase = true, Timeout = 30_000 });
        await Assertions.Expect(page.Locator("#check")).ToBeDisabledAsync();
    }

    private static async Task OverviewReady(IPage page)
    {
        await Assertions.Expect(page.Locator("iframe")).ToHaveCountAsync(8, new() { Timeout = 30_000 });
        foreach (var target in Targets)
        {
            var pair = page.Locator($".comparison[data-target='{target}']");
            await pair.ScrollIntoViewIfNeededAsync();
            await Assertions.Expect(pair).ToHaveAttributeAsync("data-state", "ready", new() { Timeout = 30_000 });
        }
        await Ready(page);
    }

    private static Task<string?> ComparisonId(IPage page, string target) =>
        page.Locator($".comparison[data-target='{target}']").GetAttributeAsync("data-comparison-id");

    private static async Task NewComparison(IPage page, string target, string? old)
    {
        try
        {
            await page.WaitForFunctionAsync("""
                input => document.body.dataset.state === "ready"
                  && document.querySelector(`.comparison[data-target="${input.target}"]`)?.dataset.comparisonId
                  && document.querySelector(`.comparison[data-target="${input.target}"]`).dataset.comparisonId !== input.old
                """, new { target, old });
        }
        catch (PlaywrightException error)
        {
            Assert.Fail($"{error.Message}\nCurrent workbench status: {await page.Locator("#status").InnerTextAsync()}");
        }
    }

    private static async Task<IFrame> Frame(IPage page, string target, string side)
    {
        var id = await ComparisonId(page, target);
        return page.Frames.Single(frame => new Uri(frame.Url).AbsolutePath == $"/preview/{id}/{side}");
    }

    private static async Task SameInputs(IPage page, string target)
    {
        var baseline = await Frame(page, target, "baseline");
        var candidate = await Frame(page, target, "candidate");
        const string expression = "JSON.stringify(JSON.parse(document.querySelector('#workbench-render').textContent).agenda)";
        Assert.Equal(await baseline.EvaluateAsync<string>(expression), await candidate.EvaluateAsync<string>(expression));
        var native = target.StartsWith("og", StringComparison.Ordinal) ? (800, 480) : (1872, 1404);
        foreach (var frame in new[] { baseline, candidate })
        {
            Assert.Equal(native.Item1, await frame.EvaluateAsync<int>("document.querySelector('.screen').getBoundingClientRect().width"));
            Assert.Equal(native.Item2, await frame.EvaluateAsync<int>("document.querySelector('.screen').getBoundingClientRect().height"));
        }
    }

    private static Task<string> Geometry(IFrame frame) => frame.EvaluateAsync<string>("""
        JSON.stringify({
          screen: [document.querySelector(".screen").getBoundingClientRect().width, document.querySelector(".screen").getBoundingClientRect().height],
          view: [document.querySelector(".agenda-view").clientWidth, document.querySelector(".agenda-view").clientHeight],
          titles: [...document.querySelectorAll(".agenda tbody tr:not([hidden]) td .title")].map(node => node.textContent),
          overflow: [...document.querySelectorAll(".agenda-overflow:not([hidden])")].map(node => node.textContent)
        })
        """);

    private static async Task Check(IPage page)
    {
        await page.Locator("#check").ClickAsync();
        await page.WaitForFunctionAsync("['passed', 'failed'].includes(document.querySelector('#checks').dataset.state)");
        Assert.True(await page.Locator("#checks").GetAttributeAsync("data-state") == "passed",
            await page.Locator("#checks").InnerTextAsync());
    }

    private sealed class Running(Process process, Task<string> errors, string url)
    {
        internal string Url => url;

        internal async Task Stop()
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            await errors;
        }
    }

    private sealed class Workspace : IAsyncDisposable
    {
        private readonly List<(Process Process, Task<string> Errors)> processes = [];
        internal string Root { get; } = Path.Combine(DisplayTests.Root, "artifacts", "workbench-tests", Guid.NewGuid().ToString("N"));
        internal string Template { get; private set; } = "";
        internal string Baseline { get; private set; } = "";

        internal static async Task<Workspace> Create()
        {
            var workspace = new Workspace();
            foreach (var directory in new[] { Path.Combine("display", "src"), Path.Combine("display", "scenarios"), "docs" })
                Directory.CreateDirectory(Path.Combine(workspace.Root, directory));
            foreach (var directory in new[] { Path.Combine("display", "src"), Path.Combine("display", "scenarios") })
                foreach (var file in Directory.GetFiles(Path.Combine(DisplayTests.Root, directory)))
                    File.Copy(file, Path.Combine(workspace.Root, directory, Path.GetFileName(file)));
            foreach (var file in new[] { Path.Combine("display", "render.rb"), Path.Combine("docs", "agenda-contract.md") })
                File.Copy(Path.Combine(DisplayTests.Root, file), Path.Combine(workspace.Root, file));
            workspace.Template = await File.ReadAllTextAsync(Path.Combine(workspace.Root, "display", "src", "shared.liquid"));
            await workspace.Git("init", "--quiet");
            await workspace.Git("config", "user.name", "Synthetic workbench");
            await workspace.Git("config", "user.email", "workbench@synthetic.invalid");
            await workspace.Git("config", "commit.gpgsign", "false");
            await workspace.Git("config", "core.autocrlf", "false");
            var hooks = Path.Combine(workspace.Root, ".git", "empty-hooks");
            Directory.CreateDirectory(hooks);
            await workspace.Git("config", "core.hooksPath", hooks);
            await workspace.Commit("Synthetic baseline");
            workspace.Baseline = await workspace.Git("rev-parse", "HEAD");
            return workspace;
        }

        internal string ScenarioPath(string id) => Path.Combine(Root, "display", "scenarios", $"{id}.json");
        internal JsonObject Scenario(string id) => JsonNode.Parse(File.ReadAllText(ScenarioPath(id)))!.AsObject();
        internal Task WriteScenario(string id, JsonObject scenario) => WriteScenarioText(id, scenario.ToJsonString());
        internal Task WriteScenarioText(string id, string text) => AtomicWrite(ScenarioPath(id), text);
        internal Task WriteTemplate(string text) => AtomicWrite(Path.Combine(Root, "display", "src", "shared.liquid"), text);
        internal Task RestoreScenario(string id) => WriteScenarioText(id,
            File.ReadAllText(Path.Combine(AgendaScenarios.DirectoryPath, $"{id}.json")));

        private static async Task AtomicWrite(string path, string content)
        {
            var temporary = path + ".saving";
            await File.WriteAllTextAsync(temporary, content);
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    File.Move(temporary, path, overwrite: true);
                    return;
                }
                catch (UnauthorizedAccessException) when (OperatingSystem.IsWindows() && attempt < 20)
                {
                    await Task.Delay(25);
                }
                catch (IOException error) when (OperatingSystem.IsWindows() && (error.HResult & 0xffff) == 32 && attempt < 20)
                {
                    await Task.Delay(25);
                }
            }
        }

        internal async Task Commit(string message)
        {
            await Git("add", ".");
            await Git("commit", "--quiet", "-m", message);
        }

        internal async Task<string> Git(params string[] arguments)
        {
            var start = new ProcessStartInfo("git")
            {
                WorkingDirectory = Root,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.Environment["GIT_TERMINAL_PROMPT"] = "0";
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start)!;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.True(process.ExitCode == 0, await stderr);
            return (await stdout).Trim();
        }

        private (Process Process, Task<string> Errors) Launch(string? baseline, bool missingRuby = false, string? launcher = null)
        {
            var start = new ProcessStartInfo("node")
            {
                WorkingDirectory = DisplayTests.Root,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            foreach (var argument in new[] { launcher ?? Path.Combine(DisplayTests.Root, "scripts", "agenda-workbench.mjs"),
                "--workspace", Root, "--port", "0" })
                start.ArgumentList.Add(argument);
            if (baseline is not null)
            {
                start.ArgumentList.Add("--baseline");
                start.ArgumentList.Add(baseline);
            }
            if (missingRuby) start.Environment["TRMNL_RUBY"] = Path.Combine(Root, "missing-ruby.exe");
            var process = Process.Start(start)!;
            var running = (process, process.StandardError.ReadToEndAsync());
            processes.Add(running);
            return running;
        }

        internal async Task<Running> Start(string? baseline = null)
        {
            var (process, errors) = Launch(baseline);
            var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(45));
            if (line is null)
            {
                await process.WaitForExitAsync();
                Assert.Fail($"The public workbench launcher failed: {await errors}");
            }
            using var result = JsonDocument.Parse(line);
            return new Running(process, errors, result.RootElement.GetProperty("url").GetString()!);
        }

        internal async Task StartFailure(string baseline, string expected, bool missingRuby = false, string? launcher = null)
        {
            var (process, errors) = Launch(baseline, missingRuby, launcher);
            var stdout = process.StandardOutput.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(45));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Contains(expected, await errors, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("\"status\":\"listening\"", await stdout);
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var (process, errors) in processes)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
                await errors;
                process.Dispose();
            }
            if (Directory.Exists(Root))
            {
                foreach (var file in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
                    File.SetAttributes(file, File.GetAttributes(file) & ~FileAttributes.ReadOnly);
                Directory.Delete(Root, recursive: true);
            }
        }
    }
}
