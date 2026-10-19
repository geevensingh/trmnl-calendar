using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using CalendarAgenda;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class TemporarySmokeSourceTests
{
    [Fact]
    public async Task Anonymous_synthetic_source_is_disabled_without_an_authenticated_test_window()
    {
        await using var functions = await LocalFunctions.Start();
        using var response = await functions.Client.GetAsync("/api/smoke-source");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("smoke_disabled", body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Protected_control_opens_only_the_fixed_synthetic_source_for_same_app_HTTP_polling()
    {
        await using var functions = await LocalFunctions.Start();
        var expires = DateTimeOffset.UtcNow.AddMinutes(15);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/smoke-source-control")
        {
            Content = new StringContent(JsonSerializer.Serialize(new { mode = "valid", expires_at = expires }),
                Encoding.UTF8, "application/json")
        };
        request.Headers.Add("x-functions-key", "CONFIDENTIAL_SMOKE_CONTROL_KEY");
        using var configured = await functions.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        Assert.Equal("no-store", configured.Headers.CacheControl?.ToString());
        using var configuration = JsonDocument.Parse(await configured.Content.ReadAsStringAsync());
        Assert.Equal("valid", configuration.RootElement.GetProperty("mode").GetString());
        Assert.Equal(expires, configuration.RootElement.GetProperty("expires_at").GetDateTimeOffset());

        using var source = await functions.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.OK, source.StatusCode);
        Assert.Equal("text/calendar", source.Content.Headers.ContentType?.MediaType);
        Assert.Equal("no-store", source.Headers.CacheControl?.ToString());
        var calendar = await source.Content.ReadAsStringAsync();
        Assert.Contains("SUMMARY:Synthetic smoke primary all-day", calendar);
        Assert.Contains("SUMMARY:Synthetic smoke secondary planning", calendar);
        Assert.DoesNotContain("DESCRIPTION", calendar);
        Assert.DoesNotContain("ATTENDEE", calendar);
        Assert.DoesNotContain("CONFIDENTIAL", calendar);

        using var poll = new HttpRequestMessage(HttpMethod.Post, "/api/agenda")
        {
            Content = new StringContent("""{"rules_json":"[]"}""", Encoding.UTF8, "application/json")
        };
        poll.Headers.Add("x-functions-key", "CONFIDENTIAL_AGENDA_KEY");
        using var response = await functions.Client.SendAsync(poll);
        response.EnsureSuccessStatusCode();
        using var agenda = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("current", agenda.RootElement.GetProperty("state").GetString());
        Assert.True(agenda.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32() >= 1);
        Assert.Contains("Synthetic smoke primary all-day", agenda.RootElement.GetRawText());

        using var definitions = JsonDocument.Parse(await functions.Client.GetStringAsync("/admin/functions"));
        Assert.Equal(3, definitions.RootElement.GetArrayLength());
        foreach (var (name, route, auth, method) in new[]
        {
            ("Agenda", "agenda", "Function", "post"),
            ("SmokeSource", "smoke-source", "Anonymous", "get"),
            ("SmokeSourceControl", "smoke-source-control", "Function", "post")
        })
        {
            var definition = definitions.RootElement.EnumerateArray()
                .Single(function => function.GetProperty("name").GetString() == name);
            var trigger = definition.GetProperty("config").GetProperty("bindings").EnumerateArray()
                .Single(binding => binding.GetProperty("type").GetString() == "httpTrigger");
            Assert.Equal(route, trigger.GetProperty("route").GetString());
            Assert.Equal(auth, trigger.GetProperty("authLevel").GetString());
            Assert.Equal([method], trigger.GetProperty("methods").EnumerateArray().Select(value => value.GetString()));
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("{")]
    [InlineData("""{"mode":"valid"}""")]
    [InlineData("""{"expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":1,"expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"VALID","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"https://caller.invalid/CONFIDENTIAL","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T19:30:00Z","source_url":"https://caller.invalid/CONFIDENTIAL"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T19:30:00Z","calendar":"CONFIDENTIAL"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T19:30:00Z","path":"last-good-source.json"}""")]
    [InlineData("""{"mode":"valid","mode":"valid","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T19:30:00Z","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":90}""")]
    [InlineData("""{"mode":"valid","expires_at":"CONFIDENTIAL"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T18:00:00Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T17:59:59Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T19:30:00.0000001Z"}""")]
    [InlineData("""{"mode":"valid","expires_at":"2026-10-19T20:30:00+01:00"}""")]
    [InlineData("""{"mode":"\uD800","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"disabled","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"mode":"disabled","path":"last-good-source.json"}""")]
    public async Task Control_rejects_invalid_unbounded_duplicate_or_caller_content_configuration(string body)
    {
        using var source = new SyntheticHttp();
        using var response = await source.Control(body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using var error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("smoke_configuration_invalid", error.RootElement.GetProperty("code").GetString());
        Assert.DoesNotContain("CONFIDENTIAL", error.RootElement.GetRawText());
        using var disabled = await source.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, disabled.StatusCode);
    }

    [Fact]
    public async Task Original_absolute_window_cannot_be_extended_or_reopened_by_repeated_mode_writes_or_restart()
    {
        using var source = new SyntheticHttp();
        var expires = DateTimeOffset.Parse("2026-10-19T19:30:00Z");
        using var opened = await source.SetMode("valid", expires);
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);

        source.Clock.Advance(TimeSpan.FromMinutes(30));
        using var extension = await source.SetMode("valid", DateTimeOffset.Parse("2026-10-19T20:00:00Z"));
        Assert.Equal(HttpStatusCode.Conflict, extension.StatusCode);
        using var refused = JsonDocument.Parse(await extension.Content.ReadAsStringAsync());
        Assert.Equal("smoke_window_extension", refused.RootElement.GetProperty("code").GetString());

        using var repeated = await source.SetMode("valid", expires);
        Assert.Equal(HttpStatusCode.OK, repeated.StatusCode);
        using var unchanged = JsonDocument.Parse(await repeated.Content.ReadAsStringAsync());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            unchanged.RootElement.GetProperty("opened_at").GetDateTimeOffset());
        Assert.Equal(expires, unchanged.RootElement.GetProperty("expires_at").GetDateTimeOffset());

        using var recreated = new SyntheticHttp("2026-10-19T19:29:59.9999999Z", source.DirectoryPath);
        using var lastHealthy = await recreated.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.OK, lastHealthy.StatusCode);
        recreated.Clock.Advance(TimeSpan.FromTicks(1));
        using var expired = await recreated.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, expired.StatusCode);
        using var stopped = JsonDocument.Parse(await expired.Content.ReadAsStringAsync());
        Assert.Equal("smoke_expired", stopped.RootElement.GetProperty("code").GetString());

        using var renewal = await recreated.SetMode("valid", DateTimeOffset.Parse("2026-10-19T21:00:00Z"));
        Assert.Equal(HttpStatusCode.Conflict, renewal.StatusCode);
        using var stillExpired = JsonDocument.Parse(await renewal.Content.ReadAsStringAsync());
        Assert.Equal("smoke_window_expired", stillExpired.RootElement.GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("unavailable", HttpStatusCode.ServiceUnavailable, "source_unavailable")]
    [InlineData("malformed", HttpStatusCode.OK, "source_invalid")]
    [InlineData("unsupported_range", HttpStatusCode.OK, "compatibility_unsupported")]
    public async Task Same_URL_failure_modes_use_the_unchanged_production_stale_and_one_hour_expiry_policy(
        string mode, HttpStatusCode sourceStatus, string code)
    {
        using var source = new SyntheticHttp();
        var expires = DateTimeOffset.Parse("2026-10-19T19:30:00Z");
        using var opened = await source.SetMode("valid", expires);
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
        using var current = await source.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, current.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, current.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());

        source.Clock.Advance(TimeSpan.FromMinutes(30));
        using var configured = await source.SetMode(mode, expires);
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        using var upstream = await source.Client.GetAsync("/api/smoke-source");
        Assert.Equal(sourceStatus, upstream.StatusCode);
        using var stale = await source.Poll();
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal(code, stale.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            stale.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Contains("Synthetic smoke primary all-day", stale.RootElement.GetRawText());

        source.Clock.Advance(TimeSpan.FromMinutes(30));
        using var expired = await source.Poll();
        Assert.Equal("error", expired.RootElement.GetProperty("state").GetString());
        Assert.Equal(code, expired.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            expired.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, expired.RootElement.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(expired.RootElement.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
    }

    [Fact]
    public async Task Same_app_delay_exceeds_six_seconds_without_blocking_control_or_the_production_deadline()
    {
        await using var functions = await LocalFunctions.Start();
        var expires = DateTimeOffset.UtcNow.AddMinutes(15);
        using var valid = await functions.SetMode("valid", expires);
        Assert.Equal(HttpStatusCode.OK, valid.StatusCode);
        using var current = await functions.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        var succeededAt = current.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset();
        using var configured = await functions.SetMode("delay", expires);
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);

        var sourceElapsed = Stopwatch.StartNew();
        var delayed = functions.Client.GetAsync("/api/smoke-source");
        await Task.Delay(200);
        var controlElapsed = Stopwatch.StartNew();
        using var control = await functions.SetMode("delay", expires);
        Assert.Equal(HttpStatusCode.OK, control.StatusCode);
        Assert.True(controlElapsed.Elapsed < TimeSpan.FromSeconds(3));

        var agendaElapsed = Stopwatch.StartNew();
        using var stale = await functions.Poll();
        Assert.InRange(agendaElapsed.Elapsed.TotalSeconds, 5.8, 10);
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal("source_unavailable", stale.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(succeededAt, stale.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        using var rejected = await delayed;
        Assert.InRange(sourceElapsed.Elapsed.TotalSeconds, 6.8, 10);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, rejected.StatusCode);
        using var body = JsonDocument.Parse(await rejected.Content.ReadAsStringAsync());
        Assert.Equal("smoke_delayed", body.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Explicit_disable_removes_only_synthetic_control_state_and_never_reads_or_deletes_private_source()
    {
        using var source = new SyntheticHttp();
        using var privateAgenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"))
                .Replace("Ongoing planning", "CONFIDENTIAL_SYNTHETIC_PRIVATE_MARKER"),
            cacheDirectory: source.DirectoryPath);
        using var privateCurrent = await privateAgenda.Poll();
        Assert.Equal("current", privateCurrent.RootElement.GetProperty("state").GetString());
        using var opened = await source.SetMode("valid", DateTimeOffset.Parse("2026-10-19T19:30:00Z"));
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
        using var publicCalendar = await source.Client.GetAsync("/api/smoke-source");
        Assert.DoesNotContain("CONFIDENTIAL", await publicCalendar.Content.ReadAsStringAsync());

        using var disabled = await source.Control("""{"mode":"disabled"}""");
        Assert.Equal(HttpStatusCode.OK, disabled.StatusCode);
        using var result = JsonDocument.Parse(await disabled.Content.ReadAsStringAsync());
        Assert.Equal("smoke_disabled", result.RootElement.GetProperty("code").GetString());

        using var recreated = new SyntheticHttp("2026-10-19T18:10:00Z", source.DirectoryPath);
        using var stopped = await recreated.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, stopped.StatusCode);
        using var state = JsonDocument.Parse(await stopped.Content.ReadAsStringAsync());
        Assert.Equal("smoke_disabled", state.RootElement.GetProperty("code").GetString());
        using var repeated = await recreated.Control("""{"mode":"disabled"}""");
        Assert.Equal(HttpStatusCode.OK, repeated.StatusCode);

        privateAgenda.Clock.Advance(TimeSpan.FromMinutes(10));
        privateAgenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var retainedPrivate = await privateAgenda.Poll();
        Assert.Equal("stale", retainedPrivate.RootElement.GetProperty("state").GetString());
        Assert.Contains("CONFIDENTIAL_SYNTHETIC_PRIVATE_MARKER", retainedPrivate.RootElement.GetRawText());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            retainedPrivate.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());

        recreated.Clock.Advance(TimeSpan.FromHours(2));
        using var explicitlyReopened = await recreated.SetMode("valid", recreated.Clock.GetUtcNow().AddMinutes(15));
        Assert.Equal(HttpStatusCode.OK, explicitlyReopened.StatusCode);
    }

    [Theory]
    [InlineData("/api/smoke-source-control?source_url=https://caller.invalid/CONFIDENTIAL", "application/json")]
    [InlineData("/api/smoke-source-control", "text/plain")]
    public async Task Control_accepts_configuration_only_in_a_JSON_body_without_query_parameters(
        string path, string contentType)
    {
        using var source = new SyntheticHttp();
        using var response = await source.Client.PostAsync(path,
            new StringContent("""{"mode":"valid","expires_at":"2026-10-19T19:30:00Z"}""", Encoding.UTF8, contentType));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain("CONFIDENTIAL", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData(1024, HttpStatusCode.OK)]
    [InlineData(1025, HttpStatusCode.BadRequest)]
    public async Task Control_body_has_an_inclusive_1024_UTF8_byte_limit(int bytes, HttpStatusCode status)
    {
        using var source = new SyntheticHttp();
        using var response = await source.Control(
            """{"mode":"valid","expires_at":"2026-10-19T19:30:00Z"}""".PadRight(bytes));

        Assert.Equal(status, response.StatusCode);
    }

    [Fact]
    public async Task Anonymous_source_does_not_accept_or_reflect_caller_URL_calendar_or_path_inputs()
    {
        using var source = new SyntheticHttp();
        using var configured = await source.SetMode("valid", DateTimeOffset.Parse("2026-10-19T19:30:00Z"));
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        using var response = await source.Client.GetAsync(
            "/api/smoke-source?url=https://caller.invalid/CONFIDENTIAL&path=last-good-source.json&calendar=CONFIDENTIAL");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.DoesNotContain("CONFIDENTIAL", await response.Content.ReadAsStringAsync());
        using var fixedCalendar = await source.Client.GetAsync("/api/smoke-source");
        Assert.Equal(HttpStatusCode.OK, fixedCalendar.StatusCode);
        Assert.Contains("SUMMARY:Synthetic smoke primary all-day", await fixedCalendar.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("CONFIDENTIAL_INVALID_STATE")]
    [InlineData("""{"version":1,"mode":"valid","opened_at":"2026-10-19T18:00:00Z","expires_at":"2026-10-19T19:30:00Z","calendar":"CONFIDENTIAL"}""")]
    [InlineData("""{"version":1,"mode":"valid","mode":"valid","opened_at":"2026-10-19T18:00:00Z","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"version":1,"mode":"\uD800","opened_at":"2026-10-19T18:00:00Z","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"version":1,"mode":"valid","opened_at":"2026-10-19T19:00:00Z","expires_at":"2026-10-19T19:30:00Z"}""")]
    [InlineData("""{"version":1,"mode":"valid","opened_at":"2026-10-19T18:00:00Z","expires_at":"2026-10-19T19:30:00.0000001Z"}""")]
    [InlineData("""{"version":1,"mode":"valid","opened_at":"2026-10-19T18:00:00Z","expires_at":"2026-10-19T18:00:00Z"}""")]
    public async Task Corrupted_or_unsafe_mode_state_fails_closed_with_fixed_diagnostics_and_is_still_removable(
        string state)
    {
        var diagnostics = new CapturedDiagnostics();
        using var source = new SyntheticHttp(logger: diagnostics);
        Directory.CreateDirectory(source.DirectoryPath);
        await File.WriteAllTextAsync(Path.Combine(source.DirectoryPath, "temporary-smoke-source-mode.json"), state);
        using var response = await source.Client.GetAsync("/api/smoke-source");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        using var error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("smoke_state_invalid", error.RootElement.GetProperty("code").GetString());
        Assert.Equal("Temporary smoke source failed with code smoke_state_invalid.", Assert.Single(diagnostics.Messages));
        Assert.Empty(diagnostics.Exceptions);
        Assert.DoesNotContain("CONFIDENTIAL", error.RootElement.GetRawText());
        using var cleanup = await source.Control("""{"mode":"disabled"}""");
        Assert.Equal(HttpStatusCode.OK, cleanup.StatusCode);
        using var disabled = await source.Client.GetAsync("/api/smoke-source");
        using var result = JsonDocument.Parse(await disabled.Content.ReadAsStringAsync());
        Assert.Equal("smoke_disabled", result.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Concurrent_controls_across_handlers_cannot_undo_a_successfully_shortened_window()
    {
        using var first = new SyntheticHttp();
        using var second = new SyntheticHttp(directory: first.DirectoryPath);
        using var initial = await first.SetMode("valid", DateTimeOffset.Parse("2026-10-19T19:30:00Z"));
        Assert.Equal(HttpStatusCode.OK, initial.StatusCode);
        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(index =>
            (index % 2 == 0 ? first : second).SetMode("valid",
                DateTimeOffset.Parse(index % 3 == 0 ? "2026-10-19T19:00:00Z" : "2026-10-19T19:15:00Z"))));
        try
        {
            var acceptedExpiries = new List<DateTimeOffset>();
            foreach (var response in responses)
            {
                using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                if (response.StatusCode == HttpStatusCode.OK)
                    acceptedExpiries.Add(result.RootElement.GetProperty("expires_at").GetDateTimeOffset());
                else
                {
                    Assert.Contains(response.StatusCode, new[] { HttpStatusCode.Conflict, HttpStatusCode.ServiceUnavailable });
                    Assert.Contains(result.RootElement.GetProperty("code").GetString(),
                        new[] { "smoke_conflict", "smoke_storage_unavailable", "smoke_window_extension" });
                }
            }
            Assert.NotEmpty(acceptedExpiries);
            first.Clock.SetUtcNow(acceptedExpiries.Min());
            using var expired = await first.Client.GetAsync("/api/smoke-source");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, expired.StatusCode);
            using var state = JsonDocument.Parse(await expired.Content.ReadAsStringAsync());
            Assert.Equal("smoke_expired", state.RootElement.GetProperty("code").GetString());
        }
        finally
        {
            foreach (var response in responses)
                response.Dispose();
        }
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("http://127.0.0.1/", "source-cache")]
    [InlineData("https://storage.example.invalid/?sig=CONFIDENTIAL", "source-cache")]
    [InlineData("https://CONFIDENTIAL@storage.example.invalid/", "source-cache")]
    [InlineData("https://storage.example.invalid/CONFIDENTIAL", "source-cache")]
    [InlineData("https://storage.example.invalid/", "Invalid_Container")]
    public async Task Production_never_uses_development_storage_or_reports_private_storage_configuration(
        string? serviceUri, string? container)
    {
        var diagnostics = new CapturedDiagnostics();
        using var source = new SyntheticHttp(runtimeSettings: new Dictionary<string, string?>
        {
            ["AZURE_FUNCTIONS_ENVIRONMENT"] = "Production",
            ["Agenda:CacheServiceUri"] = serviceUri,
            ["Agenda:CacheContainer"] = container,
            ["Agenda:SourceUrl"] = "https://private-source.invalid/CONFIDENTIAL"
        }, logger: diagnostics);
        using var get = await source.Client.GetAsync("/api/smoke-source");
        using var configure = await source.SetMode("valid", DateTimeOffset.Parse("2026-10-19T19:30:00Z"));
        using var cleanup = await source.Control("""{"mode":"disabled"}""");
        foreach (var response in new[] { get, configure, cleanup })
        {
            Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
            using var result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Equal("smoke_storage_configuration", result.RootElement.GetProperty("code").GetString());
            Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
            Assert.DoesNotContain("storage.example", result.RootElement.GetRawText());
        }
        Assert.Equal(3, diagnostics.Messages.Count);
        Assert.All(diagnostics.Messages, message =>
            Assert.Equal("Temporary smoke source failed with code smoke_storage_configuration.", message));
        Assert.Empty(diagnostics.Exceptions);
    }

    [Theory]
    [InlineData("2026-10-19T18:00:00Z", "2026-10-19", "2026-10-20", "2026-10-20T06:00:00Z", "2026-10-20T16:00:00Z")]
    [InlineData("2026-10-23T18:00:00Z", "2026-10-23", "2026-10-26", "2026-10-24T06:00:00Z", "2026-10-26T16:00:00Z")]
    [InlineData("2026-10-24T18:00:00Z", "2026-10-26", "2026-10-27", "2026-10-27T06:00:00Z", "2026-10-27T16:00:00Z")]
    [InlineData("2026-10-24T06:00:00Z", "2026-10-23", "2026-10-26", "2026-10-24T06:00:00Z", "2026-10-26T16:00:00Z")]
    [InlineData("2026-11-02T16:00:00Z", "2026-11-02", "2026-11-03", "2026-11-03T07:00:00Z", "2026-11-03T17:00:00Z")]
    public async Task Fixed_synthetic_appointments_follow_current_Los_Angeles_working_dates_and_DST(
        string now, string primary, string secondary, string primaryStart, string secondaryStart)
    {
        using var source = new SyntheticHttp(now);
        using var configured = await source.SetMode("valid", source.Clock.GetUtcNow().AddMinutes(15));
        Assert.Equal(HttpStatusCode.OK, configured.StatusCode);
        using var response = await source.Poll();
        var agenda = response.RootElement;

        Assert.Equal("current", agenda.GetProperty("state").GetString());
        Assert.Equal(primary, agenda.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal(secondary, agenda.GetProperty("secondary").GetProperty("date").GetString());
        var primaryOccurrences = agenda.GetProperty("primary").GetProperty("occurrences").EnumerateArray().ToArray();
        Assert.Equal("Synthetic smoke primary all-day", primaryOccurrences[0].GetProperty("title").GetString());
        Assert.Equal("all_day", primaryOccurrences[0].GetProperty("time_kind").GetString());
        Assert.Equal(DateTimeOffset.Parse(primaryStart), primaryOccurrences[1].GetProperty("start_at").GetDateTimeOffset());
        var second = Assert.Single(agenda.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(DateTimeOffset.Parse(secondaryStart), second.GetProperty("start_at").GetDateTimeOffset());
    }

    private sealed class CapturedDiagnostics : ILogger<TemporarySmokeSource>
    {
        public ConcurrentQueue<string> Messages { get; } = new();
        public ConcurrentQueue<Exception> Exceptions { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            Messages.Enqueue(formatter(state, exception));
            if (exception is not null)
                Exceptions.Enqueue(exception);
        }
    }

    private sealed class SyntheticHttp : IDisposable
    {
        private readonly IHost host;
        private readonly bool ownsDirectory;
        public string DirectoryPath { get; }
        public FakeTimeProvider Clock { get; }
        public HttpClient Client { get; }

        public SyntheticHttp(string now = "2026-10-19T18:00:00Z", string? directory = null,
            IReadOnlyDictionary<string, string?>? runtimeSettings = null,
            ILogger<TemporarySmokeSource>? logger = null)
        {
            ownsDirectory = directory is null;
            DirectoryPath = directory ?? Path.Combine(DisplayTests.Root, "artifacts", "temporary-smoke-tests",
                Guid.NewGuid().ToString("N"));
            Clock = new FakeTimeProvider(DateTimeOffset.Parse(now));
            var values = new Dictionary<string, string?>
            {
                ["AZURE_FUNCTIONS_ENVIRONMENT"] = "Development",
                ["Agenda:DevelopmentCacheDirectory"] = DirectoryPath,
                ["Agenda:SourceUrl"] = "http://localhost/api/smoke-source"
            };
            if (runtimeSettings is not null)
                foreach (var (key, value) in runtimeSettings)
                    values[key] = value;
            var settings = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
            var function = new TemporarySmokeSource(settings, Clock, logger ?? NullLogger<TemporarySmokeSource>.Instance);
            AgendaFunction? agenda = null;
            host = new HostBuilder().ConfigureWebHost(web => web.UseTestServer()
                .ConfigureServices(services =>
                {
                    services.AddRouting();
                    services.AddMvcCore();
                })
                .Configure(app => app.UseRouting().UseEndpoints(endpoints =>
                {
                    endpoints.MapGet("/api/smoke-source", async context =>
                        await Execute(await function.Get(context.Request), context));
                    endpoints.MapPost("/api/smoke-source-control", async context =>
                        await Execute(await function.Control(context.Request), context));
                    endpoints.MapPost("/api/agenda", async context =>
                        await Execute(await agenda!.Run(context.Request), context));
                }))).Start();
            Client = host.GetTestClient();
            agenda = new AgendaFunction(Client, settings, Clock, NullLogger<AgendaFunction>.Instance);
        }

        public Task<HttpResponseMessage> Control(string body) =>
            Client.PostAsync("/api/smoke-source-control", new StringContent(body, Encoding.UTF8, "application/json"));

        public Task<HttpResponseMessage> SetMode(string mode, DateTimeOffset expires) =>
            Control(JsonSerializer.Serialize(new { mode, expires_at = expires }));

        public async Task<JsonDocument> Poll()
        {
            using var response = await Client.PostAsync("/api/agenda",
                new StringContent("""{"rules_json":"[]"}""", Encoding.UTF8, "application/json"));
            response.EnsureSuccessStatusCode();
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        }

        private static Task Execute(IActionResult result, Microsoft.AspNetCore.Http.HttpContext context) =>
            result.ExecuteResultAsync(new ActionContext(context, new RouteData(), new ActionDescriptor()));

        public void Dispose()
        {
            Client.Dispose();
            host.Dispose();
            if (ownsDirectory && Directory.Exists(DirectoryPath))
                Directory.Delete(DirectoryPath, recursive: true);
        }
    }

    private sealed class LocalFunctions : IAsyncDisposable
    {
        private readonly Process process;
        private readonly Task<string> stdout;
        private readonly Task<string> stderr;
        private readonly string directory;
        public HttpClient Client { get; }

        private LocalFunctions()
        {
            using var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            directory = Path.Combine(DisplayTests.Root, "artifacts", "temporary-smoke-tests",
                Guid.NewGuid().ToString("N"));
            var start = new ProcessStartInfo(OperatingSystem.IsWindows() ? "pwsh" : "func")
            {
                WorkingDirectory = Path.Combine(DisplayTests.Root, "src", "CalendarAgenda", "bin",
                    new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name, "net10.0"),
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            if (OperatingSystem.IsWindows())
            {
                foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-Command",
                    $"func start --no-build --port {port}" })
                    start.ArgumentList.Add(argument);
            }
            else
            {
                foreach (var argument in new[] { "start", "--no-build", "--port", port.ToString() })
                    start.ArgumentList.Add(argument);
            }
            start.Environment["FUNCTIONS_WORKER_RUNTIME"] = "dotnet-isolated";
            start.Environment["AZURE_FUNCTIONS_ENVIRONMENT"] = "Development";
            start.Environment["Agenda__DevelopmentCacheDirectory"] = directory;
            start.Environment["Agenda__SourceUrl"] = $"http://127.0.0.1:{port}/api/smoke-source";
            start.Environment["Agenda__CacheServiceUri"] = "";
            start.Environment["Agenda__CacheContainer"] = "";
            start.Environment["AzureWebJobsSecretStorageType"] = "files";
            start.Environment["AzureWebJobsStorage"] = "";
            start.Environment.Remove("APPLICATIONINSIGHTS_CONNECTION_STRING");
            start.Environment.Remove("APPINSIGHTS_INSTRUMENTATIONKEY");
            process = Process.Start(start) ?? throw new InvalidOperationException("Local Functions did not start.");
            stdout = process.StandardOutput.ReadToEndAsync();
            stderr = process.StandardError.ReadToEndAsync();
            Client = new HttpClient
            {
                BaseAddress = new Uri($"http://127.0.0.1:{port}"),
                Timeout = TimeSpan.FromSeconds(15)
            };
        }

        public static async Task<LocalFunctions> Start()
        {
            var functions = new LocalFunctions();
            try
            {
                var deadline = Stopwatch.StartNew();
                while (deadline.Elapsed < TimeSpan.FromSeconds(60))
                {
                    if (functions.process.HasExited)
                        throw new InvalidOperationException("Local Functions exited before becoming ready.");
                    try
                    {
                        using var response = await functions.Client.GetAsync("/admin/functions");
                        if (response.IsSuccessStatusCode)
                        {
                            using var definitions = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                            if (definitions.RootElement.EnumerateArray()
                                .Any(function => function.GetProperty("name").GetString() == "Agenda"))
                                return functions;
                        }
                    }
                    catch (HttpRequestException) { }
                    catch (TaskCanceledException) { }
                    await Task.Delay(250);
                }
                throw new TimeoutException("Local Functions was not ready within sixty seconds.");
            }
            catch
            {
                await functions.DisposeAsync();
                throw;
            }
        }

        public async Task<HttpResponseMessage> SetMode(string mode, DateTimeOffset expires)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/smoke-source-control")
            {
                Content = new StringContent(JsonSerializer.Serialize(new { mode, expires_at = expires }),
                    Encoding.UTF8, "application/json")
            };
            request.Headers.Add("x-functions-key", "CONFIDENTIAL_SMOKE_CONTROL_KEY");
            return await Client.SendAsync(request);
        }

        public async Task<JsonDocument> Poll()
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/agenda")
            {
                Content = new StringContent("""{"rules_json":"[]"}""", Encoding.UTF8, "application/json")
            };
            request.Headers.Add("x-functions-key", "CONFIDENTIAL_AGENDA_KEY");
            using var response = await Client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            var diagnostics = $"{await stdout}\n{await stderr}";
            process.Dispose();
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
            Assert.DoesNotContain("CONFIDENTIAL", diagnostics);
        }
    }
}
