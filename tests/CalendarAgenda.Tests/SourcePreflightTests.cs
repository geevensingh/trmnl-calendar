using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class SourcePreflightTests
{
    private const string Sentinel = "CONFIDENTIAL_PREFLIGHT_SENTINEL";

    [Fact]
    public async Task Source_access_requires_explicit_authorization_before_reading_protected_input()
    {
        var result = await RunRaw(null, "--synthetic-local");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        Assert.Equal("source_access_not_authorized", report.RootElement.GetProperty("error").GetString());
        Assert.False(report.RootElement.GetProperty("checks_passed").GetBoolean());
        Assert.Empty(report.RootElement.GetProperty("attempts").EnumerateArray());
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Fact]
    public async Task Exact_protected_input_crosses_the_production_source_and_installed_interpretation_path()
    {
        var calendar = Calendar(
            "DTSTART;TZID=British Columbia Standard Time:20261102T090000\nDURATION:PT1H\n"
            + $"SUMMARY:{Sentinel}\nLOCATION:{Sentinel}");
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(calendar);
        });

        var result = await Run(new { source = source.Url, reference = source.Url },
            "--authorize-source-access", "--synthetic-local", "--compare-reference");

        Assert.Equal(0, result.ExitCode);
        Assert.Empty(result.Errors);
        using var report = JsonDocument.Parse(result.Output);
        var body = report.RootElement;
        Assert.True(body.GetProperty("checks_passed").GetBoolean());
        Assert.False(body.GetProperty("activation_complete").GetBoolean());
        Assert.False(body.GetProperty("delivery_design_approved").GetBoolean());
        Assert.Equal("local_synthetic", body.GetProperty("evidence_scope").GetString());
        Assert.Equal("not_verified", body.GetProperty("measurement_scope")
            .GetProperty("participation_semantics").GetString());
        Assert.True(body.GetProperty("comparison").GetProperty("exact_equal").GetBoolean());
        var attempt = Assert.Single(body.GetProperty("attempts").EnumerateArray());
        Assert.Equal("received", attempt.GetProperty("acquisition").GetProperty("code").GetString());
        Assert.Equal(200, attempt.GetProperty("acquisition").GetProperty("http_status").GetInt32());
        Assert.True(attempt.GetProperty("acquisition").GetProperty("calendar_media_type").GetBoolean());
        Assert.Equal("supported", attempt.GetProperty("interpretation").GetProperty("code").GetString());
        Assert.InRange(attempt.GetProperty("interpretation").GetProperty("elapsed_ms").GetInt64(), 0, 34_999);
        Assert.Equal("not_performed", body.GetProperty("cache_only_poll").GetProperty("code").GetString());
        Assert.Equal(1, source.Requests);
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
        Assert.DoesNotContain("20261102", result.Output + result.Errors);
        Assert.DoesNotContain("British Columbia", result.Output + result.Errors);
        Assert.DoesNotContain(source.Url, result.Output + result.Errors);
    }

    [Fact]
    public async Task Participation_capability_report_contains_only_allowlisted_observations()
    {
        const string ownerAddress = "mailto:owner@example.invalid";
        var calendar = Calendar(
            "DTSTART:20261102T170000Z\nDTEND:20261102T180000Z\n"
            + "ORGANIZER:mailto:owner@example.invalid\n"
            + "ATTENDEE;PARTSTAT=ACCEPTED:mailto:owner@example.invalid\n"
            + "TRANSP:TRANSPARENT\n"
            + $"SUMMARY:Following: {Sentinel}");
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(calendar);
        });

        var result = await RunWithOwnerAddress(ownerAddress, new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        Assert.True(capabilities.GetProperty("owner_address_configured").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_organizer_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_attendee_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_participation_status_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("free_availability_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("followed_title_marker_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_response_usable_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_response_missing_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_response_unsupported_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_attendee_ambiguous_observed").GetBoolean());
        Assert.Equal(new[]
        {
            "owner_address_configured", "owner_organizer_observed", "owner_attendee_observed",
            "owner_participation_status_observed", "free_availability_observed", "followed_title_marker_observed",
            "owner_response_usable_observed", "owner_response_missing_observed",
            "owner_response_unsupported_observed", "owner_attendee_ambiguous_observed"
        }.Order(StringComparer.Ordinal), capabilities.EnumerateObject().Select(field => field.Name)
            .Order(StringComparer.Ordinal));
        Assert.All(capabilities.EnumerateObject(), field =>
            Assert.Contains(field.Value.ValueKind, new[] { JsonValueKind.True, JsonValueKind.False }));
        Assert.DoesNotContain(ownerAddress, result.Output + result.Errors);
        Assert.DoesNotContain("owner@example.invalid", result.Output + result.Errors);
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Fact]
    public async Task A_parser_default_response_is_not_reported_as_supplied_owner_response_evidence()
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                "DTSTART:20261102T170000Z\nDURATION:PT1H\n"
                + "ATTENDEE:mailto:owner@example.invalid\nSTATUS:CONFIRMED"));
        });

        var result = await RunWithOwnerAddress("mailto:owner@example.invalid", new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        Assert.True(capabilities.GetProperty("owner_attendee_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_participation_status_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_response_usable_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_response_missing_observed").GetBoolean());
    }

    [Theory]
    [InlineData("ACCEPTED", true)]
    [InlineData("DECLINED", true)]
    [InlineData("TENTATIVE", true)]
    [InlineData("NEEDS-ACTION", true)]
    [InlineData("accepted", true)]
    [InlineData("DELEGATED", false)]
    [InlineData("COMPLETED", false)]
    [InlineData("IN-PROCESS", false)]
    [InlineData("ACCEPTED,DECLINED", false)]
    [InlineData("ACCEPTED;PARTSTAT=DECLINED", false)]
    [InlineData(Sentinel, false)]
    public async Task Supplied_owner_responses_distinguish_usable_and_unsupported_evidence(
        string response, bool usable)
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                "DTSTART:20261102T170000Z\nDURATION:PT1H\n"
                + $"ATTENDEE;CN={Sentinel};PARTSTAT={response}:mailto:owner@example.invalid\n"
                + $"ATTENDEE;PARTSTAT=DECLINED:mailto:{Sentinel}@example.invalid\nSTATUS:CONFIRMED"));
        });

        var result = await RunWithOwnerAddress("mailto:owner@example.invalid", new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        Assert.True(capabilities.GetProperty("owner_attendee_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_participation_status_observed").GetBoolean());
        Assert.Equal(usable, capabilities.GetProperty("owner_response_usable_observed").GetBoolean());
        Assert.Equal(!usable, capabilities.GetProperty("owner_response_unsupported_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_response_missing_observed").GetBoolean());
        Assert.DoesNotContain("owner@example.invalid", result.Output + result.Errors);
        Assert.DoesNotContain("CONFIRMED", result.Output + result.Errors);
    }

    [Theory]
    [InlineData("DECLINED")]
    [InlineData("ACCEPTED")]
    public async Task Duplicate_owner_attendees_are_ambiguous_even_when_their_supplied_responses_agree(
        string secondResponse)
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                "DTSTART:20261102T170000Z\nDURATION:PT1H\n"
                + "ATTENDEE;PARTSTAT=ACCEPTED:mailto:owner@example.invalid\n"
                + $"ATTENDEE;CN={Sentinel};PARTSTAT={secondResponse}:mailto:OWNER@EXAMPLE.INVALID"));
        });

        var result = await RunWithOwnerAddress("mailto:owner@example.invalid", new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        Assert.True(capabilities.GetProperty("owner_attendee_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_participation_status_observed").GetBoolean());
        Assert.False(capabilities.GetProperty("owner_response_usable_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("owner_attendee_ambiguous_observed").GetBoolean());
        Assert.DoesNotContain("owner@example.invalid", result.Output + result.Errors);
        Assert.DoesNotContain("OWNER@EXAMPLE.INVALID", result.Output + result.Errors);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("mailto:invalid")]
    [InlineData("https://owner.example.invalid")]
    [InlineData("mailto:owner@example.invalid?subject=private")]
    [InlineData("mailto:owner@example.invalid#private")]
    [InlineData("mailto:owner@example.invalid,other@example.invalid")]
    [InlineData(" mailto:owner@example.invalid")]
    [InlineData("mailto:owner@example.invalid\r\n")]
    public async Task Missing_or_invalid_owner_configuration_cannot_establish_owner_evidence(string? ownerAddress)
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                "DTSTART:20261102T170000Z\nDURATION:PT1H\n"
                + "ORGANIZER:mailto:owner@example.invalid\n"
                + "ATTENDEE;PARTSTAT=ACCEPTED:mailto:owner@example.invalid\n"
                + $"TRANSP:TRANSPARENT\nSUMMARY:Following: {Sentinel}"));
        });

        var result = await RunWithOwnerAddress(ownerAddress, new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        foreach (var field in capabilities.EnumerateObject().Where(field => field.Name.StartsWith("owner_")))
            Assert.False(field.Value.GetBoolean(), field.Name);
        Assert.True(capabilities.GetProperty("free_availability_observed").GetBoolean());
        Assert.True(capabilities.GetProperty("followed_title_marker_observed").GetBoolean());
        Assert.DoesNotContain("owner@example.invalid", result.Output + result.Errors);
        Assert.DoesNotContain("private", result.Output + result.Errors);
    }

    [Theory]
    [InlineData("")]
    [InlineData("STATUS:CONFIRMED")]
    [InlineData("STATUS:TENTATIVE")]
    [InlineData("ATTENDEE;CN=owner@example.invalid;PARTSTAT=ACCEPTED:mailto:other@example.invalid")]
    [InlineData("ORGANIZER:mailto:other@example.invalid\nX-MICROSOFT-CDO-BUSYSTATUS:FREE")]
    public async Task Missing_owner_signals_are_not_inferred_from_event_status_names_or_other_attendees(
        string metadata)
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                $"DTSTART:20261102T170000Z\nDURATION:PT1H\nSUMMARY:{Sentinel}\n{metadata}"));
        });

        var result = await RunWithOwnerAddress("mailto:owner@example.invalid", new { source = source.Url },
            "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var capabilities = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray())
            .GetProperty("interpretation").GetProperty("participation_capabilities");
        Assert.True(capabilities.GetProperty("owner_address_configured").GetBoolean());
        foreach (var field in capabilities.EnumerateObject().Where(field => field.Name != "owner_address_configured"))
            Assert.False(field.Value.GetBoolean(), field.Name);
        Assert.DoesNotContain("owner@example.invalid", result.Output + result.Errors);
        Assert.DoesNotContain("other@example.invalid", result.Output + result.Errors);
    }

    [Theory]
    [InlineData("different_token", false, false)]
    [InlineData("whitespace", true, true)]
    [InlineData("representation", false, true)]
    [InlineData("quoted", false, null)]
    public async Task Protected_comparison_explains_mismatches_without_repairing_or_fetching_either_value(
        string difference, bool sameAfterTrimming, bool? sameUriRepresentation)
    {
        await using var source = await SyntheticSource.Start(context => context.Response.WriteAsync(Sentinel));
        var stored = difference switch
        {
            "different_token" => source.Url + "-different",
            "whitespace" => " " + source.Url + "\r\n",
            "representation" => source.Url.Replace("http:", "HTTP:", StringComparison.Ordinal),
            "quoted" => "\"" + source.Url + "\"",
            _ => throw new InvalidOperationException()
        };

        var result = await Run(new { source = stored, reference = source.Url },
            "--authorize-source-access", "--synthetic-local", "--compare-reference");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var body = report.RootElement;
        Assert.Equal("reference_mismatch", body.GetProperty("error").GetString());
        var comparison = body.GetProperty("comparison");
        Assert.False(comparison.GetProperty("exact_equal").GetBoolean());
        Assert.Equal(sameAfterTrimming, comparison.GetProperty("same_after_trimming").GetBoolean());
        Assert.Equal(sameUriRepresentation, comparison.GetProperty("same_uri_representation")
            .Deserialize<bool?>());
        var input = body.GetProperty("source_input");
        Assert.Equal(difference == "whitespace", input.GetProperty("leading_or_trailing_whitespace").GetBoolean());
        Assert.Equal(difference == "whitespace", input.GetProperty("contains_control_characters").GetBoolean());
        Assert.Equal(difference == "quoted", input.GetProperty("surrounding_quotes").GetBoolean());
        Assert.Empty(body.GetProperty("attempts").EnumerateArray());
        Assert.Equal(0, source.Requests);
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
        Assert.DoesNotContain(source.Url, result.Output + result.Errors);
    }

    [Theory]
    [InlineData("html", "received", "source_invalid")]
    [InlineData("malformed", "received", "source_invalid")]
    [InlineData("unsupported", "received", "compatibility_unsupported")]
    [InlineData("unknown_timezone", "received", "compatibility_unsupported")]
    [InlineData("redirected", "redirect_refused", "not_performed")]
    [InlineData("rejected", "http_rejected", "not_performed")]
    [InlineData("invalid_utf8", "invalid_utf8", "not_performed")]
    [InlineData("oversize", "source_too_large", "not_performed")]
    public async Task Failed_source_checks_preserve_phase_evidence_and_save_only_the_safe_report(
        string scenario, string acquisitionCode, string interpretationCode)
    {
        var calendar = Calendar(scenario == "unknown_timezone"
            ? $"DTSTART;TZID={Sentinel}:20261102T090000\nDURATION:PT1H\nSUMMARY:{Sentinel}"
            : $"DTSTART:20261102T160000Z\nDURATION:PT1H\nSUMMARY:{Sentinel}\n"
                + "RECURRENCE-ID;RANGE=THISANDFUTURE:20261102T160000Z");
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = scenario == "html" ? "text/html" : "text/calendar";
            if (scenario == "redirected")
            {
                context.Response.StatusCode = 302;
                context.Response.Headers.Location = "/redirect-target?key=" + Sentinel;
            }
            if (scenario == "rejected")
                context.Response.StatusCode = 403;
            if (scenario == "invalid_utf8")
                await context.Response.Body.WriteAsync(new byte[] { 0xff, 0xfe, 0xff });
            else
                await context.Response.WriteAsync(scenario switch
                {
                    "html" => $"<html><title>{Sentinel}</title></html>",
                    "malformed" => Sentinel,
                    "oversize" => new string('X', 2 * 1024 * 1024) + Sentinel,
                    _ => calendar
                }, context.RequestAborted);
        });
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-preflight", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "safe-report.json");
        try
        {
            var result = await Run(new { source = source.Url },
                "--authorize-source-access", "--synthetic-local", "--report-file", file);

            Assert.Equal(1, result.ExitCode);
            Assert.Empty(result.Errors);
            var saved = await File.ReadAllTextAsync(file);
            Assert.Equal(result.Output, saved);
            using var report = JsonDocument.Parse(saved);
            var body = report.RootElement;
            Assert.False(body.GetProperty("checks_passed").GetBoolean());
            Assert.Equal("not_performed", body.GetProperty("cache_only_poll").GetProperty("code").GetString());
            var attempt = Assert.Single(body.GetProperty("attempts").EnumerateArray());
            var acquisition = attempt.GetProperty("acquisition");
            var interpretation = attempt.GetProperty("interpretation");
            Assert.Equal(acquisitionCode, acquisition.GetProperty("code").GetString());
            Assert.Equal(interpretationCode, interpretation.GetProperty("code").GetString());
            Assert.Equal(interpretationCode != "not_performed", interpretation.GetProperty("performed").GetBoolean());
            Assert.Equal(JsonValueKind.Null, interpretation.GetProperty("participation_capabilities").ValueKind);
            Assert.InRange(acquisition.GetProperty("headers_ms").GetInt64(), 0, 29_999);
            Assert.Equal(scenario == "html", acquisition.GetProperty("html_media_type").GetBoolean());
            if (scenario is "redirected" or "rejected")
            {
                Assert.Equal(JsonValueKind.Null, acquisition.GetProperty("body_ms").ValueKind);
                Assert.Equal(JsonValueKind.Null, acquisition.GetProperty("utf8_bytes").ValueKind);
            }
            Assert.Equal(1, source.Requests);
            Assert.DoesNotContain(Sentinel, result.Output + result.Errors + saved);
            Assert.DoesNotContain("BEGIN:VCALENDAR", saved);
            Assert.DoesNotContain("20261102", saved);
            Assert.DoesNotContain(source.Url, saved);
            Assert.Single(Directory.GetFiles(directory));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task An_explicit_second_attempt_or_later_warm_command_cannot_replace_the_original_failure()
    {
        var requests = 0;
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            context.Response.StatusCode = Interlocked.Increment(ref requests) == 1 ? 403 : 200;
            await context.Response.WriteAsync(Calendar(
                $"DTSTART;VALUE=DATE:20261102\nDURATION:P1D\nSUMMARY:{Sentinel}"));
        });
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-preflight", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var file = Path.Combine(directory, "first-report.json");
        try
        {
            var result = await Run(new { source = source.Url }, "--authorize-source-access",
                "--synthetic-local", "--attempts", "2", "--report-file", file);

            Assert.Equal(1, result.ExitCode);
            using var report = JsonDocument.Parse(result.Output);
            var body = report.RootElement;
            Assert.False(body.GetProperty("checks_passed").GetBoolean());
            Assert.Equal("http_rejected", body.GetProperty("error").GetString());
            var attempts = body.GetProperty("attempts").EnumerateArray().ToArray();
            Assert.Equal(2, attempts.Length);
            Assert.Equal(1, attempts[0].GetProperty("number").GetInt32());
            Assert.Equal("http_rejected", attempts[0].GetProperty("acquisition").GetProperty("code").GetString());
            Assert.Equal(403, attempts[0].GetProperty("acquisition").GetProperty("http_status").GetInt32());
            Assert.Equal("not_performed", attempts[0].GetProperty("interpretation").GetProperty("code").GetString());
            Assert.Equal(2, attempts[1].GetProperty("number").GetInt32());
            Assert.Equal("supported", attempts[1].GetProperty("interpretation").GetProperty("code").GetString());
            Assert.Equal(result.Output, await File.ReadAllTextAsync(file));
            Assert.Equal(2, source.Requests);

            var warm = await Run(new { source = source.Url }, "--authorize-source-access",
                "--synthetic-local", "--report-file", file);

            Assert.Equal(1, warm.ExitCode);
            using var warmReport = JsonDocument.Parse(warm.Output);
            Assert.Equal("report_write_failed", warmReport.RootElement.GetProperty("error").GetString());
            Assert.Equal(result.Output, await File.ReadAllTextAsync(file));
            Assert.DoesNotContain(Sentinel, result.Output + result.Errors + warm.Output + warm.Errors);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(11_000, false)]
    public async Task Source_budgets_distinguish_proposed_synchronous_polling_from_approved_background_refresh(
        int headerDelayMs, bool fitsSynchronous)
    {
        await using var source = await SyntheticSource.Start(async context =>
        {
            await Task.Delay(headerDelayMs, context.RequestAborted);
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(Calendar(
                $"DTSTART;VALUE=DATE:20261102\nDURATION:P1D\nSUMMARY:{Sentinel}"));
        });

        var result = await Run(new { source = source.Url }, "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var body = report.RootElement;
        Assert.True(body.GetProperty("checks_passed").GetBoolean());
        var synchronous = body.GetProperty("synchronous_polling");
        Assert.Equal(9_000, synchronous.GetProperty("acquisition_budget_ms").GetInt64());
        Assert.Equal(9_000, synchronous.GetProperty("overall_budget_ms").GetInt64());
        Assert.Equal(fitsSynchronous, synchronous.GetProperty("fits_observed_budget").GetBoolean());
        Assert.Equal(fitsSynchronous ? "within_observed_budget" : "exceeds_observed_budget",
            synchronous.GetProperty("code").GetString());
        var background = body.GetProperty("scheduled_refresh");
        Assert.Equal(30_000, background.GetProperty("acquisition_budget_ms").GetInt64());
        Assert.Equal(35_000, background.GetProperty("overall_budget_ms").GetInt64());
        Assert.True(background.GetProperty("fits_observed_budget").GetBoolean());
        Assert.Equal("within_observed_budget", background.GetProperty("code").GetString());
        Assert.Equal(1, background.GetProperty("attempt_number").GetInt32());
        var attempt = Assert.Single(body.GetProperty("attempts").EnumerateArray());
        Assert.InRange(attempt.GetProperty("acquisition").GetProperty("headers_ms").GetInt64(),
            Math.Max(0, headerDelayMs - 100), 29_999);
        var scope = body.GetProperty("measurement_scope");
        foreach (var check in new[]
        {
            "azure_cold_start", "host_authentication", "managed_identity_access",
            "refresh_persistence", "native_trmnl_polling", "physical_device_delivery"
        })
            Assert.Equal("not_performed", scope.GetProperty(check).GetString());
        Assert.Equal("not_measured", scope.GetProperty("process_initialization").GetString());
        Assert.False(body.GetProperty("delivery_design_approved").GetBoolean());
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Existing_smoke_assesses_cache_only_polling_independently_without_rescuing_a_source_failure(
        bool rejectSource)
    {
        var reject = false;
        var calendar = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"))
            .Replace("Design review", Sentinel, StringComparison.Ordinal);
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.StatusCode = reject ? 403 : 200;
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(calendar);
        });
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient());
        await agenda.Tick();
        reject = rejectSource;
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var boundary = builder.Build();
        const string key = Sentinel + "_FUNCTION_KEY";
        var receivedKeys = new List<string?>();
        boundary.MapPost("/api/agenda", async context =>
        {
            var supplied = context.Request.Headers["x-functions-key"].ToString();
            receivedKeys.Add(supplied);
            if (supplied != key)
            {
                context.Response.StatusCode = 401;
                return;
            }
            using var reader = new StreamReader(context.Request.Body);
            using var response = await agenda.PollOnly(await reader.ReadToEndAsync());
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(response.RootElement.GetRawText());
        });
        await boundary.StartAsync();
        try
        {
            var result = await Run(new { source = source.Url, function_key = key },
                "--authorize-source-access", "--synthetic-local",
                "--agenda-endpoint", boundary.Urls.Single() + "/api/agenda");

            Assert.Equal(rejectSource ? 1 : 0, result.ExitCode);
            Assert.Empty(result.Errors);
            using var report = JsonDocument.Parse(result.Output);
            var body = report.RootElement;
            Assert.Equal(!rejectSource, body.GetProperty("checks_passed").GetBoolean());
            Assert.Equal(rejectSource ? "http_rejected" : null, body.GetProperty("error").GetString());
            var poll = body.GetProperty("cache_only_poll");
            Assert.True(poll.GetProperty("performed").GetBoolean());
            Assert.True(poll.GetProperty("checks_passed").GetBoolean());
            Assert.True(poll.GetProperty("authentication_enforced").GetBoolean());
            Assert.True(poll.GetProperty("measured_before_probes").GetBoolean());
            Assert.False(poll.GetProperty("cold_start_confirmed").GetBoolean());
            Assert.Equal("local_synthetic", poll.GetProperty("evidence_scope").GetString());
            Assert.Equal("current", poll.GetProperty("state").GetString());
            Assert.InRange(poll.GetProperty("combined_polling_utf8_bytes").GetInt64(), 1, 99_999);
            var attempt = Assert.Single(poll.GetProperty("attempts").EnumerateArray());
            Assert.Equal(200, attempt.GetProperty("http_status").GetInt32());
            Assert.InRange(attempt.GetProperty("elapsed_ms").GetInt64(), 0, 9_999);
            Assert.Equal(3, receivedKeys.Count);
            Assert.Equal(key, receivedKeys[0]);
            Assert.Equal("", receivedKeys[1]);
            Assert.StartsWith("wrong-", receivedKeys[2]);
            Assert.Equal(2, source.Requests);
            Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
            Assert.DoesNotContain("2026-10-19", result.Output + result.Errors);
            Assert.DoesNotContain("occurrences", result.Output + result.Errors);
        }
        finally
        {
            await boundary.StopAsync();
        }
    }

    [Theory]
    [InlineData("invalid")]
    [InlineData("whitespace")]
    [InlineData("credentials")]
    [InlineData("fragment")]
    [InlineData("nonlocal")]
    [InlineData("webcal")]
    public async Task Invalid_or_nonlocal_synthetic_input_is_reported_without_any_source_request(string scenario)
    {
        await using var source = await SyntheticSource.Start(context => context.Response.WriteAsync(Sentinel));
        var value = scenario switch
        {
            "invalid" => Sentinel,
            "whitespace" => source.Url + "\r\n",
            "credentials" => source.Url.Replace("http://", "http://" + Sentinel + "@", StringComparison.Ordinal),
            "fragment" => source.Url + "#" + Sentinel,
            "nonlocal" => "https://" + Sentinel + ".invalid/calendar.ics",
            "webcal" => source.Url.Replace("http:", "webcal:", StringComparison.Ordinal),
            _ => throw new InvalidOperationException()
        };

        var result = await Run(new { source = value }, "--authorize-source-access", "--synthetic-local");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var body = report.RootElement;
        Assert.Equal("invalid_input", body.GetProperty("error").GetString());
        Assert.False(body.GetProperty("source_input").GetProperty("valid").GetBoolean());
        Assert.False(body.GetProperty("comparison").GetProperty("performed").GetBoolean());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("comparison").GetProperty("exact_equal").ValueKind);
        Assert.Equal("not_performed", body.GetProperty("scheduled_refresh").GetProperty("code").GetString());
        Assert.Empty(body.GetProperty("attempts").EnumerateArray());
        Assert.Equal(0, source.Requests);
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Fact]
    public async Task Live_mode_refuses_redirected_secret_input_instead_of_accepting_a_shell_pipeline()
    {
        var result = await Run(new { source = Sentinel }, "--authorize-source-access");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        Assert.Equal("protected_terminal_required", report.RootElement.GetProperty("error").GetString());
        Assert.Empty(report.RootElement.GetProperty("attempts").EnumerateArray());
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Fact]
    public async Task A_transport_failure_retains_header_timing_but_does_not_invent_HTTP_or_interpretation_results()
    {
        var source = await SyntheticSource.Start(context => context.Response.WriteAsync(Sentinel));
        var url = source.Url;
        await source.DisposeAsync();

        var result = await Run(new { source = url }, "--authorize-source-access", "--synthetic-local");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var attempt = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray());
        var acquisition = attempt.GetProperty("acquisition");
        Assert.Equal("transport_failed", acquisition.GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, acquisition.GetProperty("http_status").ValueKind);
        Assert.Equal(JsonValueKind.Null, acquisition.GetProperty("body_ms").ValueKind);
        Assert.InRange(acquisition.GetProperty("headers_ms").GetInt64(), 0, 29_999);
        Assert.False(attempt.GetProperty("interpretation").GetProperty("performed").GetBoolean());
        Assert.Equal(JsonValueKind.Null, report.RootElement.GetProperty("scheduled_refresh")
            .GetProperty("fits_observed_budget").ValueKind);
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
        Assert.DoesNotContain(url, result.Output + result.Errors);
    }

    [Fact]
    public async Task Header_and_body_deadlines_keep_the_first_failed_attempt_even_after_a_supported_second_attempt()
    {
        await Task.WhenAll(Check(bodyDelay: false), Check(bodyDelay: true));

        static async Task Check(bool bodyDelay)
        {
            var requests = 0;
            await using var source = await SyntheticSource.Start(async context =>
            {
                context.Response.ContentType = "text/calendar";
                if (Interlocked.Increment(ref requests) == 1)
                {
                    if (bodyDelay)
                    {
                        await context.Response.StartAsync(context.RequestAborted);
                        await context.Response.WriteAsync(Sentinel, context.RequestAborted);
                        await context.Response.Body.FlushAsync(context.RequestAborted);
                    }
                    await Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted);
                }
                await context.Response.WriteAsync(Calendar(
                    $"DTSTART;VALUE=DATE:20261102\nDURATION:P1D\nSUMMARY:{Sentinel}"), context.RequestAborted);
            });

            var result = await Run(new { source = source.Url }, "--authorize-source-access",
                "--synthetic-local", "--attempts", "2");

            Assert.Equal(1, result.ExitCode);
            Assert.Empty(result.Errors);
            using var report = JsonDocument.Parse(result.Output);
            var body = report.RootElement;
            var expected = bodyDelay ? "body_timeout" : "headers_timeout";
            Assert.Equal(expected, body.GetProperty("error").GetString());
            var attempts = body.GetProperty("attempts").EnumerateArray().ToArray();
            Assert.Equal(2, attempts.Length);
            var first = attempts[0].GetProperty("acquisition");
            Assert.Equal(expected, first.GetProperty("code").GetString());
            Assert.Equal(bodyDelay ? 200 : (int?)null, first.GetProperty("http_status").Deserialize<int?>());
            Assert.InRange(first.GetProperty(bodyDelay ? "body_ms" : "headers_ms").GetInt64(), 29_000, 35_500);
            Assert.InRange(attempts[0].GetProperty("elapsed_ms").GetInt64(), 29_000, 35_500);
            Assert.Equal("not_performed", attempts[0].GetProperty("interpretation").GetProperty("code").GetString());
            Assert.Equal("supported", attempts[1].GetProperty("interpretation").GetProperty("code").GetString());
            foreach (var design in new[] { "synchronous_polling", "scheduled_refresh" })
            {
                Assert.Equal("not_assessable", body.GetProperty(design).GetProperty("code").GetString());
                Assert.Equal(JsonValueKind.Null, body.GetProperty(design).GetProperty("fits_observed_budget").ValueKind);
            }
            Assert.Equal(2, source.Requests);
            Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
        }
    }

    [Theory]
    [InlineData("basic.ics")]
    [InlineData("recurring.ics")]
    [InlineData("recurring-all-day.ics")]
    [InlineData("all-day.ics")]
    [InlineData("moved-occurrences.ics")]
    [InlineData("cancelled-overrides.ics")]
    [InlineData("outlook-dst.ics")]
    public async Task Maintained_production_calendar_behavior_is_used_even_without_a_calendar_media_type(string fixture)
    {
        var calendar = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", fixture))
            .Replace("SUMMARY:", "SUMMARY:" + Sentinel, StringComparison.Ordinal);
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "application/octet-stream";
            await context.Response.WriteAsync(calendar);
        });

        var result = await Run(new { source = source.Url }, "--authorize-source-access", "--synthetic-local");

        Assert.Equal(0, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        var attempt = Assert.Single(report.RootElement.GetProperty("attempts").EnumerateArray());
        Assert.Equal("supported", attempt.GetProperty("interpretation").GetProperty("code").GetString());
        Assert.False(attempt.GetProperty("acquisition").GetProperty("calendar_media_type").GetBoolean());
        Assert.DoesNotContain(Sentinel, result.Output + result.Errors);
    }

    [Theory]
    [InlineData("calendar_error")]
    [InlineData("timeout")]
    [InlineData("http_rejected")]
    [InlineData("transport_failed")]
    public async Task A_failed_first_cache_poll_retains_smoke_evidence_without_becoming_source_or_delivery_success(
        string firstFailure)
    {
        var calendar = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"));
        await using var source = await SyntheticSource.Start(async context =>
        {
            context.Response.ContentType = "text/calendar";
            await context.Response.WriteAsync(calendar);
        });
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient());
        if (firstFailure != "calendar_error")
            await agenda.Tick();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        await using var boundary = builder.Build();
        const string key = Sentinel + "_FUNCTION_KEY";
        var polls = 0;
        boundary.MapPost("/api/agenda", async context =>
        {
            if (context.Request.Headers["x-functions-key"].ToString() != key)
            {
                context.Response.StatusCode = 401;
                return;
            }
            if (Interlocked.Increment(ref polls) == 1)
            {
                if (firstFailure == "timeout")
                    await Task.Delay(Timeout.InfiniteTimeSpan, context.RequestAborted);
                if (firstFailure == "http_rejected")
                {
                    context.Response.StatusCode = 503;
                    await context.Response.WriteAsync(Sentinel, context.RequestAborted);
                    return;
                }
                if (firstFailure == "transport_failed")
                {
                    context.Abort();
                    return;
                }
            }
            using var reader = new StreamReader(context.Request.Body);
            using var response = await agenda.PollOnly(await reader.ReadToEndAsync());
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(response.RootElement.GetRawText());
        });
        await boundary.StartAsync();
        try
        {
            var result = await Run(new { source = source.Url, function_key = key }, "--authorize-source-access",
                "--synthetic-local", "--agenda-endpoint", boundary.Urls.Single() + "/api/agenda");

            Assert.Equal(1, result.ExitCode);
            using var report = JsonDocument.Parse(result.Output);
            var body = report.RootElement;
            Assert.False(body.GetProperty("checks_passed").GetBoolean());
            Assert.False(body.GetProperty("activation_complete").GetBoolean());
            Assert.Equal("cache_only_poll_failed", body.GetProperty("error").GetString());
            Assert.Equal("supported", Assert.Single(body.GetProperty("attempts").EnumerateArray())
                .GetProperty("interpretation").GetProperty("code").GetString());
            var poll = body.GetProperty("cache_only_poll");
            Assert.False(poll.GetProperty("checks_passed").GetBoolean());
            Assert.Equal(firstFailure switch
            {
                "timeout" => "polling_budget_exceeded",
                "http_rejected" => "authorized_poll_rejected",
                "transport_failed" => "transport_failed",
                _ => "unexpected_calendar_state"
            }, poll.GetProperty("failure_code").GetString());
            var attempts = poll.GetProperty("attempts").EnumerateArray().ToArray();
            Assert.Equal(firstFailure == "calendar_error" ? 1 : 2, attempts.Length);
            if (firstFailure != "calendar_error")
            {
                if (firstFailure == "http_rejected")
                    Assert.Equal(503, attempts[0].GetProperty("http_status").GetInt32());
                else
                    Assert.Equal(firstFailure == "timeout" ? "attempt_over_budget" : "transport_failed",
                        attempts[0].GetProperty("error").GetString());
                Assert.InRange(attempts[0].GetProperty("elapsed_ms").GetInt64(),
                    firstFailure == "timeout" ? 9_900 : 0, 15_000);
                Assert.Equal(200, attempts[1].GetProperty("http_status").GetInt32());
            }
            else
            {
                Assert.Equal("error", poll.GetProperty("state").GetString());
                Assert.Equal("refresh_missing", poll.GetProperty("error_code").GetString());
            }
            Assert.Equal(attempts.Length, polls);
            Assert.Equal(firstFailure == "calendar_error" ? 1 : 2, source.Requests);
        }
        finally
        {
            await boundary.StopAsync();
        }
    }

    [Theory]
    [InlineData("not-json")]
    [InlineData("""{"source":"CONFIDENTIAL_PREFLIGHT_SENTINEL","source":"duplicate"}""")]
    [InlineData("""{"source":"CONFIDENTIAL_PREFLIGHT_SENTINEL","unknown":"private"}""")]
    [InlineData("""{"source":null}""")]
    [InlineData("""{"source":"\ud800"}""")]
    public async Task Malformed_protected_input_never_echoes_input_or_parser_diagnostics(string input)
    {
        var result = await RunRaw(input, "--authorize-source-access", "--synthetic-local");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        Assert.Equal("invalid_protected_input", report.RootElement.GetProperty("error").GetString());
        Assert.Empty(report.RootElement.GetProperty("attempts").EnumerateArray());
    }

    [Fact]
    public async Task Source_values_in_arguments_are_rejected_without_echoing_the_argument()
    {
        var result = await RunRaw(null, "--authorize-source-access", "--synthetic-local",
            "--source-url", "https://" + Sentinel + ".invalid/calendar.ics");

        Assert.Equal(1, result.ExitCode);
        using var report = JsonDocument.Parse(result.Output);
        Assert.Equal("invalid_options", report.RootElement.GetProperty("error").GetString());
        Assert.Empty(report.RootElement.GetProperty("attempts").EnumerateArray());
    }

    private static Task<CommandResult> Run(object input, params string[] arguments) =>
        RunInternal(JsonSerializer.Serialize(input), null, arguments);

    private static Task<CommandResult> RunWithOwnerAddress(
        string? ownerAddress, object input, params string[] arguments) =>
        RunInternal(JsonSerializer.Serialize(input), ownerAddress, arguments);

    private static Task<CommandResult> RunRaw(string? input, params string[] arguments) =>
        RunInternal(input, null, arguments);

    private static async Task<CommandResult> RunInternal(
        string? input, string? ownerAddress, string[] arguments)
    {
        var start = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = DisplayTests.Root,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        start.Environment.Remove("Agenda__OwnerAddress");
        if (ownerAddress is not null)
            start.Environment["Agenda__OwnerAddress"] = ownerAddress;
        start.ArgumentList.Add(Path.Combine(DisplayTests.Root, "src", "CalendarAgenda", "bin",
#if DEBUG
            "Debug",
#else
            "Release",
#endif
            "net10.0", "CalendarAgenda.dll"));
        start.ArgumentList.Add("--source-preflight");
        foreach (var argument in arguments)
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        try
        {
            // Early rejections must finish while protected stdin is still open and unread.
            if (input is not null)
            {
                await process.StandardInput.WriteAsync(input);
                process.StandardInput.Close();
            }
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(130));
            var result = new CommandResult(process.ExitCode, await output, await errors);
            Assert.Empty(result.Errors);
            Assert.DoesNotContain(Sentinel, result.Output);
            using var report = JsonDocument.Parse(result.Output);
            AssertSafeValues(report.RootElement);
            return result;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    private sealed record CommandResult(int ExitCode, string Output, string Errors);

    private static void AssertSafeValues(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var field in value.EnumerateObject())
                {
                    Assert.Contains(field.Name, new[]
                    {
                        "schema_version", "checks_passed", "activation_complete", "delivery_design_approved",
                        "error", "evidence_scope", "source_input", "reference_input", "comparison", "attempts",
                        "synchronous_polling", "scheduled_refresh", "measurement_scope", "cache_only_poll",
                        "valid", "absolute_uri", "contains_whitespace", "contains_control_characters",
                        "leading_or_trailing_whitespace", "surrounding_quotes", "https", "loopback",
                        "has_credentials", "has_fragment", "uri_representation_unchanged",
                        "performed", "exact_equal", "same_after_trimming", "same_uri_representation",
                        "participation_capabilities", "owner_address_configured", "owner_organizer_observed",
                        "owner_attendee_observed", "owner_participation_status_observed",
                        "owner_response_usable_observed", "owner_response_missing_observed",
                        "owner_response_unsupported_observed",
                        "owner_attendee_ambiguous_observed",
                        "free_availability_observed", "followed_title_marker_observed",
                        "number", "acquisition", "interpretation", "elapsed_ms", "code", "http_status",
                        "calendar_media_type", "html_media_type", "utf8_bytes", "headers_ms", "body_ms",
                        "acquisition_budget_ms", "overall_budget_ms", "fits_observed_budget", "attempt_number",
                        "process_initialization", "azure_cold_start", "host_authentication",
                        "managed_identity_access", "refresh_persistence", "native_trmnl_polling",
                        "physical_device_delivery", "participation_semantics", "failure_code", "authentication_enforced",
                        "measured_before_probes", "cold_start_confirmed", "retry_used", "state", "error_code",
                        "raw_response_utf8_bytes", "combined_polling_utf8_bytes"
                    });
                    AssertSafeValues(field.Value);
                }
                break;
            case JsonValueKind.Array:
                foreach (var item in value.EnumerateArray())
                    AssertSafeValues(item);
                break;
            case JsonValueKind.String:
                Assert.Contains(value.GetString(), new[]
                {
                    "not_performed", "not_measured", "not_verified", "local_synthetic", "operator_machine", "deployed_http_only",
                    "source_access_not_authorized", "invalid_options", "protected_terminal_required",
                    "invalid_protected_input", "invalid_input", "reference_mismatch", "input_cancelled",
                    "report_write_failed", "scheduled_refresh_budget_exceeded", "cache_only_poll_failed",
                    "received", "redirect_refused", "http_rejected", "headers_timeout", "body_timeout",
                    "source_too_large", "invalid_utf8", "transport_failed", "source_invalid",
                    "compatibility_unsupported", "supported", "interpretation_timeout",
                    "not_assessable", "within_observed_budget", "exceeds_observed_budget",
                    "passed", "polling_smoke_unavailable", "polling_smoke_timeout", "polling_smoke_invalid",
                    "polling_smoke_failed", "current", "stale", "error", "unknown",
                    "source_configuration", "source_unavailable", "configuration_invalid", "agenda_too_large",
                    "cache_configuration", "cache_unavailable", "cache_invalid",
                    "refresh_missing", "refresh_delayed", "refresh_incomplete",
                    "polling_budget_exceeded", "authorized_poll_rejected", "unexpected_calendar_state",
                    "unexpected_calendar_error", "authentication_not_enforced", "invalid_polling_contract",
                    "combined_polling_too_large", "invalid_endpoint", "invalid_source_success_time",
                    "attempt_over_budget", "invalid_polling_json", "invalid_polling_content_type",
                    "invalid_polling_utf8", "response_too_large", "function_key_required",
                    "invalid_expectation", "invalid_rule_text_input", "smoke_tool_failed"
                });
                break;
            case JsonValueKind.Number:
                Assert.InRange(value.GetInt64(), 0, 3_000_000);
                break;
        }
    }

    private static string Calendar(string properties) =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic preflight//EN\nBEGIN:VEVENT\n"
        + $"UID:{Sentinel}\nDTSTAMP:20260101T120000Z\n{properties}\nEND:VEVENT\nEND:VCALENDAR";

    private sealed class SyntheticSource(WebApplication app) : IAsyncDisposable
    {
        private int requests;
        public int Requests => requests;
        public string Url => app.Urls.Single() + "/calendar.ics?key=" + Sentinel;

        public static async Task<SyntheticSource> Start(RequestDelegate handler)
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var app = builder.Build();
            var source = new SyntheticSource(app);
            app.MapGet("/{**path}", async context =>
            {
                Interlocked.Increment(ref source.requests);
                await handler(context);
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
}
