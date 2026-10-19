using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Fact]
    public async Task A_stalled_source_returns_a_renderable_failure_after_six_seconds_within_the_poll_budget()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"),
            sourceDelay: Timeout.InfiniteTimeSpan);
        var elapsed = Stopwatch.StartNew();
        using var result = await agenda.Poll();

        Assert.InRange(elapsed.Elapsed.TotalSeconds, 5.8, 10);
        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("source_unavailable", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("primary").GetProperty("eligible_total").ValueKind);
    }

    [Theory]
    [InlineData("current", 14_000, "\u754c", null)]
    [InlineData("error", 100_000, "X", "agenda_too_large")]
    public async Task Synthetic_delivery_tool_measures_real_HTTP_agenda_as_native_single_URL_polling_data(
        string state, int titleLength, string character, string? code)
    {
        var title = string.Concat(Enumerable.Repeat(character, titleLength));
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            CalendarWithEvent("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nSUMMARY:" + title));
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var boundary = builder.Build();
        const string key = "SYNTHETIC_FUNCTION_SCOPED_KEY";
        // This loopback boundary models external host auth, not Azure enforcement evidence.
        boundary.MapPost("/api/agenda", async context =>
        {
            if (context.Request.Headers["x-functions-key"] != key)
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            using var reader = new StreamReader(context.Request.Body);
            using var result = await agenda.Poll(await reader.ReadToEndAsync());
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(result.RootElement.GetRawText());
        });
        await boundary.StartAsync();
        var start = new ProcessStartInfo("node")
        {
            WorkingDirectory = DisplayTests.Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in new[]
            {
                Path.Combine(DisplayTests.Root, "scripts", "smoke-delivery.mjs"), "--synthetic-local",
                "--endpoint", boundary.Urls.Single() + "/api/agenda", "--expected-state", state
            })
            start.ArgumentList.Add(argument);
        if (code is not null)
        {
            start.ArgumentList.Add("--expected-code");
            start.ArgumentList.Add(code);
        }
        start.Environment["TRMNL_FUNCTION_KEY"] = key;
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(40));
            Assert.True(process.ExitCode == 0, await errors);
            var reportText = await output;
            using var report = JsonDocument.Parse(reportText);
            var poll = report.RootElement.GetProperty("poll");
            Assert.Equal("local_synthetic", report.RootElement.GetProperty("evidence_scope").GetString());
            Assert.False(report.RootElement.GetProperty("activation_complete").GetBoolean());
            Assert.Equal(state, poll.GetProperty("state").GetString());
            Assert.InRange(poll.GetProperty("combined_polling_utf8_bytes").GetInt32(), 1, 99_999);
            Assert.InRange(poll.GetProperty("raw_response_utf8_bytes").GetInt32(), 1, 95_000);
            if (state == "current")
            {
                Assert.True(poll.GetProperty("raw_response_utf8_bytes").GetInt32() > 80_000);
                Assert.True(poll.GetProperty("combined_polling_utf8_bytes").GetInt32() > 40_000);
            }
            Assert.DoesNotContain(key, reportText);
            Assert.DoesNotContain(character == "\u754c" ? character : new string('X', 100), reportText);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            await boundary.StopAsync();
        }
    }

    [Theory]
    [InlineData("configuration_invalid")]
    [InlineData("source_configuration")]
    [InlineData("source_unavailable")]
    [InlineData("source_invalid")]
    [InlineData("compatibility_unsupported")]
    [InlineData("cache_configuration")]
    [InlineData("cache_unavailable")]
    [InlineData("cache_invalid")]
    public async Task Delivery_diagnostics_emit_only_bounded_failure_categories_through_HTTP(string code)
    {
        using var storage = new CacheDirectory();
        Directory.CreateDirectory(storage.Path);
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var source = code switch
        {
            "source_invalid" => "CONFIDENTIAL_SOURCE_CONTENTS",
            "compatibility_unsupported" => Fixture("this-and-future.ics"),
            _ => Fixture("basic.ics")
        };
        var directory = code == "cache_unavailable" ? Path.Combine(storage.Path, "not-a-directory") : storage.Path;
        if (code == "cache_unavailable")
            await File.WriteAllTextAsync(directory, "CONFIDENTIAL_STORAGE_DETAILS");
        if (code == "cache_invalid")
            await File.WriteAllTextAsync(Path.Combine(directory, "last-good-source.json"), "CONFIDENTIAL_INVALID_CACHE");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", source,
            sourceUrl: code == "source_configuration" ? "http://synthetic.invalid/CONFIDENTIAL_SOURCE_KEY"
                : "https://synthetic.invalid/CONFIDENTIAL_SOURCE_KEY",
            logger: diagnostics, cacheDirectory: directory,
            runtimeSettings: code == "cache_configuration"
                ? new Dictionary<string, string?> { ["AZURE_FUNCTIONS_ENVIRONMENT"] = "Production" } : null);
        if (code is "source_unavailable" or "cache_invalid")
            agenda.SetSource("CONFIDENTIAL_REJECTED_BODY", HttpStatusCode.ServiceUnavailable,
                transportFailure: code == "source_unavailable");
        using var result = await agenda.Poll(JsonSerializer.Serialize(new
        {
            rules_json = code == "configuration_invalid"
                ? "CONFIDENTIAL_MALFORMED_RULES"
                : """[{"field":"title","mode":"contains","value":"CONFIDENTIAL_RULE_LITERAL"}]"""
        }));

        Assert.Equal(code, result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal($"Agenda failed with code {code}.", Assert.Single(diagnostics.Messages));
        Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
        Assert.True(Encoding.UTF8.GetByteCount(diagnostics.Messages.Single()) < 100);
    }
}
