using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Playwright;

namespace CalendarAgenda.Tests;

internal static class ValidationTiming
{
    private static readonly object Gate = new();
    private static readonly string? DirectoryPath = Environment.GetEnvironmentVariable("TRMNL_TIMING_DIRECTORY");

    static ValidationTiming()
    {
        if (DirectoryPath is null) return;
        Directory.CreateDirectory(DirectoryPath);
        File.WriteAllText(Path.Combine(DirectoryPath, $"inventory-{Environment.ProcessId}.json"),
            JsonSerializer.Serialize(new
            {
                scenarios = AgendaScenarios.Ids.ToArray(),
                views = AdaptiveDisplayTests.Views.Cast<object[]>().Select(row =>
                {
                    var view = (AdaptiveDisplayTests.NativeView)row[0];
                    return $"{view.Device}/{view.Placement}";
                }).ToArray(),
                playwright = typeof(Playwright).Assembly.GetName().Version?.ToString()
            }));
    }

    internal static async Task<IPlaywright> CreatePlaywright([CallerMemberName] string scenario = "")
        => await RunAsync("browser.create", Playwright.CreateAsync, scenario);

    internal static async Task<IBrowser> Launch(IPlaywright playwright, [CallerMemberName] string scenario = "")
        => await RunAsync("browser.launch", () => playwright.Chromium.LaunchAsync(), scenario);

    internal static async Task<byte[]> Screenshot(IPage page, PageScreenshotOptions? options = null,
        [CallerMemberName] string scenario = "")
        => await RunAsync("screenshot", () => page.ScreenshotAsync(options), scenario);

    internal static T Run<T>(string phase, Func<T> operation, [CallerMemberName] string scenario = "")
    {
        if (DirectoryPath is null) return operation();
        var id = Guid.NewGuid().ToString("N");
        var timer = Stopwatch.StartNew();
        Write(new { kind = "start", id, phase, scenario, started_at = DateTimeOffset.UtcNow });
        var passed = false;
        try
        {
            var value = operation();
            passed = true;
            return value;
        }
        finally
        {
            Write(new
            {
                kind = "end",
                id,
                phase,
                scenario,
                duration_ms = timer.Elapsed.TotalMilliseconds,
                result = passed ? "passed" : "failed"
            });
        }
    }

    private static async Task<T> RunAsync<T>(string phase, Func<Task<T>> operation, string scenario)
    {
        if (DirectoryPath is null) return await operation();
        var id = Guid.NewGuid().ToString("N");
        var timer = Stopwatch.StartNew();
        Write(new { kind = "start", id, phase, scenario, started_at = DateTimeOffset.UtcNow });
        var passed = false;
        string? toolVersion = null;
        try
        {
            var value = await operation();
            if (value is IBrowser browser) toolVersion = browser.Version;
            passed = true;
            return value;
        }
        finally
        {
            Write(new
            {
                kind = "end",
                id,
                phase,
                scenario,
                tool_version = toolVersion,
                duration_ms = timer.Elapsed.TotalMilliseconds,
                result = passed ? "passed" : "failed"
            });
        }
    }

    private static void Write(object value)
    {
        lock (Gate)
        {
            var path = Path.Combine(DirectoryPath!, $"phases-dotnet-{Environment.ProcessId}.jsonl");
            if (File.Exists(path) && new FileInfo(path).Length > 20 * 1024 * 1024)
                throw new InvalidOperationException("Rendering timing report exceeds diagnostic limit.");
            File.AppendAllText(path, JsonSerializer.Serialize(value) + "\n");
        }
    }
}
