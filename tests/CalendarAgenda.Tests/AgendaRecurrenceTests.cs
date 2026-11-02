using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Fact]
    public async Task Out_of_window_all_day_commitments_do_not_hide_an_eligible_UTC_evening_meeting()
    {
        var ics = CalendarWithEvent("DTSTART:20261021T020000Z\nDTEND:20261021T030000Z\nSUMMARY:Evening planning");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var meetingOnly = await agenda.Poll();
        Assert.Equal(1, meetingOnly.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());

        agenda.SetSource(ics.Replace("END:VCALENDAR",
            "BEGIN:VEVENT\nUID:future-all-day@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + "DTSTART;VALUE=DATE:20261021\nDTEND;VALUE=DATE:20261022\n"
            + "SUMMARY:Future all-day commitment\nEND:VEVENT\nEND:VCALENDAR"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal("2026-10-19", body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal("2026-10-20", body.GetProperty("secondary").GetProperty("date").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Evening planning", occurrence.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T02:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T03:00:00Z"), occurrence.GetProperty("end_at").GetDateTimeOffset());
        Assert.DoesNotContain("Future all-day commitment", body.GetRawText());

        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, body);

        await Assertions.Expect(page.GetByText("Monday, Oct 19", new() { Exact = true })).ToBeVisibleAsync();
        var secondary = page.Locator(".agenda-secondary");
        await Assertions.Expect(secondary.GetByText("Tuesday, Oct 20", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(secondary.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(secondary.GetByText("Evening planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(secondary.GetByText("7:00 PM - 8:00 PM", new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("Future all-day commitment", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, secondary);
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task Recurring_overrides_remain_unknown_until_source_evidence_is_accepted()
    {
        var calendar = CalendarWithEvent(
            "DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nRRULE:FREQ=DAILY;COUNT=2\n"
            + "ATTENDEE;PARTSTAT=ACCEPTED:mailto:owner@example.invalid\nSUMMARY:Series meeting")
            .Replace("END:VCALENDAR",
                "BEGIN:VEVENT\nUID:event@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
                + "RECURRENCE-ID:20261020T190000Z\nDTSTART:20261020T190000Z\nDTEND:20261020T200000Z\n"
                + "ATTENDEE;PARTSTAT=TENTATIVE:mailto:owner@example.invalid\nSUMMARY:Changed occurrence\n"
                + "END:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", calendar,
            runtimeSettings: new Dictionary<string, string?>
            {
                ["Agenda:OwnerAddress"] = "mailto:owner@example.invalid"
            });
        using var result = await agenda.Poll();

        var primary = Assert.Single(result.RootElement.GetProperty("primary")
            .GetProperty("occurrences").EnumerateArray());
        var secondary = Assert.Single(result.RootElement.GetProperty("secondary")
            .GetProperty("occurrences").EnumerateArray());
        Assert.Equal("unknown", primary.GetProperty("participation_expectation").GetString());
        Assert.Equal("unknown", secondary.GetProperty("participation_expectation").GetString());
        Assert.Equal("Changed occurrence", secondary.GetProperty("title").GetString());
        Assert.DoesNotContain("owner@example.invalid", result.RootElement.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("DTSTART:20261021T020000Z\nDTEND:20261021T030000Z")]
    [InlineData("DTSTART;TZID=Asia/Tokyo:20261021T110000\nDTEND;TZID=Asia/Tokyo:20261021T120000")]
    public async Task An_unbounded_all_day_series_does_not_hide_a_secondary_day_evening_meeting(string meetingTimes)
    {
        var ics = CalendarWithEvent($"{meetingTimes}\nSUMMARY:Evening planning").Replace("END:VCALENDAR",
            "BEGIN:VEVENT\nUID:daily-all-day@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + "DTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nRRULE:FREQ=DAILY\n"
            + "SUMMARY:Daily all-day commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;
        var secondary = body.GetProperty("secondary");

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal("2026-10-19", body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal("2026-10-20", secondary.GetProperty("date").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(2, secondary.GetProperty("eligible_total").GetInt32());
        var occurrences = secondary.GetProperty("occurrences").EnumerateArray().ToArray();
        Assert.Equal(["Daily all-day commitment", "Evening planning"],
            occurrences.Select(item => item.GetProperty("title").GetString()));
        Assert.Equal("all_day", occurrences[0].GetProperty("time_kind").GetString());
        Assert.Equal("2026-10-20", occurrences[0].GetProperty("start_date").GetString());
        Assert.Equal("2026-10-21", occurrences[0].GetProperty("end_date_exclusive").GetString());
        Assert.False(occurrences[0].TryGetProperty("start_at", out _));
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T02:00:00Z"), occurrences[1].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T03:00:00Z"), occurrences[1].GetProperty("end_at").GetDateTimeOffset());

        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, body);

        var secondaryView = page.Locator(".agenda-secondary");
        foreach (var text in new[] { "Tuesday, Oct 20", "2 events", "Daily all-day commitment",
            "All day", "Evening planning", "7:00 PM - 8:00 PM" })
            await Assertions.Expect(secondaryView.GetByText(text, new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("12:00 AM", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, secondaryView);
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task Mixed_source_time_zones_cannot_end_evaluation_before_an_eligible_meeting()
    {
        var ics = CalendarWithEvent("DTSTART;TZID=Asia/Tokyo:20261021T170000\n"
            + "DTEND;TZID=Asia/Tokyo:20261021T180000\nSUMMARY:Next-day Tokyo meeting")
            .Replace("END:VCALENDAR", string.Concat(new[]
            {
                "DTSTART;TZID=Asia/Tokyo:20261021T190000\nDTEND;TZID=Asia/Tokyo:20261021T200000\nSUMMARY:Later Tokyo meeting",
                "DTSTART;TZID=Pacific/Honolulu:20261020T230000\nDTEND;TZID=Pacific/Honolulu:20261021T000000\nSUMMARY:Wednesday Honolulu meeting",
                "DTSTART;VALUE=DATE:20261021\nDTEND;VALUE=DATE:20261022\nSUMMARY:Future all-day commitment",
                "DTSTART;TZID=Asia/Tokyo:20261021T110000\nDTEND;TZID=Asia/Tokyo:20261021T120000\nSUMMARY:Evening planning"
            }.Select((properties, index) => $"BEGIN:VEVENT\nUID:mixed-{index}@synthetic.invalid\n"
                + $"DTSTAMP:20261018T120000Z\n{properties}\nEND:VEVENT\n")) + "END:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Evening planning", occurrence.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T02:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
    }

    [Fact]
    public async Task Exclusions_apply_to_resolved_override_and_all_day_titles_not_series_definitions()
    {
        var ics = Fixture("moved-occurrences.ics")
            .Replace("SUMMARY:Series planning", "SUMMARY:OOF series planning")
            .Replace("SUMMARY:Moved Monday planning", "SUMMARY:OOO moved planning")
            .Replace("END:VCALENDAR", "BEGIN:VEVENT\nUID:excluded-all-day@synthetic.invalid\n"
                + "DTSTAMP:20261018T120000Z\nDTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261021\n"
                + "SUMMARY:OOF all-day commitment\nEND:VEVENT\nEND:VCALENDAR");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        var request = DisplayTests.Render("polling-body", new
        {
            rules_json = """[{"field":"title","mode":"whole_word","value":"OOF"},{"field":"title","mode":"whole_word","value":"OOO"}]"""
        });
        using var result = await agenda.Poll(request);
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var retained = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Moved Wednesday planning", retained.GetProperty("title").GetString());
        Assert.DoesNotContain("OOF", body.GetRawText());
        Assert.DoesNotContain("OOO", body.GetRawText());
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, body);

        await Assertions.Expect(page.GetByText("Moved Wednesday planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("1:30 PM - 2:15 PM", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No remaining events", new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("OOF", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-secondary"));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));

        using var cleared = await agenda.Poll();
        Assert.Equal(2, cleared.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(3, cleared.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
    }

    [Fact]
    public async Task Recurrence_date_periods_keep_their_own_duration_and_Outlook_date_only_exclusions()
    {
        var ics = CalendarWithEvent("DTSTART:20261016T190000Z\nDTEND:20261016T200000Z\n"
            + "RDATE;VALUE=PERIOD:20261019T190000Z/20261019T203000Z,20261020T190000Z/PT2H\n"
            + "EXDATE;VALUE=DATE:20261019\nSUMMARY:Synthetic explicit recurrence period");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T19:00:00Z"), occurrence.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T21:00:00Z"), occurrence.GetProperty("end_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("DTEND:not-a-date")]
    [InlineData("DURATION:not-a-duration")]
    public async Task Invalid_all_day_end_metadata_is_not_an_implicit_successful_one_day_event(string property)
    {
        var ics = CalendarWithEvent($"DTSTART;VALUE=DATE:20261019\n{property}\nSUMMARY:Synthetic invalid all-day end");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("source_invalid", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
    }

    [Theory]
    [InlineData("moved-occurrences.ics", "1 event", "2 events",
        "Moved Wednesday planning", "1:30 PM - 2:15 PM")]
    [InlineData("cancelled-overrides.ics", "No remaining events", "1 event",
        "No remaining events", null)]
    public async Task Production_OG_renders_resolved_moves_and_cancellations_from_HTTP(
        string fixture, string primaryCount, string secondaryCount, string primaryText, string? time)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture(fixture));
        using var result = await agenda.Poll();
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, result.RootElement);

        await Assertions.Expect(page.GetByText("Monday, Oct 19", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Tuesday, Oct 20", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(primaryCount, new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(secondaryCount, new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(primaryText, new() { Exact = true })).ToBeVisibleAsync();
        if (time is not null)
            await Assertions.Expect(page.GetByText(time, new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("Cancelled planning", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, page.GetByText(primaryText, new() { Exact = true }));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-secondary"));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Theory]
    [InlineData("RECURRENCE-ID;RANGE=THISANDPRIOR;TZID=Pacific Standard Time:20261019T120000")]
    [InlineData("RECURRENCE-ID:20261019T120000")]
    [InlineData("RECURRENCE-ID;TZID=Unverified/Secret:20261019T120000")]
    [InlineData("RECURRENCE-ID;VALUE=DATE:20261019")]
    public async Task Unsupported_override_metadata_cannot_produce_a_guessed_or_duplicate_agenda(string property)
    {
        var ics = Fixture("moved-occurrences.ics")
            .Replace("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T120000", property);
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("Secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("RRULE:FREQ=NOT_A_FREQUENCY")]
    [InlineData("RRULE:FREQ=DAILY;COUNT=0")]
    [InlineData("RRULE:FREQ=DAILY;INTERVAL=0")]
    [InlineData("RDATE:not-a-date")]
    [InlineData("EXDATE:not-a-date")]
    [InlineData("RECURRENCE-ID:not-a-date")]
    public async Task Invalid_recurrence_data_never_marks_the_source_successful(string property)
    {
        var ics = CalendarWithEvent("DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\n"
            + $"SUMMARY:Synthetic invalid recurrence\n{property}");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("Synthetic invalid recurrence", body.GetRawText());
    }

    [Theory]
    [InlineData("moved-occurrences.ics", 1, 2)]
    [InlineData("cancelled-overrides.ics", 0, 1)]
    public async Task Equivalent_UTC_recurrence_ids_replace_local_instances_without_reviving_originals(
        string fixture, int primaryTotal, int secondaryTotal)
    {
        var ics = Fixture(fixture).Replace("RECURRENCE-ID;TZID=Pacific Standard Time:20261019T120000",
            "RECURRENCE-ID:20261019T190000Z");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(primaryTotal, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(secondaryTotal, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
    }

    [Theory]
    [InlineData("RDATE:20261020T140000")]
    [InlineData("EXDATE:20261020T120000")]
    [InlineData("RDATE;TZID=Unverified/Secret:20261020T140000")]
    [InlineData("EXDATE;TZID=Unverified/Secret:20261020T120000")]
    public async Task Floating_or_unknown_recurrence_dates_are_explicit_compatibility_errors(string property)
    {
        var ics = CalendarWithEvent("DTSTART;TZID=Pacific Standard Time:20261019T120000\n"
            + "DTEND;TZID=Pacific Standard Time:20261019T130000\nRRULE:FREQ=DAILY;COUNT=2\n"
            + $"{property}\nSUMMARY:Synthetic recurring planning");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("Secret", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Recurring_all_day_overrides_keep_implicit_single_day_ends_and_exclusions()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("recurring-all-day.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var occurrence = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Moved all-day commitment", occurrence.GetProperty("title").GetString());
        Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
        Assert.Equal("2026-10-20", occurrence.GetProperty("start_date").GetString());
        Assert.Equal("2026-10-21", occurrence.GetProperty("end_date_exclusive").GetString());
        Assert.False(occurrence.TryGetProperty("start_at", out _));
    }

    [Fact]
    public async Task Parsed_this_and_future_is_a_visible_compatibility_error_without_source_success()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("this-and-future.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("compatibility_unsupported", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("RANGE=THISANDFUTURE", body.GetProperty("error").GetProperty("message").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("synthetic.invalid", body.GetRawText());
        Assert.DoesNotContain("Synthetic future shift", body.GetRawText());
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, body);

        await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("compatibility_unsupported", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(body.GetProperty("error").GetProperty("message").GetString()!,
            new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No successful source check", new() { Exact = true })).ToBeVisibleAsync();
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Theory]
    [InlineData("2026-03-06T16:00:00Z", "2026-03-06", "2026-03-09",
        "2026-03-06T17:00:00Z", "2026-03-09T16:00:00Z", "Monday, Mar 9", "Mar 6, 2026, 8:00 AM PST")]
    [InlineData("2026-10-30T15:00:00Z", "2026-10-30", "2026-11-02",
        "2026-10-30T16:00:00Z", "2026-11-02T17:00:00Z", "Monday, Nov 2", "Oct 30, 2026, 8:00 AM PDT")]
    public async Task Outlook_recurring_commitments_follow_both_Los_Angeles_DST_transitions(
        string now, string primaryDate, string secondaryDate, string primaryStart, string secondaryStart,
        string secondaryLabel, string sourceLabel)
    {
        using var agenda = new AgendaHttp(now, Fixture("outlook-dst.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(primaryDate, body.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal(secondaryDate, body.GetProperty("secondary").GetProperty("date").GetString());
        foreach (var (day, expectedStart) in new[] { ("primary", primaryStart), ("secondary", secondaryStart) })
        {
            Assert.Equal(2, body.GetProperty(day).GetProperty("eligible_total").GetInt32());
            var occurrences = body.GetProperty(day).GetProperty("occurrences").EnumerateArray().ToArray();
            Assert.Equal(2, occurrences.Length);
            Assert.Equal(2, occurrences.Select(item => item.GetProperty("id").GetString()).Distinct().Count());
            Assert.All(occurrences, item =>
                Assert.Equal(DateTimeOffset.Parse(expectedStart), item.GetProperty("start_at").GetDateTimeOffset()));
        }
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, body);

        var primary = page.Locator(".agenda-primary");
        await Assertions.Expect(primary.GetByText("9:00 AM - 10:00 AM", new() { Exact = true })).ToHaveCountAsync(2);
        await Assertions.Expect(primary.GetByText("Pacific recurring planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(primary.GetByText("Eastern recurring planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText(secondaryLabel, new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("2 events", new() { Exact = true })).ToHaveCountAsync(2);
        await Assertions.Expect(page.GetByText(sourceLabel, new() { Exact = true })).ToBeVisibleAsync();
        await DisplayTests.InsideScreen(page, primary.GetByText("9:00 AM - 10:00 AM", new() { Exact = true }).Last);
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-secondary"));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task Cancelled_series_do_not_restore_individual_overrides()
    {
        var ics = Fixture("moved-occurrences.ics").Replace("RRULE:FREQ=DAILY;COUNT=7",
            "RRULE:FREQ=DAILY;COUNT=7\nSTATUS:CANCELLED");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Empty(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
    }

    [Fact]
    public async Task Cancelled_overrides_suppress_originals_even_without_their_own_start_and_end()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("cancelled-overrides.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var retained = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Independent commitment", retained.GetProperty("title").GetString());
        Assert.DoesNotContain("Cancelled planning", body.GetRawText());
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
    }

    [Fact]
    public async Task Moved_occurrences_replace_originals_and_can_cross_the_selected_window()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("moved-occurrences.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(2, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var primary = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        var secondary = body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray().ToArray();
        Assert.Equal("Moved Wednesday planning", primary.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T20:30:00Z"), primary.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(["Series planning", "Moved Monday planning"],
            secondary.Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T19:00:00Z"), secondary[0].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T21:30:00Z"), secondary[1].GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T22:15:00Z"), secondary[1].GetProperty("end_at").GetDateTimeOffset());
    }

    [Fact]
    public async Task Production_OG_renders_HTTP_all_day_commitments_without_midnight_times()
    {
        using var agenda = new AgendaHttp("2026-10-20T02:00:00Z", Fixture("all-day.ics"));
        using var result = await agenda.Poll();
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, result.RootElement);

        var primary = page.Locator(".agenda-primary");
        await Assertions.Expect(page.GetByText("Monday, Oct 19", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Tuesday, Oct 20", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("2 events", new() { Exact = true })).ToHaveCountAsync(2);
        await Assertions.Expect(primary.GetByText("Multiday workshop", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(primary.GetByText("Monday commitment", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(primary.GetByText("All day", new() { Exact = true })).ToHaveCountAsync(2);
        Assert.DoesNotContain("12:00 AM", await page.Locator("body").InnerTextAsync());
        Assert.Equal(0, await page.Locator("[data-agenda-start]").CountAsync());
        await DisplayTests.InsideScreen(page, primary.GetByText("All day", new() { Exact = true }).Last);
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-secondary"));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
    }

    [Fact]
    public async Task Recurring_commitments_expand_rules_dates_and_exclusions_before_counting()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("recurring.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var primary = Assert.Single(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        var secondary = Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Recurring planning", primary.GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:30:00Z"), primary.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:30:00Z"), primary.GetProperty("end_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T21:00:00Z"), secondary.GetProperty("start_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T22:00:00Z"), secondary.GetProperty("end_at").GetDateTimeOffset());
        Assert.NotEqual(primary.GetProperty("id").GetString(), secondary.GetProperty("id").GetString());
    }

    [Fact]
    public async Task All_day_commitments_keep_date_only_ranges_and_exclusive_end_dates()
    {
        using var agenda = new AgendaHttp("2026-10-20T02:00:00Z", Fixture("all-day.ics"));
        using var result = await agenda.Poll();
        var body = result.RootElement;
        var primary = body.GetProperty("primary");
        var secondary = body.GetProperty("secondary");

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal("2026-10-19", primary.GetProperty("date").GetString());
        Assert.Equal("2026-10-20", secondary.GetProperty("date").GetString());
        Assert.Equal(2, primary.GetProperty("eligible_total").GetInt32());
        Assert.Equal(2, secondary.GetProperty("eligible_total").GetInt32());
        Assert.Equal(["Multiday workshop", "Monday commitment"],
            primary.GetProperty("occurrences").EnumerateArray().Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(["Multiday workshop", "Tuesday commitment"],
            secondary.GetProperty("occurrences").EnumerateArray().Select(item => item.GetProperty("title").GetString()));
        var multiday = primary.GetProperty("occurrences")[0];
        Assert.Equal("all_day", multiday.GetProperty("time_kind").GetString());
        Assert.Equal("2026-10-16", multiday.GetProperty("start_date").GetString());
        Assert.Equal("2026-10-21", multiday.GetProperty("end_date_exclusive").GetString());
        Assert.Equal(multiday.GetProperty("id").GetString(),
            secondary.GetProperty("occurrences")[0].GetProperty("id").GetString());
        Assert.All(primary.GetProperty("occurrences").EnumerateArray(), item =>
        {
            Assert.False(item.TryGetProperty("start_at", out _));
            Assert.False(item.TryGetProperty("end_at", out _));
        });
        Assert.DoesNotContain("Ended all-day commitment", body.GetRawText());
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
    }
}
