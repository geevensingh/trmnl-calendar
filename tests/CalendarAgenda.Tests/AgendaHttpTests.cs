using System.Net;
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
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class AgendaHttpTests
{
    [Fact]
    public async Task Http_poll_returns_ongoing_and_upcoming_occurrences_in_the_working_day_window()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal("2026-10-19", body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal("2026-10-20", body.GetProperty("secondary").GetProperty("date").GetString());
        Assert.Equal(
            ["Ongoing planning", "Design review"],
            body.GetProperty("primary").GetProperty("occurrences").EnumerateArray()
                .Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(2, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
    }

    [Theory]
    [InlineData("{}", "configuration_invalid")]
    [InlineData("null", "configuration_invalid")]
    [InlineData("{", "configuration_invalid")]
    [InlineData("""{"rules_json":null}""", "configuration_invalid")]
    [InlineData("""{"rules_json":[]}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"{"}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"{}"}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"null"}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"[]","source_url":"https://caller.invalid/secret"}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"[]","rules_json":"[]"}""", "configuration_invalid")]
    [InlineData("""{"rules_json":"[{\"field\":\"title\",\"mode\":\"contains\",\"value\":\"secret\"}]"}""",
        "configuration_unsupported")]
    public async Task Invalid_or_not_yet_supported_rules_are_renderable_errors_not_unfiltered_agendas(
        string request, string code)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var result = await agenda.Poll(request);
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal(code, body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.DoesNotContain("secret", result.RootElement.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("http_failure", "source_unavailable")]
    [InlineData("timeout", "source_unavailable")]
    [InlineData("malformed", "source_invalid")]
    [InlineData("empty", "source_invalid")]
    [InlineData("truncated", "source_invalid")]
    [InlineData("missing_url", "source_configuration")]
    [InlineData("insecure_url", "source_configuration")]
    public async Task Failed_sources_have_no_empty_or_partial_success(string failure, string code)
    {
        var ics = failure switch
        {
            "malformed" => "synthetic secret source contents",
            "empty" => "",
            "truncated" => "BEGIN:VCALENDAR\nVERSION:2.0\n",
            _ => Fixture("basic.ics")
        };
        var url = failure switch
        {
            "missing_url" => null,
            "insecure_url" => "http://synthetic.invalid/secret",
            _ => "https://synthetic.invalid/secret"
        };
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics, url,
            failure == "http_failure" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK,
            timeout: failure == "timeout");
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal(code, body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nRRULE:FREQ=DAILY")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nRDATE:20261020T190000Z")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nEXDATE:20261020T190000Z")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nEXRULE:FREQ=DAILY")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nRECURRENCE-ID:20261019T190000Z")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261019T190000Z")]
    [InlineData("DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020")]
    [InlineData("DTSTART:20261019T120000\nDTEND:20261019T130000")]
    [InlineData("DTSTART;TZID=Unverified/Secret:20261019T120000\nDTEND;TZID=Unverified/Secret:20261019T130000")]
    public async Task Unsupported_calendar_semantics_fail_the_entire_agenda(string properties)
    {
        var ics = Fixture("basic.ics").Replace("END:VCALENDAR",
            $"BEGIN:VEVENT\nUID:unsupported@synthetic.invalid\nDTSTAMP:20261018T120000Z\n{properties}\n"
            + "SUMMARY:Unsupported synthetic event\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
    }

    [Fact]
    public async Task Timed_duration_and_Outlook_time_zone_produce_unambiguous_instants()
    {
        var ics = CalendarWithEvent(
            "DTSTART;TZID=Pacific Standard Time:20261102T090000\nDURATION:PT1H\nSUMMARY:Winter planning");
        using var agenda = new AgendaHttp("2026-11-02T16:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("timed", occurrence.GetProperty("time_kind").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T17:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T18:00:00Z"), occurrence.GetProperty("end_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T16:00:00Z"), body.GetProperty("source_succeeded_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("DTSTART:20261019T200000Z\nDTEND:20261019T190000Z")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T190000Z")]
    [InlineData("DTEND:20261019T200000Z")]
    [InlineData("DTSTART:invalid\nDTEND:20261019T200000Z")]
    [InlineData("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nDURATION:PT1H")]
    [InlineData("DTSTART:20261019T190000Z\nDTSTART:20261019T193000Z\nDTEND:20261019T200000Z")]
    public async Task Invalid_event_data_cannot_become_a_current_agenda(string properties)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithEvent(properties));
        using var result = await agenda.Poll();

        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("source_invalid", result.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("2026-10-22T18:00:00Z", "2026-10-22", "2026-10-23")]
    [InlineData("2026-10-23T18:00:00Z", "2026-10-23", "2026-10-26")]
    [InlineData("2026-10-24T18:00:00Z", "2026-10-26", "2026-10-27")]
    [InlineData("2026-10-25T18:00:00Z", "2026-10-26", "2026-10-27")]
    [InlineData("2026-10-24T01:00:00Z", "2026-10-23", "2026-10-26")]
    [InlineData("2026-01-01T18:00:00Z", "2026-01-01", "2026-01-02")]
    public async Task Empty_days_keep_the_Los_Angeles_working_day_window(
        string now, string primary, string secondary)
    {
        const string empty = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic//EN\nEND:VCALENDAR";
        using var agenda = new AgendaHttp(now, empty);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(primary, body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal(secondary, body.GetProperty("secondary").GetProperty("date").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.DoesNotContain("tomorrow", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("2026-07-06T15:00:00Z", "20260706", "2026-07-06T16:00:00Z")]
    [InlineData("2026-11-02T16:00:00Z", "20261102", "2026-11-02T17:00:00Z")]
    public async Task Local_event_times_follow_daylight_saving_not_the_server_zone(
        string now, string date, string expectedStart)
    {
        var ics = CalendarWithEvent($"DTSTART;TZID=America/Los_Angeles:{date}T090000\n"
            + $"DTEND;TZID=America/Los_Angeles:{date}T100000\nSUMMARY:Local planning");
        using var agenda = new AgendaHttp(now, ics);
        using var result = await agenda.Poll();
        var occurrence = Assert.Single(result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray());

        Assert.Equal(DateTimeOffset.Parse(expectedStart), occurrence.GetProperty("start_at").GetDateTimeOffset());
    }

    [Fact]
    public async Task An_overnight_occurrence_is_counted_on_each_overlapping_selected_date_without_private_fields()
    {
        var ics = CalendarWithEvent("DTSTART:20261020T060000Z\nDTEND:20261020T080000Z\n"
            + "SUMMARY:Overnight handoff\nDESCRIPTION:secret description\nATTENDEE:mailto:secret@example.invalid");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("source_url", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("[]", "current")]
    [InlineData(" \r\n[ ]\n ", "current")]
    [InlineData("[{\r\n\"field\":\"title\",\"mode\":\"contains\",\"value\":\"A \\\"quote\\\" & </script>\"}]", "error")]
    [InlineData("{\"broken\": [\n\"quote\"", "error")]
    [InlineData("", "error")]
    public async Task Native_TRMNL_polling_body_safely_transports_edited_rule_JSON(string rules, string expectedState)
    {
        var request = DisplayTests.Render("polling-body", new { rules_json = rules });
        using var transport = JsonDocument.Parse(request);
        Assert.Equal(rules, transport.RootElement.GetProperty("rules_json").GetString());
        Assert.Single(transport.RootElement.EnumerateObject());
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var result = await agenda.Poll(request);

        Assert.Equal(expectedState, result.RootElement.GetProperty("state").GetString());
    }

    [Fact]
    public async Task A_cancelled_nonrecurring_event_is_not_an_eligible_commitment()
    {
        var ics = Fixture("basic.ics").Replace("SUMMARY:Design review", "STATUS:CANCELLED\nSUMMARY:Design review");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();

        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal(1, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("Design review", result.RootElement.GetRawText());
    }

    [Theory]
    [InlineData("duplicate_uid", "source_invalid")]
    [InlineData("missing_prodid", "source_invalid")]
    [InlineData("extra_root", "source_invalid")]
    [InlineData("calendar_cancel", "compatibility_unsupported")]
    [InlineData("other_calendar_scale", "compatibility_unsupported")]
    public async Task Incomplete_or_unsupported_calendars_cannot_report_partial_source_success(string feature, string code)
    {
        var baseline = CalendarWithEvent("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nSUMMARY:Synthetic meeting");
        var ics = feature switch
        {
            "duplicate_uid" => Fixture("basic.ics").Replace("UID:design-review@synthetic.invalid", "UID:ongoing@synthetic.invalid"),
            "missing_prodid" => baseline.Replace("PRODID:-//TRMNL Calendar//Synthetic tests//EN\n", ""),
            "extra_root" => baseline + "BEGIN:VTODO\nUID:task@synthetic.invalid\nEND:VTODO\n",
            "calendar_cancel" => baseline.Replace("VERSION:2.0", "VERSION:2.0\nMETHOD:CANCEL"),
            "other_calendar_scale" => baseline.Replace("VERSION:2.0", "VERSION:2.0\nCALSCALE:HEBREW"),
            _ => throw new ArgumentOutOfRangeException(nameof(feature))
        };
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();

        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal(code, result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("source_succeeded_at").ValueKind);
    }

    [Fact]
    public async Task An_oversize_agenda_returns_a_small_renderable_error_instead_of_truncated_commitments()
    {
        var ics = CalendarWithEvent("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nSUMMARY:"
            + new string('X', 100_000));
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("agenda_too_large", body.GetProperty("error").GetProperty("code").GetString());
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(body.GetRawText()) < 100_000);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
    }

    private static string CalendarWithEvent(string properties) =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TRMNL Calendar//Synthetic tests//EN\n"
        + $"BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n{properties}\nEND:VEVENT\nEND:VCALENDAR\n";

    private static string Fixture(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", name));

    private sealed class AgendaHttp : IDisposable
    {
        private readonly IHost host;
        private readonly HttpClient source;
        private readonly HttpClient client;

        public AgendaHttp(string now, string ics,
            string? sourceUrl = "https://synthetic.invalid/calendar.ics",
            HttpStatusCode status = HttpStatusCode.OK, bool timeout = false)
        {
            source = new HttpClient(new SourceResponse(ics, status, timeout));
            var settings = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["Agenda:SourceUrl"] = sourceUrl })
                .Build();
            var function = new AgendaFunction(source, settings,
                new FakeTimeProvider(DateTimeOffset.Parse(now)), NullLogger<AgendaFunction>.Instance);
            host = new HostBuilder().ConfigureWebHost(web => web.UseTestServer()
                .ConfigureServices(services =>
                {
                    services.AddRouting();
                    services.AddMvcCore();
                })
                .Configure(app => app.UseRouting().UseEndpoints(endpoints =>
                    endpoints.MapPost("/api/agenda", async context =>
                    {
                        var result = await function.Run(context.Request);
                        await result.ExecuteResultAsync(new ActionContext(
                            context, new RouteData(), new ActionDescriptor()));
                    })))).Start();
            client = host.GetTestClient();
        }

        public async Task<JsonDocument> Poll(string body = """{"rules_json":"[]"}""")
        {
            using var response = await client.PostAsync("/api/agenda",
                new StringContent(body, System.Text.Encoding.UTF8, "application/json"));
            response.EnsureSuccessStatusCode();
            return JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        }

        public void Dispose()
        {
            client.Dispose();
            source.Dispose();
            host.Dispose();
        }
    }

    private sealed class SourceResponse(string ics, HttpStatusCode status, bool timeout) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (timeout)
                throw new TaskCanceledException("Synthetic secret timeout.");
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(ics, System.Text.Encoding.UTF8, "text/calendar")
            });
        }
    }
}
