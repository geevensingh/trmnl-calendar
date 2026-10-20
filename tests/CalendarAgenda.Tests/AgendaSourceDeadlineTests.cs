using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit;
using Xunit.Abstractions;

namespace CalendarAgenda.Tests;

public sealed class AgendaSourceDeadlineTests(ITestOutputHelper output)
{
    private const string Calendar = """
        BEGIN:VCALENDAR
        VERSION:2.0
        PRODID:-//TRMNL Calendar//Synthetic deadline tests//EN
        BEGIN:VEVENT
        UID:delayed@synthetic.invalid
        DTSTAMP:20260101T120000Z
        DTSTART;VALUE=DATE:20260101
        DTEND;VALUE=DATE:20260102
        RRULE:FREQ=DAILY;UNTIL=20301231
        SUMMARY:Synthetic delayed commitment
        END:VEVENT
        END:VCALENDAR
        """;

    [Theory]
    [InlineData(7, 0)]
    [InlineData(0, 7)]
    [InlineData(4, 3)]
    public async Task A_source_arriving_after_six_seconds_is_current_through_the_registered_Functions_client(
        int headerSeconds, int bodySeconds)
    {
        await using var source = await SyntheticSource.Start();
        source.HeaderDelay = TimeSpan.FromSeconds(headerSeconds);
        source.BodyDelay = TimeSpan.FromSeconds(bodySeconds);
        await using var functions = await FunctionsHttp.Start(source.Url);
        var elapsed = Stopwatch.StartNew();

        using var result = await functions.Poll();

        output.WriteLine($"Headers {headerSeconds}s, body {bodySeconds}s: {elapsed.Elapsed.TotalMilliseconds:F0} ms.");
        var body = result.RootElement;
        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(1, body.GetProperty(day).GetProperty("eligible_total").GetInt32());
            var occurrence = Assert.Single(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
            Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
            Assert.Equal("Synthetic delayed commitment", occurrence.GetProperty("title").GetString());
        }
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 6.8, 9.999);
    }

    [Theory]
    [InlineData(30, 0)]
    [InlineData(0, 30)]
    [InlineData(5, 5)]
    public async Task The_eight_second_headers_and_body_deadline_preserves_stale_source_and_exact_expiry(
        int headerSeconds, int bodySeconds)
    {
        await using var source = await SyntheticSource.Start();
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient());
        using var current = await agenda.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        var succeededAt = current.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset();
        source.HeaderDelay = TimeSpan.FromSeconds(headerSeconds);
        source.BodyDelay = TimeSpan.FromSeconds(bodySeconds);
        agenda.Clock.Advance(TimeSpan.FromHours(1) - TimeSpan.FromTicks(1));

        foreach (var expectedState in new[] { "stale", "error" })
        {
            var elapsed = Stopwatch.StartNew();
            using var result = await agenda.Poll().WaitAsync(TimeSpan.FromSeconds(10));
            output.WriteLine($"{expectedState}, headers {headerSeconds}s, body {bodySeconds}s: "
                + $"{elapsed.Elapsed.TotalMilliseconds:F0} ms.");
            var body = result.RootElement;
            Assert.InRange(elapsed.Elapsed.TotalSeconds, 7.8, 9.999);
            Assert.Equal(expectedState, body.GetProperty("state").GetString());
            Assert.Equal("source_unavailable", body.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(succeededAt, body.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Equal(agenda.Clock.GetUtcNow(), body.GetProperty("generated_at").GetDateTimeOffset());
            foreach (var day in new[] { "primary", "secondary" })
            {
                var selected = body.GetProperty(day);
                if (expectedState == "stale")
                {
                    Assert.Equal(1, selected.GetProperty("eligible_total").GetInt32());
                    Assert.Equal("Synthetic delayed commitment", Assert.Single(
                        selected.GetProperty("occurrences").EnumerateArray()).GetProperty("title").GetString());
                }
                else
                {
                    Assert.Equal(JsonValueKind.Null, selected.GetProperty("eligible_total").ValueKind);
                    Assert.Empty(selected.GetProperty("occurrences").EnumerateArray());
                }
            }
            agenda.Clock.Advance(TimeSpan.FromTicks(1));
        }
    }

    [Theory]
    [InlineData("write")]
    [InlineData("read")]
    public async Task Cache_IO_keeps_the_original_nine_second_budget_after_a_slow_source(string operation)
    {
        await using var source = await SyntheticSource.Start();
        source.HeaderDelay = TimeSpan.FromSeconds(operation == "write" ? 7 : 30);
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient(), sourceCache: new StalledCache());
        var elapsed = Stopwatch.StartNew();

        using var result = await agenda.Poll().WaitAsync(TimeSpan.FromSeconds(11));

        output.WriteLine($"Source plus cache {operation}: {elapsed.Elapsed.TotalMilliseconds:F0} ms.");
        var body = result.RootElement;
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 8.8, 9.999);
        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("cache_unavailable", body.GetProperty("error").GetProperty("code").GetString());
        if (operation == "write")
            Assert.Equal(agenda.Clock.GetUtcNow(), body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        else
            Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
    }

    private sealed class StalledCache : SourceCache
    {
        internal override async Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return null;
        }

        internal override Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken) =>
            Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
    }

    private sealed class SyntheticSource(WebApplication app) : IAsyncDisposable
    {
        public TimeSpan HeaderDelay { get; set; }
        public TimeSpan BodyDelay { get; set; }
        public string Url => app.Urls.Single() + "/calendar.ics?key=CONFIDENTIAL_SYNTHETIC_SOURCE";

        public static async Task<SyntheticSource> Start()
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var app = builder.Build();
            var source = new SyntheticSource(app);
            app.MapGet("/calendar.ics", async context =>
            {
                await Task.Delay(source.HeaderDelay, context.RequestAborted);
                context.Response.ContentType = "text/calendar";
                await context.Response.StartAsync(context.RequestAborted);
                await Task.Delay(source.BodyDelay, context.RequestAborted);
                await context.Response.WriteAsync(Calendar, context.RequestAborted);
            });
            await app.StartAsync();
            return source;
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    private sealed class FunctionsHttp : IAsyncDisposable
    {
        private readonly Process process;
        private readonly HttpClient client;
        private readonly Task<string> stdout;
        private readonly Task<string> stderr;
        private readonly string cacheDirectory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache",
            Guid.NewGuid().ToString("N"));

        private FunctionsHttp(string sourceUrl)
        {
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var start = new ProcessStartInfo(OperatingSystem.IsWindows() ? "pwsh" : "func")
            {
                WorkingDirectory = Path.Combine(DisplayTests.Root, "src", "CalendarAgenda", "bin",
                    new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name, "net10.0"),
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var arguments = OperatingSystem.IsWindows()
                ? new[] { "-NoProfile", "-NonInteractive", "-Command", $"func start --no-build --port {port}" }
                : new[] { "start", "--no-build", "--port", port.ToString() };
            foreach (var argument in arguments)
                start.ArgumentList.Add(argument);
            start.Environment["FUNCTIONS_WORKER_RUNTIME"] = "dotnet-isolated";
            start.Environment["AZURE_FUNCTIONS_ENVIRONMENT"] = "Development";
            start.Environment["Agenda__SourceUrl"] = sourceUrl;
            start.Environment["Agenda__DevelopmentCacheDirectory"] = cacheDirectory;
            start.Environment["AzureWebJobsSecretStorageType"] = "files";
            start.Environment["AzureWebJobsStorage"] = "";
            start.Environment.Remove("APPLICATIONINSIGHTS_CONNECTION_STRING");
            start.Environment.Remove("APPINSIGHTS_INSTRUMENTATIONKEY");
            process = Process.Start(start)!;
            stdout = process.StandardOutput.ReadToEndAsync();
            stderr = process.StandardError.ReadToEndAsync();
            client = new HttpClient
            {
                BaseAddress = new Uri($"http://127.0.0.1:{port}"),
                Timeout = TimeSpan.FromSeconds(12)
            };
            client.DefaultRequestHeaders.Add("x-functions-key", "synthetic-local-only");
        }

        public static async Task<FunctionsHttp> Start(string sourceUrl)
        {
            var functions = new FunctionsHttp(sourceUrl);
            try
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(60));
                while (true)
                {
                    Assert.False(functions.process.HasExited, "The local Functions host exited before readiness.");
                    try
                    {
                        using var response = await functions.client.GetAsync("/admin/functions", deadline.Token);
                        if (response.IsSuccessStatusCode)
                        {
                            using var definitions = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
                            if (definitions.RootElement.EnumerateArray().Any())
                                return functions;
                        }
                    }
                    catch (HttpRequestException) { }
                    await Task.Delay(100, deadline.Token);
                }
            }
            catch
            {
                await functions.DisposeAsync();
                throw;
            }
        }

        public async Task<JsonDocument> Poll()
        {
            using var response = await client.PostAsync("/api/agenda",
                new StringContent("""{"rules_json":"[]"}""", Encoding.UTF8, "application/json"));
            response.EnsureSuccessStatusCode();
            Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        }

        public async ValueTask DisposeAsync()
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            var diagnostics = $"{await stdout}\n{await stderr}";
            process.Dispose();
            client.Dispose();
            if (Directory.Exists(cacheDirectory))
                Directory.Delete(cacheDirectory, recursive: true);
            Assert.DoesNotContain("CONFIDENTIAL", diagnostics);
            Assert.DoesNotContain("synthetic-local-only", diagnostics);
        }
    }
}
