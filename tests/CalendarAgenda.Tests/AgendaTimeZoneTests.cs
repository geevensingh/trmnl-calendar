using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Fact]
    public async Task Current_Windows_mappings_use_maintained_zone_rules_instead_of_rejecting_a_published_meeting()
    {
        var ics = CalendarWithEvent("DTSTART;TZID=British Columbia Standard Time:20261102T090000\n"
            + "DTEND;TZID=British Columbia Standard Time:20261102T100000\nSUMMARY:Pacific planning");
        using var agenda = new AgendaHttp("2026-11-02T15:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T15:00:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Pacific planning", occurrence.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T16:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T17:00:00Z"), occurrence.GetProperty("end_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("British Columbia Standard Time", "20260306", "2026-03-06T17:00:00Z", "2026-03-06T18:00:00Z")]
    [InlineData("Alberta Standard Time", "20260306", "2026-03-06T16:00:00Z", "2026-03-06T17:00:00Z")]
    [InlineData("Manitoba Standard Time", "20260306", "2026-03-06T15:00:00Z", "2026-03-06T16:00:00Z")]
    [InlineData("British Columbia Standard Time", "20260309", "2026-03-09T16:00:00Z", "2026-03-09T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20260309", "2026-03-09T15:00:00Z", "2026-03-09T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20260309", "2026-03-09T14:00:00Z", "2026-03-09T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20260706", "2026-07-06T16:00:00Z", "2026-07-06T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20260706", "2026-07-06T15:00:00Z", "2026-07-06T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20260706", "2026-07-06T14:00:00Z", "2026-07-06T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20261030", "2026-10-30T16:00:00Z", "2026-10-30T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20261030", "2026-10-30T15:00:00Z", "2026-10-30T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20261030", "2026-10-30T14:00:00Z", "2026-10-30T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20261102", "2026-11-02T16:00:00Z", "2026-11-02T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20261102", "2026-11-02T15:00:00Z", "2026-11-02T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20261102", "2026-11-02T14:00:00Z", "2026-11-02T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20270111", "2027-01-11T16:00:00Z", "2027-01-11T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20270111", "2027-01-11T15:00:00Z", "2027-01-11T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20270111", "2027-01-11T14:00:00Z", "2027-01-11T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20270705", "2027-07-05T16:00:00Z", "2027-07-05T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20270705", "2027-07-05T15:00:00Z", "2027-07-05T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20270705", "2027-07-05T14:00:00Z", "2027-07-05T15:00:00Z")]
    [InlineData("British Columbia Standard Time", "20300107", "2030-01-07T16:00:00Z", "2030-01-07T17:00:00Z")]
    [InlineData("Alberta Standard Time", "20300107", "2030-01-07T15:00:00Z", "2030-01-07T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "20300107", "2030-01-07T14:00:00Z", "2030-01-07T15:00:00Z")]
    public async Task Maintained_time_zones_follow_historical_transitions_and_future_permanent_rules(
        string zone, string date, string expectedStart, string expectedEnd)
    {
        var day = DateOnly.ParseExact(date, "yyyyMMdd");
        var ics = CalendarWithEvent($"DTSTART;TZID={zone}:{date}T090000\nDURATION:PT1H\nSUMMARY:Published planning");
        using var agenda = new AgendaHttp($"{day:yyyy-MM-dd}T12:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(DateTimeOffset.Parse(expectedStart), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse(expectedEnd), occurrence.GetProperty("end_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("British Columbia Standard Time", "20261102T160000Z", "2026-11-02T18:00:00Z", "2026-11-02T18:45:00Z")]
    [InlineData("Alberta Standard Time", "20261102T150000Z", "2026-11-02T17:00:00Z", "2026-11-02T17:45:00Z")]
    [InlineData("Manitoba Standard Time", "20261102T140000Z", "2026-11-02T16:00:00Z", "2026-11-02T16:45:00Z")]
    public async Task Maintained_time_zones_resolve_recurring_moves_and_startless_cancellations_across_November(
        string zone, string originalInstant, string expectedStart, string expectedEnd)
    {
        var ics = CalendarWithEvent($"DTSTART;TZID={zone}:20261030T090000\nDURATION:PT1H\n"
            + "RRULE:FREQ=DAILY;COUNT=5\nSUMMARY:Original recurring planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID;TZID={zone}:20261030T090000\nSTATUS:CANCELLED\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID:{originalInstant}\nDTSTART;TZID={zone}:20261102T110000\n"
                + "DURATION:PT45M\nSUMMARY:Moved recurring planning\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-30T12:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal("2026-10-30", body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal("2026-11-02", body.GetProperty("secondary").GetProperty("date").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var moved = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Moved recurring planning", moved.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse(expectedStart), moved.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse(expectedEnd), moved.GetProperty("end_at").GetDateTimeOffset());
        Assert.DoesNotContain("Original", body.GetRawText());
    }

    [Theory]
    [InlineData("RECURRENCE-ID:20261102T160000Z", false)]
    [InlineData("RECURRENCE-ID;TZID=America/Vancouver:20261102T090000", false)]
    [InlineData("RECURRENCE-ID:20261102T160000Z", true)]
    [InlineData("RECURRENCE-ID;TZID=America/Vancouver:20261102T090000", true)]
    public async Task Maintained_time_zones_reject_canonical_duplicate_attached_and_detached_identifiers(
        string duplicateIdentifier, bool detached)
    {
        var ics = CalendarWithEvent("DTSTART;TZID=British Columbia Standard Time:20261102T090000\n"
            + "DURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:Original planning");
        var changes = "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + "RECURRENCE-ID;TZID=British Columbia Standard Time:20261102T090000\n"
            + "DTSTART;TZID=British Columbia Standard Time:20261102T100000\nDURATION:PT1H\n"
            + "SUMMARY:First revision\nEND:VEVENT\n"
            + "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + $"{duplicateIdentifier}\nDTSTART;TZID=British Columbia Standard Time:20261102T110000\n"
            + "DURATION:PT1H\nSUMMARY:Conflicting revision\nEND:VEVENT\n";
        ics = detached
            ? "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic time zones//EN\n" + changes + "END:VCALENDAR"
            : ics.Replace("END:VCALENDAR", changes + "END:VCALENDAR");
        using var agenda = new AgendaHttp("2026-11-02T12:00:00Z", ics);
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
    [InlineData("Unverified/SyntheticZone", false)]
    [InlineData("Not British Columbia Standard Time", false)]
    [InlineData("British Columbia Standard Time extra", false)]
    [InlineData(null, false)]
    [InlineData("Custom/SyntheticZone", true)]
    public async Task Maintained_time_zones_do_not_guess_unknown_floating_or_custom_VTIMEZONE_rules(
        string? zone, bool embedded)
    {
        var start = zone is null ? "DTSTART:20261102T090000" : $"DTSTART;TZID={zone}:20261102T090000";
        var ics = CalendarWithEvent($"{start}\nDURATION:PT1H\nSUMMARY:Unsupported planning");
        if (embedded)
            ics = ics.Replace("BEGIN:VEVENT", "BEGIN:VTIMEZONE\nTZID:Custom/SyntheticZone\n"
                + "BEGIN:STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0700\nTZOFFSETTO:-0800\n"
                + "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\n"
                + "BEGIN:DAYLIGHT\nDTSTART:20260308T020000\nTZOFFSETFROM:-0800\nTZOFFSETTO:-0700\n"
                + "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\nEND:VTIMEZONE\nBEGIN:VEVENT");
        using var agenda = new AgendaHttp("2026-11-02T12:00:00Z", ics);
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
        Assert.DoesNotContain("Unsupported planning", body.GetRawText());
        Assert.DoesNotContain("SyntheticZone", body.GetRawText());
    }

    [Fact]
    public async Task Maintained_time_zones_are_process_consistent_across_concurrent_windows_IANA_and_unknown_sources()
    {
        var cases = new[]
        {
            (Zone: "British Columbia Standard Time", Start: "2026-11-02T16:00:00Z"),
            (Zone: "Alberta Standard Time", Start: "2026-11-02T15:00:00Z"),
            (Zone: "Manitoba Standard Time", Start: "2026-11-02T14:00:00Z"),
            (Zone: "America/Vancouver", Start: "2026-11-02T16:00:00Z"),
            (Zone: "America/Los_Angeles", Start: "2026-11-02T17:00:00Z"),
            (Zone: "Pacific Standard Time", Start: "2026-11-02T17:00:00Z"),
            (Zone: "Mountain Standard Time", Start: "2026-11-02T16:00:00Z"),
            (Zone: "Central Standard Time", Start: "2026-11-02T15:00:00Z"),
            (Zone: "Unverified/SyntheticZone", Start: "")
        };
        await Task.WhenAll(Enumerable.Range(0, 3).SelectMany(round => cases.Select((item, index) => Task.Run(async () =>
        {
            var title = $"Published commitment {round}-{index}";
            var ics = CalendarWithEvent($"DTSTART;TZID={item.Zone}:20261102T090000\nDURATION:PT1H\nSUMMARY:{title}");
            using var agenda = new AgendaHttp("2026-11-02T12:00:00Z", ics,
                sourceUrl: $"https://synthetic.invalid/calendar-{round}-{index}.ics",
                sourceDelay: TimeSpan.FromMilliseconds(10));
            using var current = await agenda.Poll();
            var body = current.RootElement;
            if (item.Start.Length == 0)
            {
                Assert.Equal("error", body.GetProperty("state").GetString());
                Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
                Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
                Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
                return;
            }
            Assert.Equal("current", body.GetProperty("state").GetString());
            Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
            Assert.Equal(title, occurrence.GetProperty("title").GetString());
            Assert.Equal(DateTimeOffset.Parse(item.Start), occurrence.GetProperty("start_at").GetDateTimeOffset());

            agenda.Clock.Advance(TimeSpan.FromMinutes(15));
            agenda.SetSource(CalendarWithEvent("DTSTART;TZID=Unverified/SyntheticZone:20261102T090000\n"
                + "DURATION:PT1H\nSUMMARY:Rejected replacement"));
            using var stale = await agenda.Poll();
            Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-11-02T12:00:00Z"),
                stale.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            var retained = Assert.Single(stale.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
            Assert.Equal(title, retained.GetProperty("title").GetString());
            Assert.Equal(DateTimeOffset.Parse(item.Start), retained.GetProperty("start_at").GetDateTimeOffset());
            Assert.DoesNotContain("Rejected replacement", stale.RootElement.GetRawText());
        }))));
    }

    [Theory]
    [InlineData("British Columbia Standard Time", "2026-11-02T16:00:00Z", "2026-11-02T17:00:00Z")]
    [InlineData("Alberta Standard Time", "2026-11-02T15:00:00Z", "2026-11-02T16:00:00Z")]
    [InlineData("Manitoba Standard Time", "2026-11-02T14:00:00Z", "2026-11-02T15:00:00Z")]
    public async Task Maintained_time_zones_keep_detached_actual_times_without_inventing_originals(
        string zone, string expectedStart, string expectedEnd)
    {
        var ics = CalendarWithEvent($"RECURRENCE-ID;TZID={zone}:20261102T080000\n"
            + $"DTSTART;TZID={zone}:20261102T090000\nDURATION:PT1H\nSUMMARY:Detached planning");
        using var agenda = new AgendaHttp("2026-11-02T12:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Detached planning", occurrence.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse(expectedStart), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse(expectedEnd), occurrence.GetProperty("end_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("British Columbia Standard Time")]
    [InlineData("Alberta Standard Time")]
    [InlineData("Manitoba Standard Time")]
    public async Task Maintained_time_zones_preserve_attached_all_day_literal_midnight_replacement(string zone)
    {
        var ics = CalendarWithEvent("DTSTART;VALUE=DATE:20261102\nRRULE:FREQ=DAILY;COUNT=2\n"
            + "EXDATE;VALUE=DATE:20261103\nSUMMARY:Original all-day commitment")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + $"RECURRENCE-ID;TZID={zone}:20261102T000000\nDTSTART;VALUE=DATE:20261103\n"
                + "DTEND;VALUE=DATE:20261104\nSUMMARY:Moved all-day commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-11-02T12:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
        Assert.Equal("Moved all-day commitment", occurrence.GetProperty("title").GetString());
        Assert.Equal("2026-11-03", occurrence.GetProperty("start_date").GetString());
        Assert.Equal("2026-11-04", occurrence.GetProperty("end_date_exclusive").GetString());
        Assert.False(occurrence.TryGetProperty("start_at", out _));
        Assert.DoesNotContain("Original", body.GetRawText());
    }

    [Fact]
    public async Task Maintained_time_zones_keep_real_parser_rule_edits_persisted_fallback_and_native_rendering_consistent()
    {
        var ics = CalendarWithEvent("DTSTART;TZID=British Columbia Standard Time:20261102T090000\n"
            + "DURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=2\nSUMMARY:OOF original planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID:20261102T160000Z\nDTSTART;TZID=British Columbia Standard Time:20261102T100000\n"
                + "DURATION:PT1H\nSUMMARY:Proofreading moved planning\nDESCRIPTION:CONFIDENTIAL_DESCRIPTION\nEND:VEVENT\n"
                + "BEGIN:VEVENT\nUID:workshop@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "DTSTART;TZID=Alberta Standard Time:20261102T100000\nDURATION:PT1H\n"
                + "SUMMARY:OOF workshop\nEND:VEVENT\nEND:VCALENDAR");
        const string excludeOof = """[{"field":"title","mode":"whole_word","value":"OOF"}]""";
        const string excludeProofreading = """[{"field":"title","mode":"starts_with","value":"Proofreading"}]""";
        using var storage = new CacheDirectory();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        var view = new AdaptiveDisplayTests.NativeView("og", "full", 800, 480, 1, 780, 460);
        string? movedId;
        using (var first = new AgendaHttp("2026-11-02T15:00:00Z", ics, cacheDirectory: storage.Path))
        {
            using var current = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
            var body = current.RootElement;
            Assert.Equal("current", body.GetProperty("state").GetString());
            Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
            var moved = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
            movedId = moved.GetProperty("id").GetString();
            Assert.Equal(DateTimeOffset.Parse("2026-11-02T17:00:00Z"), moved.GetProperty("start_at").GetDateTimeOffset());
            Assert.Equal(DateTimeOffset.Parse("2026-11-02T18:00:00Z"), moved.GetProperty("end_at").GetDateTimeOffset());
            Assert.DoesNotContain("OOF", body.GetRawText());
            await Show(body, "current", "Nov 2, 2026, 7:00 AM PST",
                "1 eligible event", "0 eligible events", "Proofreading moved planning", "9:00 AM - 10:00 AM");

            first.Clock.Advance(TimeSpan.FromMinutes(5));
            using var edited = await first.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeProofreading }));
            Assert.Equal("current", edited.RootElement.GetProperty("state").GetString());
            Assert.Equal(1, edited.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(1, edited.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
            Assert.DoesNotContain("Proofreading", edited.RootElement.GetRawText());
            await Show(edited.RootElement, "edited", "Nov 2, 2026, 7:00 AM PST",
                "OOF workshop", "OOF original planning");
            await Assertions.Expect(page.GetByText("1 eligible event", new() { Exact = true })).ToHaveCountAsync(2);
            await Assertions.Expect(page.Locator(".agenda-primary").GetByText("8:00 AM - 9:00 AM",
                new() { Exact = true })).ToBeVisibleAsync();
        }

        var unsupported = ics.Replace("British Columbia Standard Time", "Not British Columbia Standard Time");
        using var recreated = new AgendaHttp("2026-11-02T15:20:00Z", unsupported, cacheDirectory: storage.Path);
        using var stale = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = excludeOof }));
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", stale.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(1, stale.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, stale.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(movedId, Assert.Single(stale.RootElement.GetProperty("primary").GetProperty("occurrences")
            .EnumerateArray()).GetProperty("id").GetString());
        await Show(stale.RootElement, "stale", "Nov 2, 2026, 7:00 AM PST",
            "1 eligible event", "0 eligible events", "Stale agenda", "Proofreading moved planning",
            "9:00 AM - 10:00 AM", "The source contains an unsupported time zone.");

        recreated.Clock.Advance(TimeSpan.FromMinutes(40) - TimeSpan.FromTicks(1));
        using var beforeExpiry = await recreated.Poll(DisplayTests.Render("polling-body", new { rules_json = "[]" }));
        Assert.Equal("stale", beforeExpiry.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, beforeExpiry.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, beforeExpiry.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(DateTimeOffset.Parse("2026-11-02T15:00:00Z"),
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
        await Show(error, "expired", "Nov 2, 2026, 7:00 AM PST",
            "Agenda unavailable", "Compatibility error", "compatibility_unsupported",
            "The source contains an unsupported time zone.");
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());

        async Task Show(JsonElement body, string name, string sourceLabel, params string[] text)
        {
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
            await DisplayTests.Show(page, body);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var required = text.Concat(new[] { "Source checked:", sourceLabel })
                .Select(value => page.GetByText(value, new() { Exact = true })).ToList();
            if (body.GetProperty("state").GetString() != "error")
            {
                required.Add(page.GetByText("Monday, Nov 2", new() { Exact = true }));
                required.Add(page.GetByText("Tuesday, Nov 3", new() { Exact = true }));
                required.AddRange(await page.Locator("[data-agenda-start]:visible").AllAsync());
            }
            await Assertions.Expect(page.Locator("[data-agenda-source]"))
                .ToHaveAttributeAsync("datetime", body.GetProperty("source_succeeded_at").GetString()!);
            await AdaptiveDisplayTests.VisibleInk(page, $"timezone-og-full-{name}", view, required);
            Assert.DoesNotContain("CONFIDENTIAL", await page.Locator("body").InnerTextAsync());
        }
    }
}
