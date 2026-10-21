using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Theory]
    [InlineData("DTEND;VALUE=DATE:20261021")]
    [InlineData("DURATION:P1D")]
    public async Task All_day_midnight_identifiers_replace_originals_with_the_actual_date(string end)
    {
        var ics = Fixture("recurring-all-day.ics")
            .Replace("RECURRENCE-ID;VALUE=DATE:20261019",
                "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000")
            .Replace("DTSTART;VALUE=DATE:20261020", $"DTSTART;VALUE=DATE:20261020\n{end}");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var moved = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Moved all-day commitment", moved.GetProperty("title").GetString());
        Assert.Equal("all_day", moved.GetProperty("time_kind").GetString());
        Assert.Equal("2026-10-20", moved.GetProperty("start_date").GetString());
        Assert.Equal("2026-10-21", moved.GetProperty("end_date_exclusive").GetString());
        Assert.False(moved.TryGetProperty("start_at", out _));
        Assert.False(moved.TryGetProperty("end_at", out _));
        Assert.DoesNotContain("Original all-day commitment", body.GetRawText());
    }

    [Theory]
    [InlineData("2026-10-19T18:00:00Z", "20261019", "20261020", "20261021")]
    [InlineData("2026-03-06T16:00:00Z", "20260306", "20260309", "20260310")]
    [InlineData("2026-10-30T15:00:00Z", "20261030", "20261102", "20261103")]
    public async Task All_day_midnight_cancellations_suppress_originals_with_or_without_complete_actual_dates(
        string now, string primary, string secondary, string secondaryEnd)
    {
        var ics = CalendarWithEvent($"DTSTART;VALUE=DATE:{primary}\n"
            + "RRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID;TZID=Pacific Standard Time:{primary}T000000\nSTATUS:CANCELLED\n"
                + "SUMMARY:Cancelled primary commitment\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID;TZID=America/Los_Angeles:{secondary}T000000\nSTATUS:CANCELLED\n"
                + $"DTSTART;VALUE=DATE:{secondary}\nDTEND;VALUE=DATE:{secondaryEnd}\n"
                + "SUMMARY:Cancelled secondary commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp(now, ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal(DateTimeOffset.Parse(now),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(0, body.GetProperty(day).GetProperty("eligible_total").GetInt32());
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("commitment", body.GetRawText());
    }

    [Theory]
    [InlineData("Pacific Standard Time", "2026-03-06T16:00:00Z", "20260306", "20260309", "20260310",
        "2026-03-09", "2026-03-10")]
    [InlineData("America/Los_Angeles", "2026-03-06T16:00:00Z", "20260306", "20260309", "20260310",
        "2026-03-09", "2026-03-10")]
    [InlineData("Asia/Tokyo", "2026-03-06T16:00:00Z", "20260306", "20260309", "20260310",
        "2026-03-09", "2026-03-10")]
    [InlineData("Pacific Standard Time", "2026-10-30T15:00:00Z", "20261030", "20261102", "20261103",
        "2026-11-02", "2026-11-03")]
    [InlineData("America/Los_Angeles", "2026-10-30T15:00:00Z", "20261030", "20261102", "20261103",
        "2026-11-02", "2026-11-03")]
    [InlineData("Eastern Standard Time", "2026-10-30T15:00:00Z", "20261030", "20261102", "20261103",
        "2026-11-02", "2026-11-03")]
    [InlineData("UTC", "2026-10-30T15:00:00Z", "20261030", "20261102", "20261103",
        "2026-11-02", "2026-11-03")]
    public async Task All_day_midnight_identifiers_keep_literal_wall_dates_across_zones_and_DST(
        string zone, string now, string originalDate, string actualDate, string actualEnd,
        string expectedDate, string expectedEnd)
    {
        var ics = CalendarWithEvent($"DTSTART;VALUE=DATE:{originalDate}\nRRULE:FREQ=DAILY;COUNT=5\n"
            + $"EXDATE;VALUE=DATE:{actualDate}\nSUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID;TZID={zone}:{originalDate}T000000\n"
                + $"DTSTART;VALUE=DATE:{actualDate}\nDTEND;VALUE=DATE:{actualEnd}\n"
                + "SUMMARY:Moved all-day commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp(now, ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Moved all-day commitment", occurrence.GetProperty("title").GetString());
        Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
        Assert.Equal(expectedDate, occurrence.GetProperty("start_date").GetString());
        Assert.Equal(expectedEnd, occurrence.GetProperty("end_date_exclusive").GetString());
        Assert.DoesNotContain("Original all-day commitment", body.GetRawText());
        Assert.False(occurrence.TryGetProperty("start_at", out _));
        Assert.False(occurrence.TryGetProperty("end_at", out _));

        agenda.SetSource(ics.Replace($"RECURRENCE-ID;TZID={zone}:{originalDate}T000000",
            $"RECURRENCE-ID;VALUE=DATE:{originalDate}"));
        using var dateOnly = await agenda.Poll();
        Assert.Equal("current", dateOnly.RootElement.GetProperty("state").GetString());
        Assert.Equal(body.GetProperty("primary").GetRawText(), dateOnly.RootElement.GetProperty("primary").GetRawText());
        Assert.Equal(body.GetProperty("secondary").GetRawText(), dateOnly.RootElement.GetProperty("secondary").GetRawText());
    }

    [Theory]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019", false, "")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019", true, "")]
    [InlineData("RECURRENCE-ID;TZID=Eastern Standard Time:20261019T000000", false, "")]
    [InlineData("RECURRENCE-ID:20261019T000000Z", false, "")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019", false, "STATUS:CANCELLED\n")]
    public async Task All_day_midnight_and_date_only_duplicate_identifiers_are_errors_not_selected_revisions(
        string secondIdentifier, bool reverseOrder, string secondStatus)
    {
        var changes = new[]
        {
            "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000\n"
                + "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nSUMMARY:First all-day revision",
            $"{secondIdentifier}\n{secondStatus}DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\n"
                + "SUMMARY:Conflicting all-day revision"
        };
        var ics = CalendarWithEvent("DTSTART;VALUE=DATE:20261019\nRRULE:FREQ=DAILY;COUNT=2\n"
            + "SUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", string.Concat((reverseOrder ? changes.Reverse() : changes)
                .Select(properties => "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                    + $"{properties}\nEND:VEVENT\n")) + "END:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("source_invalid", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("revision", body.GetRawText());
    }

    [Theory]
    [InlineData("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000001")]
    [InlineData("RECURRENCE-ID;TZID=America/Los_Angeles:20261019T000100")]
    [InlineData("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T120000")]
    [InlineData("RECURRENCE-ID:20261019T070000Z")]
    [InlineData("RECURRENCE-ID;TZID=Pacific Standard Time:20261018T170000")]
    [InlineData("RECURRENCE-ID:20261019T000000")]
    [InlineData("RECURRENCE-ID;TZID=Unverified/Secret:20261019T000000")]
    [InlineData("RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Pacific Standard Time:20261019T000000")]
    [InlineData("RECURRENCE-ID;RANGE=THISANDPRIOR;TZID=Pacific Standard Time:20261019T000000")]
    [InlineData("RECURRENCE-ID;RANGE=UNVERIFIED;TZID=Pacific Standard Time:20261019T000000")]
    public async Task All_day_midnight_support_does_not_coerce_nonmidnight_floating_unknown_or_ranged_identifiers(
        string identifier)
    {
        var ics = Fixture("recurring-all-day.ics")
            .Replace("RECURRENCE-ID;VALUE=DATE:20261019", identifier)
            .Replace("DTSTART;VALUE=DATE:20261020", "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("Secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("commitment", body.GetRawText());
    }

    [Theory]
    [InlineData("RRULE:FREQ=DAILY;COUNT=2", false)]
    [InlineData("RDATE;VALUE=DATE:20261021", false)]
    [InlineData("EXDATE;VALUE=DATE:20261020", false)]
    [InlineData("EXRULE:FREQ=DAILY", false)]
    [InlineData("RRULE:FREQ=DAILY;COUNT=2", true)]
    [InlineData("RDATE;VALUE=DATE:20261021", true)]
    [InlineData("EXDATE;VALUE=DATE:20261020", true)]
    [InlineData("EXRULE:FREQ=DAILY", true)]
    public async Task All_day_midnight_changes_with_their_own_recurrence_set_are_not_partial_agendas(
        string property, bool startlessCancellation)
    {
        var actual = startlessCancellation ? "STATUS:CANCELLED"
            : "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021";
        var ics = CalendarWithEvent("DTSTART;VALUE=DATE:20261019\nRRULE:FREQ=DAILY;COUNT=3\n"
            + "SUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000\n"
                + $"{actual}\n{property}\nSUMMARY:Ambiguous all-day change\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("Ambiguous", body.GetRawText());
    }

    [Theory]
    [InlineData("DTSTART:20261020T170000Z\nDTEND:20261020T180000Z", "compatibility_unsupported")]
    [InlineData("DTSTART;VALUE=DATE:20261020", "compatibility_unsupported")]
    [InlineData("DTSTART;VALUE=DATE:20261020\nDTEND:20261021T000000Z", "source_invalid")]
    [InlineData("DTSTART;VALUE=DATE:20261020\nDURATION:P1DT1H", "source_invalid")]
    [InlineData("DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261020", "source_invalid")]
    [InlineData("DTEND;VALUE=DATE:20261020", "source_invalid")]
    [InlineData("STATUS:CANCELLED\nDTEND;VALUE=DATE:20261020", "compatibility_unsupported")]
    [InlineData("STATUS:CANCELLED\nDURATION:P1D", "compatibility_unsupported")]
    [InlineData("STATUS:CANCELLED\nDTSTART:20261020T170000Z\nDTEND:20261020T180000Z", "compatibility_unsupported")]
    public async Task All_day_midnight_support_requires_unambiguous_actual_dates_or_a_startless_cancellation(
        string actual, string code)
    {
        var ics = CalendarWithEvent("DTSTART;VALUE=DATE:20261019\nRRULE:FREQ=DAILY;COUNT=3\n"
            + "SUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000\n"
                + $"{actual}\nSUMMARY:Ambiguous all-day change\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal(code, body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("Ambiguous", body.GetRawText());
    }

    [Theory]
    [InlineData("detached")]
    [InlineData("timed_master")]
    public async Task All_day_midnight_exception_never_applies_without_an_attached_DATE_master(string scenario)
    {
        var ics = scenario == "detached"
            ? CalendarWithEvent("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000\n"
                + "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nSUMMARY:Detached date-kind mismatch")
            : CalendarWithEvent("DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\nRRULE:FREQ=DAILY;COUNT=2\n"
                + "SUMMARY:Original timed commitment")
                .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                    + "RECURRENCE-ID;VALUE=DATE:20261019\nDTSTART:20261020T170000Z\nDTEND:20261020T180000Z\n"
                    + "SUMMARY:Moved timed commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
    }

    [Fact]
    public async Task All_day_midnight_overrides_do_not_revive_a_cancelled_master()
    {
        var ics = Fixture("recurring-all-day.ics")
            .Replace("RRULE:FREQ=DAILY;COUNT=7", "RRULE:FREQ=DAILY;COUNT=7\nSTATUS:CANCELLED")
            .Replace("RECURRENCE-ID;VALUE=DATE:20261019",
                "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000")
            .Replace("DTSTART;VALUE=DATE:20261020", "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(0, body.GetProperty(day).GetProperty("eligible_total").GetInt32());
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
    }

    [Fact]
    public async Task All_day_midnight_moves_and_cancellations_keep_current_rules_cache_and_production_rendering_truthful()
    {
        var ics = CalendarWithEvent("DTSTART;VALUE=DATE:20261016\nRRULE:FREQ=DAILY;COUNT=7\n"
            + "SUMMARY:OOF original all-day series")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000\n"
                + "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\n"
                + "SUMMARY:Proofreading moved workshop\nDESCRIPTION:CONFIDENTIAL_DESCRIPTION\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;TZID=America/Los_Angeles:20261020T000000\nSTATUS:CANCELLED\n"
                + "SUMMARY:Cancelled original Tuesday\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:workshop@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:Independent workshop\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:reservation@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:OOF reservation\n"
                + "END:VEVENT\nEND:VCALENDAR");
        const string excludeOof = """[{"field":"title","mode":"whole_word","value":"OOF"}]""";
        const string excludeProofreading = """[{"field":"title","mode":"starts_with","value":"Proofreading"}]""";
        using var storage = new CacheDirectory();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        var view = new AdaptiveDisplayTests.NativeView("og", "full", 800, 480, 1, 780, 460);
        string? movedId;
        using (var first = new AgendaHttp("2026-10-19T18:00:00Z", ics, cacheDirectory: storage.Path))
        {
            using var current = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
            var body = current.RootElement;
            Assert.Equal("current", body.GetProperty("state").GetString());
            Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
            var moved = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
            movedId = moved.GetProperty("id").GetString();
            Assert.Equal("Proofreading moved workshop", moved.GetProperty("title").GetString());
            Assert.Equal("2026-10-20", moved.GetProperty("start_date").GetString());
            Assert.Equal("2026-10-21", moved.GetProperty("end_date_exclusive").GetString());
            Assert.DoesNotContain("OOF", body.GetRawText());
            await Show(body, "current", "Oct 19, 2026, 11:00 AM PDT", 1, 1);
            await Assertions.Expect(page.GetByText("Proofreading moved workshop", new() { Exact = true })).ToBeVisibleAsync();

            first.Clock.Advance(TimeSpan.FromMinutes(5));
            using var edited = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeProofreading }));
            Assert.Equal("current", edited.RootElement.GetProperty("state").GetString());
            Assert.Equal(2, edited.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(0, edited.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
            Assert.Contains("OOF reservation", edited.RootElement.GetRawText());
            Assert.DoesNotContain("Proofreading", edited.RootElement.GetRawText());
            await Show(edited.RootElement, "edited", "Oct 19, 2026, 11:00 AM PDT", 2, 0);
            await Assertions.Expect(page.GetByText("OOF reservation", new() { Exact = true })).ToBeVisibleAsync();
        }

        var unsupported = ics.Replace("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T000000",
            "RECURRENCE-ID:20261019T070000Z");
        using var recreated = new AgendaHttp("2026-10-19T18:20:00Z", unsupported, cacheDirectory: storage.Path);
        using var stale = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", stale.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(1, stale.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, stale.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(movedId, Assert.Single(stale.RootElement.GetProperty("secondary").GetProperty("occurrences")
            .EnumerateArray()).GetProperty("id").GetString());
        await Show(stale.RootElement, "stale", "Oct 19, 2026, 11:00 AM PDT", 1, 1);
        await Assertions.Expect(page.GetByText("Stale agenda", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Proofreading moved workshop", new() { Exact = true })).ToBeVisibleAsync();

        recreated.Clock.Advance(TimeSpan.FromMinutes(40) - TimeSpan.FromTicks(1));
        using var beforeExpiry = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = "[]" }));
        Assert.Equal("stale", beforeExpiry.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, beforeExpiry.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, beforeExpiry.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            beforeExpiry.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        recreated.Clock.Advance(TimeSpan.FromTicks(1));
        using var expired = await recreated.Poll();
        var error = expired.RootElement;
        Assert.Equal("error", error.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            error.GetProperty("source_succeeded_at").GetDateTimeOffset());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, error.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(error.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        await DisplayTests.Show(page, error);
        await AdaptiveDisplayTests.NativeBounds(page, view);
        await AdaptiveDisplayTests.VisibleInk(page, "midnight-all-day-og-full-expired", view,
            new[] { "Agenda unavailable", "Compatibility error", "compatibility_unsupported",
                "A recurring change uses a different identifier date type.", "Oct 19, 2026, 11:00 AM PDT" }
                .Select(text => page.GetByText(text, new() { Exact = true })));
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());

        async Task Show(JsonElement body, string name, string sourceLabel, int primaryTotal, int secondaryTotal)
        {
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
            Assert.DoesNotContain("original", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
            foreach (var day in new[] { "primary", "secondary" })
                Assert.All(body.GetProperty(day).GetProperty("occurrences").EnumerateArray(), occurrence =>
                {
                    Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
                    Assert.False(occurrence.TryGetProperty("start_at", out _));
                    Assert.False(occurrence.TryGetProperty("end_at", out _));
                });
            await DisplayTests.Show(page, body);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var required = new List<ILocator>
            {
                page.GetByText("Monday, Oct 19", new() { Exact = true }),
                page.GetByText("Tuesday, Oct 20", new() { Exact = true }),
                page.Locator(".agenda-primary").GetByText(
                    $"{primaryTotal} eligible {(primaryTotal == 1 ? "event" : "events")}", new() { Exact = true }),
                page.Locator(".agenda-secondary").GetByText(
                    $"{secondaryTotal} eligible {(secondaryTotal == 1 ? "event" : "events")}", new() { Exact = true }),
                page.GetByText("Source checked:", new() { Exact = true }),
                page.GetByText(sourceLabel, new() { Exact = true })
            };
            var rows = page.Locator("tbody tr:visible");
            Assert.Equal(primaryTotal + secondaryTotal, await rows.CountAsync());
            foreach (var row in await rows.AllAsync())
            {
                required.Add(row.GetByText("All day", new() { Exact = true }));
                required.Add(row.Locator("td .title"));
            }
            if (body.GetProperty("state").GetString() == "stale")
            {
                Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                    body.GetProperty("source_succeeded_at").GetDateTimeOffset());
                required.Add(page.GetByText("Stale agenda", new() { Exact = true }));
                required.Add(page.GetByText("A recurring change uses a different identifier date type.",
                    new() { Exact = true }));
            }
            await Assertions.Expect(page.Locator("[data-agenda-source]"))
                .ToHaveAttributeAsync("datetime", body.GetProperty("source_succeeded_at").GetString()!);
            Assert.Equal(0, await page.Locator("[data-agenda-start]").CountAsync());
            Assert.DoesNotContain("12:00 AM", await page.Locator("body").InnerTextAsync());
            await AdaptiveDisplayTests.VisibleInk(page, $"midnight-all-day-og-full-{name}", view, required);
        }
    }
}
