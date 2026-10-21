using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Fact]
    public async Task A_complete_detached_occurrence_uses_its_actual_time_without_inventing_a_series()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\n"
            + "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\nSUMMARY:Detached planning");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T16:30:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Detached planning", occurrence.GetProperty("title").GetString());
        Assert.Equal("timed", occurrence.GetProperty("time_kind").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"), occurrence.GetProperty("end_at").GetDateTimeOffset());
        Assert.Empty(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("synthetic.invalid", body.GetRawText());
    }

    [Theory]
    [InlineData("DTEND;VALUE=DATE:20261021")]
    [InlineData("DURATION:P2D")]
    public async Task Detached_snapshots_publish_only_supplied_instances_with_exclusive_all_day_and_mixed_zone_bounds(
        string allDayEnd)
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\n"
            + "DTSTART:20261019T200000Z\nDTEND:20261019T210000Z\nSUMMARY:Later detached planning")
            .Replace("END:VCALENDAR", string.Concat(new[]
            {
                ("event", "RECURRENCE-ID:20261019T200000Z\nDTSTART:20261019T170000Z\n"
                    + "DURATION:PT1H\nSUMMARY:Earlier detached planning"),
                ("event", "RECURRENCE-ID:20261022T010000Z\nDTSTART;TZID=Asia/Tokyo:20261021T110000\n"
                    + "DTEND;TZID=Asia/Tokyo:20261021T120000\nSUMMARY:Detached evening planning"),
                ("detached-day", "RECURRENCE-ID;VALUE=DATE:20261018\nDTSTART;VALUE=DATE:20261019\n"
                    + $"{allDayEnd}\nSUMMARY:Detached workshop"),
                ("future-day", "RECURRENCE-ID;VALUE=DATE:20261020\nDTSTART;VALUE=DATE:20261021\n"
                    + "DTEND;VALUE=DATE:20261022\nSUMMARY:Out-of-window detached day")
            }.Select(item => $"BEGIN:VEVENT\nUID:{item.Item1}@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"{item.Item2}\nEND:VEVENT\n")) + "END:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(3, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(2, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var primary = body.GetProperty("primary").GetProperty("occurrences").EnumerateArray().ToArray();
        var secondary = body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray().ToArray();
        Assert.Equal(["Detached workshop", "Earlier detached planning", "Later detached planning"],
            primary.Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(["Detached workshop", "Detached evening planning"],
            secondary.Select(item => item.GetProperty("title").GetString()));
        Assert.Equal("all_day", primary[0].GetProperty("time_kind").GetString());
        Assert.Equal("2026-10-19", primary[0].GetProperty("start_date").GetString());
        Assert.Equal("2026-10-21", primary[0].GetProperty("end_date_exclusive").GetString());
        Assert.False(primary[0].TryGetProperty("start_at", out _));
        Assert.False(primary[0].TryGetProperty("end_at", out _));
        Assert.Equal(primary[0].GetProperty("id").GetString(), secondary[0].GetProperty("id").GetString());
        Assert.Equal(3, primary.Select(item => item.GetProperty("id").GetString()).Distinct().Count());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:00:00Z"), primary[1].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"), primary[1].GetProperty("end_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T20:00:00Z"), primary[2].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T02:00:00Z"), secondary[1].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T03:00:00Z"), secondary[1].GetProperty("end_at").GetDateTimeOffset());
        Assert.DoesNotContain("Out-of-window detached day", body.GetRawText());

        agenda.Clock.Advance(TimeSpan.FromDays(2));
        await agenda.Refresh();
        using var later = await agenda.Poll();
        Assert.Equal("current", later.RootElement.GetProperty("state").GetString());
        Assert.Equal("2026-10-21", later.RootElement.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal(1, later.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal("Out-of-window detached day", Assert.Single(
            later.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.Equal(0, later.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("Detached workshop", later.RootElement.GetRawText());
    }

    [Fact]
    public async Task Distinct_Windows_zone_detached_identities_keep_actual_times_and_the_current_ended_cutoff()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T090000\n"
            + "DTSTART;TZID=Pacific Standard Time:20261019T100000\n"
            + "DTEND;TZID=Pacific Standard Time:20261019T110000\nSUMMARY:Pacific detached planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;TZID=Eastern Standard Time:20261019T090000\n"
                + "DTSTART;TZID=Pacific Standard Time:20261019T120000\nDURATION:PT1H\n"
                + "SUMMARY:Eastern detached planning\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
        using var current = await agenda.Poll();
        var body = current.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(2, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        var occurrences = body.GetProperty("primary").GetProperty("occurrences").EnumerateArray().ToArray();
        Assert.Equal(["Pacific detached planning", "Eastern detached planning"],
            occurrences.Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:00:00Z"), occurrences[0].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T19:00:00Z"), occurrences[1].GetProperty("start_at").GetDateTimeOffset());
        Assert.NotEqual(occurrences[0].GetProperty("id").GetString(), occurrences[1].GetProperty("id").GetString());

        agenda.Clock.Advance(TimeSpan.FromMinutes(90));
        await agenda.Refresh();
        using var atEnd = await agenda.Poll();
        Assert.Equal("current", atEnd.RootElement.GetProperty("state").GetString());
        Assert.Equal(1, atEnd.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal("Eastern detached planning", Assert.Single(
            atEnd.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.DoesNotContain("Pacific detached planning", atEnd.RootElement.GetRawText());
    }

    [Theory]
    [InlineData("RRULE:FREQ=DAILY;COUNT=2")]
    [InlineData("RDATE:20261020T170000Z")]
    [InlineData("EXDATE:20261020T170000Z")]
    [InlineData("EXRULE:FREQ=DAILY")]
    public async Task Detached_records_with_their_own_recurrence_set_remain_whole_source_errors(string property)
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\n"
            + $"DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\n{property}\nSUMMARY:Ambiguous detached planning");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
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
        Assert.DoesNotContain("Ambiguous detached planning", body.GetRawText());
    }

    [Theory]
    [InlineData("RECURRENCE-ID;RANGE=THISANDFUTURE:20261019T160000Z")]
    [InlineData("RECURRENCE-ID;RANGE=THISANDPRIOR:20261019T160000Z")]
    [InlineData("RECURRENCE-ID;RANGE=UNVERIFIED:20261019T160000Z")]
    [InlineData("RECURRENCE-ID:20261019T160000")]
    [InlineData("RECURRENCE-ID;TZID=Unverified/Secret:20261019T090000")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019")]
    public async Task Detached_ranges_and_ambiguous_identifier_times_cannot_establish_source_success(string identifier)
    {
        var ics = Fixture("basic.ics").Replace("END:VCALENDAR",
            "BEGIN:VEVENT\nUID:detached@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + $"{identifier}\nDTSTART:20261019T170000Z\nDTEND:20261019T180000Z\n"
            + "SUMMARY:Ambiguous detached planning\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
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
        Assert.DoesNotContain("planning", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTEND:20261019T180000Z", "source_invalid")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000Z", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nSTATUS:CANCELLED", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019\nDTSTART;VALUE=DATE:20261020", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019\nDTSTART;VALUE=DATE:20261020\nDTEND:20261021T000000Z", "source_invalid")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019\nDTSTART;VALUE=DATE:20261020\nDURATION:P1DT1H", "source_invalid")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019\nDTSTART:20261019T170000Z\nDURATION:PT1H", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000\nDTEND:20261019T180000", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTSTART;TZID=Unverified/Secret:20261019T100000\nDURATION:PT1H", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000Z\nDTEND:20261019T180000", "compatibility_unsupported")]
    [InlineData("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000Z\nDURATION:PT0S", "source_invalid")]
    public async Task Incomplete_or_invalid_detached_timing_is_never_guessed(string properties, string code)
    {
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", CalendarWithEvent(properties));
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
        Assert.DoesNotContain("Secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("RECURRENCE-ID:20261019T160000Z", "")]
    [InlineData("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T090000", "")]
    [InlineData("RECURRENCE-ID;TZID=Eastern Standard Time:20261019T120000", "")]
    [InlineData("RECURRENCE-ID;TZID=Asia/Tokyo:20261020T010000", "")]
    [InlineData("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T090000", "STATUS:CANCELLED\n")]
    public async Task Duplicate_detached_identities_in_equivalent_zones_are_errors_not_selected_revisions(
        string identifier, string status)
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\n"
            + "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\nSUMMARY:First detached revision")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"{identifier}\n{status}DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\n"
                + "SUMMARY:Conflicting detached revision\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
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

    [Fact]
    public async Task A_complete_cancelled_detached_instance_does_not_hide_another_published_instance()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\n"
            + "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\nSUMMARY:Active detached planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID:20261019T170000Z\nDTSTART:20261019T190000Z\nDTEND:20261019T200000Z\n"
                + "STATUS:CANCELLED\nSUMMARY:Cancelled detached planning\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        var retained = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Active detached planning", retained.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:00:00Z"), retained.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("Cancelled", body.GetRawText());
    }

    [Fact]
    public async Task Duplicate_date_only_detached_identities_cannot_silently_select_a_revision()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID;VALUE=DATE:20261018\nDTSTART;VALUE=DATE:20261019\n"
            + "DTEND;VALUE=DATE:20261020\nSUMMARY:First all-day revision")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;VALUE=DATE:20261018\nDTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\n"
                + "SUMMARY:Conflicting all-day revision\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
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
    }

    [Theory]
    [InlineData("RECURRENCE-ID:20261019T160000Z", "RECURRENCE-ID:20261019T190000Z",
        "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z", "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z")]
    [InlineData("RECURRENCE-ID:20261019T160000Z", "RECURRENCE-ID:20261019T190000Z",
        "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z",
        "DTSTART;TZID=Pacific Standard Time:20261019T100000\nDTEND;TZID=Pacific Standard Time:20261019T110000")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261018", "RECURRENCE-ID;VALUE=DATE:20261020",
        "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020", "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020")]
    public async Task Detached_records_that_collapse_to_the_same_published_identity_cannot_report_partial_success(
        string firstIdentifier, string secondIdentifier, string firstTiming, string secondTiming)
    {
        var ics = CalendarWithEvent($"{firstIdentifier}\n{firstTiming}\nSUMMARY:First detached commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"{secondIdentifier}\n{secondTiming}\nSUMMARY:Second detached commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T16:30:00Z", ics);
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
    public async Task Persisted_detached_instances_reselect_Monday_and_Tuesday_after_Friday_rollover()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261023T160000Z\nDTSTART:20261026T160000Z\n"
            + "DURATION:PT1H\nSUMMARY:Detached Monday planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID:20261026T160000Z\nDTSTART:20261027T160000Z\nDURATION:PT1H\n"
                + "SUMMARY:Detached Tuesday planning\nEND:VEVENT\nEND:VCALENDAR");
        using var storage = new CacheDirectory();
        using (var first = new AgendaHttp("2026-10-24T06:45:00Z", ics, cacheDirectory: storage.Path))
        using (var current = await first.Poll())
        {
            Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
            Assert.Equal("2026-10-23", current.RootElement.GetProperty("primary").GetProperty("date").GetString());
            Assert.Equal("2026-10-26", current.RootElement.GetProperty("secondary").GetProperty("date").GetString());
            Assert.Equal(0, current.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(1, current.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        }

        using var recreated = new AgendaHttp("2026-10-24T07:30:00Z", "", timeout: true, cacheDirectory: storage.Path);
        using var stale = await recreated.Poll();
        var body = stale.RootElement;
        Assert.Equal("stale", body.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-24T06:45:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        foreach (var (day, date, title, start) in new[]
        {
            ("primary", "2026-10-26", "Detached Monday planning", "2026-10-26T16:00:00Z"),
            ("secondary", "2026-10-27", "Detached Tuesday planning", "2026-10-27T16:00:00Z")
        })
        {
            var selected = body.GetProperty(day);
            Assert.Equal(date, selected.GetProperty("date").GetString());
            Assert.Equal(1, selected.GetProperty("eligible_total").GetInt32());
            var occurrence = Assert.Single(selected.GetProperty("occurrences").EnumerateArray());
            Assert.Equal(title, occurrence.GetProperty("title").GetString());
            Assert.Equal(DateTimeOffset.Parse(start), occurrence.GetProperty("start_at").GetDateTimeOffset());
        }
    }

    [Fact]
    public async Task Production_view_renders_detached_rule_edits_and_persisted_fallback_without_renewing_success()
    {
        var ics = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000Z\n"
            + "DTEND:20261019T180000Z\nSUMMARY:OOF detached planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID:20261019T170000Z\nDTSTART:20261019T190000Z\nDURATION:PT1H\n"
                + "SUMMARY:Proofreading detached session\nDESCRIPTION:CONFIDENTIAL_DESCRIPTION\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:detached-day@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID;VALUE=DATE:20261018\nDTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\n"
                + "SUMMARY:Detached workshop\nEND:VEVENT\nEND:VCALENDAR");
        const string excludeOof = """[{"field":"title","mode":"whole_word","value":"OOF"}]""";
        const string excludeProofreading = """[{"field":"title","mode":"starts_with","value":"Proofreading"}]""";
        using var storage = new CacheDirectory();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        var view = new AdaptiveDisplayTests.NativeView("og", "full", 800, 480, 1, 780, 460);
        using (var first = new AgendaHttp("2026-10-19T16:30:00Z", ics, cacheDirectory: storage.Path))
        {
            using var current = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
            Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
            Assert.Equal(2, current.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.DoesNotContain("OOF", current.RootElement.GetRawText());
            await Show(current.RootElement, "current", "Oct 19, 2026, 9:30 AM PDT",
                "2 eligible events", "0 eligible events", "Detached workshop", "All day",
                "Proofreading detached session", "12:00 PM - 1:00 PM");

            first.Clock.Advance(TimeSpan.FromMinutes(5));
            using var edited = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeProofreading }));
            Assert.Equal("current", edited.RootElement.GetProperty("state").GetString());
            Assert.Equal(2, edited.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.DoesNotContain("Proofreading", edited.RootElement.GetRawText());
            await Show(edited.RootElement, "edited", "Oct 19, 2026, 9:30 AM PDT",
                "2 eligible events", "0 eligible events", "Detached workshop", "All day",
                "OOF detached planning", "10:00 AM - 11:00 AM");
        }

        var unsupported = CalendarWithEvent("RECURRENCE-ID:20261019T160000Z\nDTSTART:20261019T170000Z\n"
            + "DTEND:20261019T180000Z\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Unsupported replacement");
        using var recreated = new AgendaHttp("2026-10-19T16:50:00Z", unsupported, cacheDirectory: storage.Path);
        using var stale = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = "[]" }));
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", stale.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(3, stale.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(["Detached workshop", "OOF detached planning", "Proofreading detached session"],
            stale.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray()
                .Select(item => item.GetProperty("title").GetString()));
        await Show(stale.RootElement, "stale", "Oct 19, 2026, 9:30 AM PDT",
            "3 eligible events", "0 eligible events", "Stale agenda", "Detached workshop", "All day",
            "A detached recurring change must specify a single complete occurrence.");

        recreated.Clock.Advance(TimeSpan.FromMinutes(40) - TimeSpan.FromTicks(1));
        using var beforeExpiry = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
        Assert.Equal("stale", beforeExpiry.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, beforeExpiry.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("OOF", beforeExpiry.RootElement.GetRawText());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T16:30:00Z"),
            beforeExpiry.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        recreated.Clock.Advance(TimeSpan.FromTicks(1));
        using var expired = await recreated.Poll();
        var error = expired.RootElement;
        Assert.Equal("error", error.GetProperty("state").GetString());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, error.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(error.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        await Show(error, "expired", "Oct 19, 2026, 9:30 AM PDT",
            "Agenda unavailable", "Compatibility error", "compatibility_unsupported",
            "A detached recurring change must specify a single complete occurrence.");
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());

        async Task Show(JsonElement body, string name, string sourceLabel, params string[] text)
        {
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
            Assert.DoesNotContain("Unsupported replacement", body.GetRawText());
            await DisplayTests.Show(page, body);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var required = text.Concat(new[] { "Source checked:", sourceLabel })
                .Select(value => page.GetByText(value, new() { Exact = true })).ToList();
            if (body.GetProperty("state").GetString() != "error")
            {
                required.Add(page.GetByText("Monday, Oct 19", new() { Exact = true }));
                required.Add(page.GetByText("Tuesday, Oct 20", new() { Exact = true }));
            }
            await Assertions.Expect(page.Locator("[data-agenda-source]"))
                .ToHaveAttributeAsync("datetime", body.GetProperty("source_succeeded_at").GetString()!);
            await AdaptiveDisplayTests.VisibleInk(page, $"detached-og-full-{name}", view, required);
            var rendered = await page.Locator("body").InnerTextAsync();
            Assert.DoesNotContain("9:00 AM -", rendered);
            Assert.DoesNotContain("12:00 AM", rendered);
            Assert.DoesNotContain("CONFIDENTIAL", rendered);
        }
    }
}
