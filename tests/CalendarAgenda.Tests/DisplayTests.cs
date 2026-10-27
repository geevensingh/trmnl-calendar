using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using CalendarAgenda;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class DisplayTests
{
    internal static readonly string Root = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public async Task Full_screen_OG_renders_the_agenda_using_production_Liquid_and_framework()
    {
        var data = CurrentAgenda();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await Show(page, data);

        await Assertions.Expect(page.GetByText("Friday, Oct 23", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Synthetic planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Likely", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("11:00 AM - 12:00 PM", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Monday, Oct 26", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("0 of 3 events shown", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Oct 23, 2026, 11:00 AM PDT", new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("tomorrow", await page.Locator("body").InnerTextAsync(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("legend", await page.Locator("body").InnerTextAsync(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(800, await page.Locator(".screen").EvaluateAsync<int>("element => element.offsetWidth"));
        Assert.Equal(480, await page.Locator(".screen").EvaluateAsync<int>("element => element.offsetHeight"));
    }

    [Theory]
    [InlineData("primary", "timed")]
    [InlineData("primary", "all_day")]
    [InlineData("secondary", "timed")]
    [InlineData("secondary", "all_day")]
    public void Direct_renderer_rejects_missing_or_invalid_participation_on_every_occurrence(string day, string timeKind)
    {
        foreach (var invalid in new[] { "missing", "null", "unsupported", "number" })
        {
            var data = CurrentAgenda();
            var occurrence = data["primary"]!["occurrences"]![0]!.DeepClone().AsObject();
            occurrence["id"] = "invalid-participation";
            if (timeKind == "all_day")
            {
                occurrence["time_kind"] = timeKind;
                occurrence.Remove("start_at");
                occurrence.Remove("end_at");
                occurrence["start_date"] = data[day]!["date"]!.DeepClone();
                occurrence["end_date_exclusive"] = "2026-10-27";
            }
            if (invalid == "missing")
                occurrence.Remove("participation_expectation");
            else
                occurrence["participation_expectation"] = invalid switch
                {
                    "null" => null,
                    "number" => JsonValue.Create(1),
                    _ => JsonValue.Create("CONFIDENTIAL_PARTICIPATION_MARKER")
                };
            data[day]!["occurrences"] = new JsonArray(
                data["primary"]!["occurrences"]![0]!.DeepClone(), occurrence);
            data[day]!["eligible_total"] = 2;
            foreach (var placement in new[] { "full", "half_horizontal", "half_vertical" })
            {
                var error = Assert.ThrowsAny<Exception>(() => Render(placement, data));
                Assert.Contains("Invalid participation expectation", error.Message);
                Assert.DoesNotContain("CONFIDENTIAL_PARTICIPATION_MARKER", error.Message);
            }
        }
    }

    [Theory]
    [InlineData("configuration_invalid", "Rule configuration is missing or malformed.")]
    [InlineData("source_unavailable", "The calendar source could not be checked.")]
    [InlineData("compatibility_unsupported", "The source contains unsupported calendar semantics.")]
    public async Task Failures_show_their_error_not_a_healthy_empty_day(string code, string message)
    {
        var data = CurrentAgenda();
        data["state"] = "error";
        data["source_succeeded_at"] = null;
        data["primary"]!["eligible_total"] = null;
        data["primary"]!["occurrences"] = new JsonArray();
        data["secondary"]!["eligible_total"] = null;
        data["error"] = new JsonObject { ["code"] = code, ["message"] = message };
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await Show(page, data);

        await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(message, new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(code, new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No successful source check", new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("0 eligible", await page.Locator("body").InnerTextAsync());
    }

    [Fact]
    public async Task A_current_empty_primary_day_stays_explicitly_empty_and_keeps_the_selected_dates()
    {
        var data = CurrentAgenda();
        data["primary"]!["eligible_total"] = 0;
        data["primary"]!["occurrences"] = new JsonArray();
        data["secondary"]!["eligible_total"] = 0;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await Show(page, data);

        await Assertions.Expect(page.Locator(".agenda-primary").GetByText("No remaining events", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Friday, Oct 23", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Monday, Oct 26", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No remaining events", new() { Exact = true })).ToHaveCountAsync(2);
        await InsideScreen(page, page.Locator(".agenda-secondary"));
        await InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task Calendar_text_is_readable_text_not_executable_markup()
    {
        var data = CurrentAgenda();
        const string title = "<svg onload=window.pwn=1>";
        data["primary"]!["occurrences"]![0]!["title"] = title;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await Show(page, data);

        await Assertions.Expect(page.GetByText(title, new() { Exact = true })).ToBeVisibleAsync();
        Assert.Null(await page.EvaluateAsync<int?>("window.pwn"));
        Assert.Equal(0, await page.Locator(".agenda-primary svg[onload]").CountAsync());
        Assert.True(await page.Locator(".agenda-primary td .title").EvaluateAsync<float>(
            "element => parseFloat(getComputedStyle(element).fontSize)") >= 20);
        await InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task A_busy_OG_agenda_keeps_truthful_overflow_secondary_count_and_source_time_visible()
    {
        var data = CurrentAgenda();
        var prototype = data["primary"]!["occurrences"]![0]!;
        var occurrences = new JsonArray();
        for (var index = 1; index <= 14; index++)
        {
            var occurrence = prototype.DeepClone();
            occurrence["id"] = $"synthetic-{index}";
            occurrence["title"] = $"Commitment {index}: {new string('W', 100)}";
            occurrences.Add(occurrence);
        }
        data["primary"]!["eligible_total"] = 14;
        data["primary"]!["occurrences"] = occurrences;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await Show(page, data);
        var visibleTimes = page.Locator("[data-agenda-start]:visible");
        await Assertions.Expect(visibleTimes.First).ToBeVisibleAsync();
        var visibleCount = await visibleTimes.CountAsync();

        Assert.InRange(visibleCount, 1, 13);
        await AdaptiveDisplayTests.DayCount(page, "primary", 14);
        await AdaptiveDisplayTests.DayCount(page, "secondary", 3);
        await InsideScreen(page, visibleTimes.Last);
        await InsideScreen(page, page.Locator(".agenda-primary td .title:visible").First);
        await InsideScreen(page, page.Locator(".agenda-secondary"));
        await InsideScreen(page, page.Locator(".agenda-source"));
        Directory.CreateDirectory(Path.Combine(Root, "artifacts"));
        await page.ScreenshotAsync(new() { Path = Path.Combine(Root, "artifacts", "og-busy.png") });
    }

    [Fact]
    public async Task End_to_end_demo_fetches_real_HTTP_source_through_Functions_and_renders_production_TRMNL()
    {
        var sourcePort = FreePort();
        var functionPort = FreePort();
        var sourceStart = new ProcessStartInfo("node") { WorkingDirectory = Root };
        sourceStart.ArgumentList.Add(Path.Combine(Root, "scripts", "synthetic-source.mjs"));
        sourceStart.ArgumentList.Add(sourcePort.ToString());
        using var synthetic = Process.Start(sourceStart)!;
        var functionStart = new ProcessStartInfo(OperatingSystem.IsWindows() ? "pwsh" : "func")
        {
            WorkingDirectory = Path.Combine(Root, "src", "CalendarAgenda", "bin",
                new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name, "net10.0"),
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        if (OperatingSystem.IsWindows())
        {
            foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-Command",
                $"func start --no-build --port {functionPort}" })
                functionStart.ArgumentList.Add(argument);
        }
        else
        {
            foreach (var argument in new[] { "start", "--no-build", "--port", functionPort.ToString() })
                functionStart.ArgumentList.Add(argument);
        }
        functionStart.Environment["FUNCTIONS_WORKER_RUNTIME"] = "dotnet-isolated";
        functionStart.Environment["AZURE_FUNCTIONS_ENVIRONMENT"] = "Development";
        functionStart.Environment["Agenda__SourceUrl"] =
            $"http://127.0.0.1:{sourcePort}/calendar.ics?key=CONFIDENTIAL_SOURCE_CREDENTIAL";
        var cacheDirectory = Path.Combine(Root, "artifacts", "demo-source-cache", Guid.NewGuid().ToString("N"));
        functionStart.Environment["Agenda__DevelopmentCacheDirectory"] = cacheDirectory;
        functionStart.Environment["AzureWebJobsSecretStorageType"] = "files";
        functionStart.Environment["AzureWebJobsStorage"] = "";
        functionStart.Environment.Remove("APPLICATIONINSIGHTS_CONNECTION_STRING");
        functionStart.Environment.Remove("APPINSIGHTS_INSTRUMENTATIONKEY");
        using var functions = new Process { StartInfo = functionStart };
        var functionStarted = false;
        var stdout = Task.FromResult("");
        var stderr = Task.FromResult("");
        var previousDiagnostics = "";
        try
        {
            Assert.True(functions.Start(), "The local Functions process could not be started.");
            functionStarted = true;
            stdout = functions.StandardOutput.ReadToEndAsync();
            stderr = functions.StandardError.ReadToEndAsync();
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            client.DefaultRequestHeaders.Add("x-functions-key", "synthetic-local-only");
            var pollingBody = Render("polling-body", new { rules_json = "[]" });
            await WaitForHost();
            await RefreshSyntheticSource();
            var json = await PollRunningHost();
            var data = JsonNode.Parse(json)!.AsObject();
            Assert.Equal("current", data["state"]!.GetValue<string>());
            Assert.True(data["primary"]!["eligible_total"]!.GetValue<int>() >= 1);
            Assert.Equal(1, data["secondary"]!["eligible_total"]!.GetValue<int>());
            Assert.Equal("Secondary working-day meeting",
                data["secondary"]!["occurrences"]![0]!["title"]!.GetValue<string>());
            Assert.DoesNotContain("description", json, StringComparison.OrdinalIgnoreCase);
            using var definitions = JsonDocument.Parse(
                await client.GetStringAsync($"http://127.0.0.1:{functionPort}/admin/functions"));
            Assert.Equal(2, definitions.RootElement.GetArrayLength());
            var definition = definitions.RootElement.EnumerateArray()
                .Single(item => item.GetProperty("name").GetString() == "Agenda");
            var refreshDefinition = definitions.RootElement.EnumerateArray()
                .Single(item => item.GetProperty("name").GetString() == "RefreshSource");
            var timerBinding = Assert.Single(refreshDefinition.GetProperty("config").GetProperty("bindings")
                .EnumerateArray(), binding => binding.GetProperty("type").GetString() == "timerTrigger");
            Assert.Equal("0 */5 * * * *", timerBinding.GetProperty("schedule").GetString());
            Assert.False(timerBinding.GetProperty("runOnStartup").GetBoolean());
            Assert.True(timerBinding.GetProperty("useMonitor").GetBoolean());
            Assert.Equal("Agenda", definition.GetProperty("name").GetString());
            var trigger = definition.GetProperty("config").GetProperty("bindings").EnumerateArray()
                .Single(binding => binding.GetProperty("type").GetString() == "httpTrigger");
            Assert.Equal("Function", trigger.GetProperty("authLevel").GetString());
            Assert.Equal("agenda", trigger.GetProperty("route").GetString());
            Assert.Equal(["post"], trigger.GetProperty("methods").EnumerateArray().Select(method => method.GetString()));
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync();
            var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
            await Show(page, data);
            await Assertions.Expect(page.GetByText("Synthetic source meeting", new() { Exact = true })).ToBeVisibleAsync();
            await InsideScreen(page, page.Locator(".agenda-secondary"));
            await InsideScreen(page, page.Locator(".agenda-source"));
            Directory.CreateDirectory(Path.Combine(Root, "artifacts"));
            await File.WriteAllTextAsync(Path.Combine(Root, "artifacts", "demo-agenda.json"), json);
            await File.WriteAllTextAsync(Path.Combine(Root, "artifacts", "demo.html"), Render("full", data));
            await page.ScreenshotAsync(new() { Path = Path.Combine(Root, "artifacts", "demo.png") });

            await RenderNativePreviews(data, "demo");

            var editedBody = Render("polling-body", new
            {
                rules_json = """
                    [
                      {"field":"title","mode":"contains","value":"meeting"},
                      {"field":"title","mode":"contains","value":"CONFIDENTIAL_RULE_LITERAL"}
                    ]
                    """
            });
            using var editedResponse = await client.PostAsync($"http://127.0.0.1:{functionPort}/api/agenda",
                new StringContent(editedBody, System.Text.Encoding.UTF8, "application/json"));
            editedResponse.EnsureSuccessStatusCode();
            var edited = JsonNode.Parse(await editedResponse.Content.ReadAsStringAsync())!.AsObject();
            Assert.Equal("current", edited["state"]!.GetValue<string>());
            Assert.Equal(0, edited["primary"]!["eligible_total"]!.GetValue<int>());
            Assert.Equal(0, edited["secondary"]!["eligible_total"]!.GetValue<int>());
            Assert.DoesNotContain("meeting", edited.ToJsonString(), StringComparison.OrdinalIgnoreCase);
            await Show(page, edited);
            await Assertions.Expect(page.GetByText("No remaining events", new() { Exact = true })).ToHaveCountAsync(2);

            var invalidBody = Render("polling-body", new
            {
                rules_json = "CONFIDENTIAL_EDITOR_LITERAL\n\"},\"rules_json\":\"[]\""
            });
            using var invalidResponse = await client.PostAsync($"http://127.0.0.1:{functionPort}/api/agenda",
                new StringContent(invalidBody, System.Text.Encoding.UTF8, "application/json"));
            invalidResponse.EnsureSuccessStatusCode();
            var invalid = JsonNode.Parse(await invalidResponse.Content.ReadAsStringAsync())!.AsObject();
            Assert.Equal("error", invalid["state"]!.GetValue<string>());
            Assert.Null(invalid["primary"]!["eligible_total"]);
            Assert.DoesNotContain("CONFIDENTIAL", invalid.ToJsonString());
            await Show(page, invalid);
            await Assertions.Expect(page.GetByText("configuration_invalid", new() { Exact = true })).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToBeVisibleAsync();
            await InsideScreen(page, page.GetByText("configuration_invalid", new() { Exact = true }));
            await InsideScreen(page, page.Locator(".agenda-source"));

            using var clearedResponse = await client.PostAsync($"http://127.0.0.1:{functionPort}/api/agenda",
                new StringContent(pollingBody, System.Text.Encoding.UTF8, "application/json"));
            clearedResponse.EnsureSuccessStatusCode();
            var cleared = JsonNode.Parse(await clearedResponse.Content.ReadAsStringAsync())!.AsObject();
            Assert.Equal("current", cleared["state"]!.GetValue<string>());
            await Show(page, cleared);
            await Assertions.Expect(page.GetByText("Synthetic source meeting", new() { Exact = true })).ToBeVisibleAsync();

            using var failSource = await client.PostAsync($"http://127.0.0.1:{sourcePort}/fail-source", null);
            failSource.EnsureSuccessStatusCode();
            await RefreshSyntheticSource();
            var failed = JsonNode.Parse(await PollRunningHost("stale"))!.AsObject();
            Assert.Equal("stale", failed["state"]!.GetValue<string>());
            Assert.Equal("source_unavailable", failed["error"]!["code"]!.GetValue<string>());
            Assert.Equal(cleared["source_succeeded_at"]!.GetValue<string>(),
                failed["source_succeeded_at"]!.GetValue<string>());

            functions.Kill(entireProcessTree: true);
            await functions.WaitForExitAsync();
            previousDiagnostics = $"{await stdout}\n{await stderr}";
            Assert.True(functions.Start(), "The local Functions process could not be restarted.");
            stdout = functions.StandardOutput.ReadToEndAsync();
            stderr = functions.StandardError.ReadToEndAsync();
            var reloaded = JsonNode.Parse(await PollRunningHost("stale"))!.AsObject();
            Assert.Equal("stale", reloaded["state"]!.GetValue<string>());
            Assert.Equal("source_unavailable", reloaded["error"]!["code"]!.GetValue<string>());
            Assert.Equal(cleared["source_succeeded_at"]!.GetValue<string>(),
                reloaded["source_succeeded_at"]!.GetValue<string>());
            await File.WriteAllTextAsync(Path.Combine(Root, "artifacts", "demo-stale-agenda.json"), reloaded.ToJsonString());
            await RenderNativePreviews(reloaded, "demo-stale");

            async Task WaitForHost()
            {
                using var ready = new CancellationTokenSource(TimeSpan.FromSeconds(60));
                while (true)
                {
                    try
                    {
                        using var response = await client.GetAsync($"http://127.0.0.1:{functionPort}/admin/functions",
                            ready.Token);
                        if (response.IsSuccessStatusCode)
                        {
                            using var indexed = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ready.Token));
                            if (indexed.RootElement.GetArrayLength() == 2)
                                return;
                        }
                    }
                    catch (HttpRequestException) { }
                    await Task.Delay(100, ready.Token);
                }
            }

            async Task RefreshSyntheticSource()
            {
                var services = new ServiceCollection();
                AgendaHosting.AddSourceClient(services);
                await using var provider = services.BuildServiceProvider();
                using var source = provider.GetRequiredService<IHttpClientFactory>().CreateClient();
                var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["AZURE_FUNCTIONS_ENVIRONMENT"] = "Development",
                    ["Agenda:SourceUrl"] = functionStart.Environment["Agenda__SourceUrl"],
                    ["Agenda:DevelopmentCacheDirectory"] = cacheDirectory
                }).Build();
                var worker = new AgendaFunction(source, configuration, TimeProvider.System,
                    NullLogger<AgendaFunction>.Instance);
                var now = DateTime.UtcNow;
                var scheduled = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute / 15 * 15, 0, DateTimeKind.Utc);
                await worker.Refresh(new TimerInfo { ScheduleStatus = new ScheduleStatus { Next = scheduled } });
            }

            async Task<string> PollRunningHost(string expectedState = "current")
            {
                var lastFailure = "No response.";
                var deadline = DateTime.UtcNow.AddSeconds(60);
                while (DateTime.UtcNow < deadline)
                {
                    if (functions.HasExited)
                        Assert.Fail($"Local Functions host exited.\n{await stdout}\n{await stderr}");
                    try
                    {
                        using var response = await client.PostAsync($"http://127.0.0.1:{functionPort}/api/agenda",
                            new StringContent(pollingBody, System.Text.Encoding.UTF8, "application/json"));
                        if (response.IsSuccessStatusCode)
                        {
                            var body = await response.Content.ReadAsStringAsync();
                            using var result = JsonDocument.Parse(body);
                            if (result.RootElement.GetProperty("state").GetString() == expectedState)
                                return body;
                        }
                        lastFailure = $"HTTP {(int)response.StatusCode}.";
                    }
                    catch (HttpRequestException) { lastFailure = "Local host connection failed."; }
                    catch (TaskCanceledException) { lastFailure = "Local host response timed out."; }
                    await Task.Delay(500);
                }
                functions.Kill(entireProcessTree: true);
                await functions.WaitForExitAsync();
                throw new Xunit.Sdk.XunitException(
                    $"Local Functions host was not ready: {lastFailure}\n{await stdout}\n{await stderr}");
            }

            async Task RenderNativePreviews(JsonObject agenda, string prefix)
            {
                foreach (var (device, width, height) in new[] { ("og", 800, 480), ("v2", 1872, 1404) })
                    foreach (var placement in new[] { "full", "half_horizontal", "half_vertical" })
                    {
                        var name = $"{prefix}-{(device == "v2" ? "x" : device)}-{placement}";
                        await File.WriteAllTextAsync(Path.Combine(Root, "artifacts", $"{name}.html"),
                            Render(placement, agenda, device));
                        var preview = await browser.NewPageAsync(new()
                        {
                            ViewportSize = new() { Width = width, Height = height }
                        });
                        var navigation = await preview.GotoAsync($"http://127.0.0.1:{sourcePort}/{name}.html");
                        Assert.NotNull(navigation);
                        Assert.Equal(200, navigation.Status);
                        await preview.EvaluateAsync("document.fonts.ready");
                        await preview.WaitForFunctionAsync("window.TRMNL_PLUGINS_READY === true");
                        await preview.WaitForFunctionAsync("document.querySelector('.agenda').dataset.agendaReady === 'true'");
                        await AdaptiveDisplayTests.VisibleInsideView(
                            preview.GetByText("Synthetic source meeting", new() { Exact = true }),
                            textMayBeTruncated: true);
                        var participation = preview.Locator(".agenda-primary tbody tr")
                            .Filter(new() { HasText = "Synthetic source meeting" }).Locator(".agenda-participation");
                        await Assertions.Expect(participation).ToHaveTextAsync("Unknown");
                        await AdaptiveDisplayTests.VisibleInsideView(participation);
                        foreach (var day in new[] { "primary", "secondary" })
                            await AdaptiveDisplayTests.VisibleInsideView(
                                preview.GetByText(agenda[day]!["label"]!.GetValue<string>(), new() { Exact = true }));
                        if (agenda["state"]!.GetValue<string>() == "stale")
                        {
                            await AdaptiveDisplayTests.VisibleInsideView(
                                preview.GetByText("Stale agenda", new() { Exact = true }));
                            await AdaptiveDisplayTests.VisibleInsideView(
                                preview.GetByText("The calendar source could not be checked.", new() { Exact = true }));
                        }
                        await AdaptiveDisplayTests.VisibleInsideView(preview.Locator("[data-agenda-source]"));
                        await Assertions.Expect(preview.Locator("[data-agenda-source]"))
                            .ToHaveAttributeAsync("datetime", agenda["source_succeeded_at"]!.GetValue<string>());
                        await preview.ScreenshotAsync(new() { Path = Path.Combine(Root, "artifacts", $"{name}.png") });
                        await preview.CloseAsync();
                    }
            }
        }
        finally
        {
            if (functionStarted && !functions.HasExited) functions.Kill(entireProcessTree: true);
            if (!synthetic.HasExited) synthetic.Kill(entireProcessTree: true);
            if (functionStarted) await functions.WaitForExitAsync();
            await synthetic.WaitForExitAsync();
            Directory.CreateDirectory(Path.Combine(Root, "artifacts"));
            var diagnostics = $"{previousDiagnostics}\n{await stdout}\n{await stderr}";
            await File.WriteAllTextAsync(Path.Combine(Root, "artifacts", "demo-host.log"), diagnostics);
            Assert.DoesNotContain("CONFIDENTIAL", diagnostics);
            Assert.DoesNotContain("synthetic-local-only", diagnostics);
            if (Directory.Exists(cacheDirectory))
                Directory.Delete(cacheDirectory, recursive: true);
        }
    }

    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    internal static async Task InsideScreen(IPage page, ILocator content)
    {
        var screen = await page.Locator(".screen").BoundingBoxAsync();
        var box = await content.BoundingBoxAsync();
        Assert.NotNull(screen);
        Assert.NotNull(box);
        Assert.True(box.X >= screen.X && box.Y >= screen.Y
            && box.X + box.Width <= screen.X + screen.Width
            && box.Y + box.Height <= screen.Y + screen.Height, "Required content must fit inside the physical screen.");
    }

    internal static string Render(string mode, object variables, string device = "og")
        => RunRuby(Path.Combine(Root, "display", "render.rb"), variables, mode, device);

    internal static string RunRuby(string script, object variables, params string[] arguments)
    {
        var localRuby = Path.Combine(Root, ".tools", "ruby", "bin", "ruby.exe");
        var ruby = Environment.GetEnvironmentVariable("TRMNL_RUBY")
            ?? (File.Exists(localRuby) ? localRuby : "ruby");
        var start = new ProcessStartInfo(ruby)
        {
            WorkingDirectory = Root,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = new UTF8Encoding(false),
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(script);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.StandardInput.Write(JsonSerializer.Serialize(variables));
        process.StandardInput.Close();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            Assert.Fail("The production TRMNL renderer timed out.");
        }
        var output = Task.WhenAll(stdout, stderr).GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, output[1]);
        return output[0];
    }

    internal static async Task Show(IPage page, object data, string mode = "full", string device = "og")
    {
        var html = Render(mode, data, device);
        html = html.Replace("</head>", $$"""
            <script type="module">
              import { checkLayout } from "/workbench/layout-checks.mjs";
              const previous = Object.getOwnPropertyDescriptor(window, "TRMNL_PLUGINS_READY");
              let ready = window.TRMNL_PLUGINS_READY;
              window.agendaCaptureFindings = ready === true
                ? [[{ message: "Native readiness was published before capture instrumentation." }]] : [];
              Object.defineProperty(window, "TRMNL_PLUGINS_READY", {
                configurable: true,
                get: () => ready,
                set: value => {
                  ready = value;
                  previous?.set?.(value);
                  if (value !== true || !document.querySelector(".agenda")) return;
                  window.agendaCaptureFindings.push(checkLayout(document, {{JsonSerializer.Serialize(data)}},
                    { width: {{(device == "og" ? 800 : 1872)}}, height: {{(device == "og" ? 480 : 1404)}} })
                    .filter(item => !item.passed));
                }
              });
            </script>
            </head>
            """);
        await page.UnrouteAsync("http://trmnl.local/**");
        await page.RouteAsync("http://trmnl.local/**", async route =>
        {
            var path = new Uri(route.Request.Url).AbsolutePath;
            if (path == "/")
            {
                await route.FulfillAsync(new() { Body = html, ContentType = "text/html" });
                return;
            }
            if (path == "/workbench/layout-checks.mjs")
            {
                await route.FulfillAsync(new()
                {
                    Path = Path.Combine(Root, "display", "workbench", "layout-checks.mjs"),
                    ContentType = "application/javascript"
                });
                return;
            }
            var asset = Path.Combine(Root, ".tools", "framework",
                path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
            Assert.True(File.Exists(asset), $"Missing framework asset: {path}. Run scripts\\setup-display.ps1.");
            var contentType = Path.GetExtension(asset) switch
            {
                ".css" => "text/css",
                ".js" => "application/javascript",
                ".woff2" => "font/woff2",
                ".woff" => "font/woff",
                ".ttf" => "font/ttf",
                _ => "application/octet-stream"
            };
            await route.FulfillAsync(new() { Path = asset, ContentType = contentType });
        });
        await page.GotoAsync("http://trmnl.local/");
        await page.EvaluateAsync("document.fonts.ready");
        await page.WaitForFunctionAsync("window.TRMNL_PLUGINS_READY === true");
        await page.WaitForFunctionAsync("document.querySelector('.agenda').dataset.agendaReady === 'true'");
        var captures = await page.EvaluateAsync<JsonElement>("window.agendaCaptureFindings");
        Assert.NotEmpty(captures.EnumerateArray());
        foreach (var capture in captures.EnumerateArray())
        {
            if (capture.GetArrayLength() > 0)
            {
                Directory.CreateDirectory(Path.Combine(Root, "artifacts"));
                await page.ScreenshotAsync(new() { Path = Path.Combine(Root, "artifacts", $"capture-invalid-{device}-{mode}.png") });
            }
            Assert.True(capture.GetArrayLength() == 0, $"Invalid layout at native capture readiness: {capture}");
        }
    }

    internal static JsonObject CurrentAgenda() => AgendaScenarios.Load("reference");
}
