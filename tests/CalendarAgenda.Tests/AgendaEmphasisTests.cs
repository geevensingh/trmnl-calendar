using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using Xunit;
using NativeView = CalendarAgenda.Tests.AdaptiveDisplayTests.NativeView;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Theory]
    [InlineData("2026-10-19T18:15:00Z", "in_progress")]
    [InlineData("2026-10-19T18:00:00Z", "upcoming")]
    public async Task Http_response_bounds_preserve_emphasis_ahead_of_all_day_volume_and_complete_totals(
        string now, string emphasis)
    {
        var events = Enumerable.Range(0, 100).Select(index =>
            $"DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:Ordinary {index:D3} {new string('W', 1000)}")
            .Concat([
                "DTSTART:20261019T181500Z\nDTEND:20261019T190000Z\nSUMMARY:Priority meeting\nLOCATION:Studio A",
                "DTSTART:20261020T180000Z\nDTEND:20261020T190000Z\nSUMMARY:Secondary meeting"
            ]).ToArray();
        using var agenda = new AgendaHttp(now, CalendarWithEvents(events));
        using var result = await agenda.Poll();
        var body = result.RootElement;
        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.InRange(Encoding.UTF8.GetByteCount(body.GetRawText()), 1, 95_000);
        Assert.Equal(101, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        var supplied = PrimaryOccurrences(result);
        Assert.InRange(supplied.Length, 2, 100);
        Assert.Equal(emphasis, Emphasis(Assert.Single(supplied, item => Title(item) == "Priority meeting")));
        Assert.Equal("Priority meeting", Title(supplied[^1]));
        Assert.Equal(supplied.Length, supplied.Select(item => item.GetProperty("id").GetString()).Distinct().Count());
        Assert.All(supplied.Where(item => item.GetProperty("time_kind").GetString() == "all_day"),
            item => Assert.Equal(1013, Title(item).Length));
        Assert.Equal(1, agenda.SourceRequests);
    }

    [Theory]
    [InlineData("2026-10-19T18:00:00Z", "upcoming")]
    [InlineData("2026-10-19T18:18:00Z", "in_progress")]
    public async Task Http_emphasized_response_overflow_preserves_a_chronological_prefix_without_ordinary_competitors(
        string now, string emphasis)
    {
        var events = EmphasizedOverflowEvents(emphasis == "in_progress");
        using var agenda = new AgendaHttp(now, CalendarWithEvents(events));
        using var complete = await agenda.Poll();
        var expectedIds = PrimaryOccurrences(complete).Where(item => Emphasis(item) == emphasis)
            .Select(item => item.GetProperty("id").GetString()).ToArray();
        Assert.Equal(100, expectedIds.Length);
        agenda.SetSource(CalendarWithEvents(events.Select(item =>
            item.Replace("SUMMARY:Card ", $"SUMMARY:{new string('界', 300)} Card ")).ToArray()));
        using var bounded = await agenda.Poll();
        Assert.Equal("current", bounded.RootElement.GetProperty("state").GetString());
        var supplied = PrimaryOccurrences(bounded);
        Assert.InRange(supplied.Length, 1, 99);
        Assert.All(supplied, item => Assert.Equal(emphasis, Emphasis(item)));
        Assert.Equal(expectedIds.Take(supplied.Length), supplied.Select(item => item.GetProperty("id").GetString()));
        Assert.Equal(125, bounded.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.InRange(Encoding.UTF8.GetByteCount(bounded.RootElement.GetRawText()), 1, 95_000);
    }

    [Fact]
    public async Task Http_response_budget_includes_exact_serialized_envelope_escaping_and_both_day_arrays()
    {
        string Calendar(string padding) => CalendarWithEvents(
            $"DTSTART:20261019T170000Z\nDTEND:20261019T190000Z\nSUMMARY:Escaped 界 <title> {padding}",
            "DTSTART:20261019T180000Z\nDTEND:20261019T190000Z\nSUMMARY:Second ongoing",
            "DTSTART:20261020T180000Z\nDTEND:20261020T190000Z\nSUMMARY:Secondary ordinary");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Calendar(""));
        using var small = await agenda.Poll();
        var padding = new string('W', 95_000 - Encoding.UTF8.GetByteCount(small.RootElement.GetRawText()));
        agenda.SetSource(Calendar(padding));
        using var exact = await agenda.Poll();
        Assert.Equal(95_000, Encoding.UTF8.GetByteCount(exact.RootElement.GetRawText()));
        Assert.Equal(2, PrimaryOccurrences(exact).Length);
        Assert.Single(exact.RootElement.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
        agenda.SetSource(Calendar(padding + "W"));
        using var over = await agenda.Poll();
        Assert.Equal("current", over.RootElement.GetProperty("state").GetString());
        Assert.InRange(Encoding.UTF8.GetByteCount(over.RootElement.GetRawText()), 1, 95_000);
        Assert.Equal(2, PrimaryOccurrences(over).Length);
        Assert.All(PrimaryOccurrences(over), item => Assert.Equal("in_progress", Emphasis(item)));
        Assert.Equal(1, over.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(over.RootElement.GetProperty("secondary").GetProperty("occurrences").EnumerateArray());
    }

    [Fact]
    public async Task Http_an_unrepresentable_ongoing_card_still_suppresses_upcoming_and_reports_omissions()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithEvents(
            $"DTSTART:20261019T173000Z\nDTEND:20261019T190000Z\nSUMMARY:{new string('W', 100_000)}",
            "DTSTART:20261019T180500Z\nDTEND:20261019T190000Z\nSUMMARY:Next meeting"));
        using var result = await agenda.Poll();
        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Empty(PrimaryOccurrences(result));
        Assert.InRange(Encoding.UTF8.GetByteCount(result.RootElement.GetRawText()), 1, 95_000);
    }

    [Fact]
    public async Task Http_schema_two_mixed_occurrences_render_without_requiring_optional_emphasis()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithEvents(
            "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:All-day planning",
            "DTSTART:20261019T180000Z\nDTEND:20261019T190000Z\nSUMMARY:Current meeting",
            "DTSTART:20261019T200000Z\nDTEND:20261019T210000Z\nSUMMARY:Ordinary meeting"));
        using var current = await agenda.Poll();
        Assert.Equal(3, PrimaryOccurrences(current).Length);
        Assert.Equal(2, PrimaryOccurrences(current).Count(item => Emphasis(item) is null));
        foreach (var placement in new[] { "full", "half_horizontal", "half_vertical" })
        {
            var html = DisplayTests.Render(placement, current.RootElement);
            Assert.Contains("All-day planning", html);
            Assert.Contains("Ordinary meeting", html);
            Assert.Contains("data-agenda-emphasis=\"in_progress\"", html);
            Assert.Equal(2, html.Split("data-agenda-emphasis=").Length);
            Assert.Contains("IN PROGRESS", html);
        }
    }

    [Fact]
    public async Task Http_schema_two_emphasis_reaches_strict_production_Liquid_while_ordinary_schema_one_remains_supported()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithEvents(
            "DTSTART:20261019T180000Z\nDTEND:20261019T190000Z\nSUMMARY:Current <meeting>"));
        using var current = await agenda.Poll();
        var html = DisplayTests.Render("full", current.RootElement);
        Assert.Contains("data-agenda-emphasis=\"in_progress\"", html);
        Assert.Contains("IN PROGRESS", html);
        Assert.Contains("Current &lt;meeting&gt;", html);
        var ordinary = DisplayTests.CurrentAgenda();
        Assert.Equal(1, ordinary["schema_version"]!.GetValue<int>());
        var legacyHtml = DisplayTests.Render("full", ordinary);
        Assert.Contains("Synthetic planning", legacyHtml);
        Assert.DoesNotContain("data-agenda-emphasis=", legacyHtml);
        Assert.DoesNotContain("IN PROGRESS", legacyHtml);
        var invalid = JsonNode.Parse(current.RootElement.GetRawText())!.AsObject();
        invalid["schema_version"] = 1;
        Assert.Contains("Emphasis requires agenda schema 2.",
            Assert.ThrowsAny<Exception>(() => DisplayTests.Render("full", invalid)).Message);
        invalid["schema_version"] = 3;
        Assert.Contains("Unsupported agenda schema",
            Assert.ThrowsAny<Exception>(() => DisplayTests.Render("full", invalid)).Message);
    }

    [Fact]
    public async Task Http_agendas_explicitly_publish_schema_two_including_empty_and_error_results()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithEvents(
            "DTSTART:20261019T180000Z\nDTEND:20261019T190000Z\nSUMMARY:Current meeting"));
        using var current = await agenda.Poll();
        Assert.Equal(2, current.RootElement.GetProperty("schema_version").GetInt32());
        Assert.Equal("in_progress", Emphasis(Assert.Single(PrimaryOccurrences(current))));
        using var empty = await agenda.PollOnly(
            """{"rules_json":"[{\"field\":\"title\",\"mode\":\"contains\",\"value\":\"meeting\"}]"}""");
        Assert.Equal(2, empty.RootElement.GetProperty("schema_version").GetInt32());
        Assert.Empty(PrimaryOccurrences(empty));
        using var error = await agenda.PollOnly("{}");
        Assert.Equal(2, error.RootElement.GetProperty("schema_version").GetInt32());
        Assert.Equal("error", error.RootElement.GetProperty("state").GetString());
    }

    [Fact]
    public async Task Http_poll_classifies_all_ongoing_events_and_reselects_upcoming_at_exact_boundaries()
    {
        var ics = CalendarWithEvents(
            "DTSTART:20261019T173000Z\nDTEND:20261019T181000Z\nSUMMARY:Already underway",
            "DTSTART:20261019T180000Z\nDTEND:20261019T181000Z\nSUMMARY:Starts now",
            "DTSTART:20261019T170000Z\nDTEND:20261019T180000Z\nSUMMARY:Ends now",
            "DTSTART:20261019T181500Z\nDTEND:20261019T182500Z\nSUMMARY:Next meeting",
            "DTSTART:20261019T182000Z\nDTEND:20261019T182500Z\nSUMMARY:Later meeting",
            "DTSTART:20261019T183500Z\nDTEND:20261019T190000Z\nSUMMARY:After later meeting");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);

        using var atStart = await agenda.Poll();
        var occurrences = PrimaryOccurrences(atStart);
        Assert.Equal(["Already underway", "Starts now"],
            occurrences.Where(item => Emphasis(item) == "in_progress").Select(Title));
        Assert.DoesNotContain(occurrences, item => Title(item) == "Ends now");
        Assert.DoesNotContain(occurrences, item => Emphasis(item) == "upcoming");

        agenda.Clock.Advance(TimeSpan.FromMinutes(10));
        using var atEnd = await agenda.PollOnly();
        occurrences = PrimaryOccurrences(atEnd);
        Assert.DoesNotContain(occurrences, item => Title(item) is "Already underway" or "Starts now");
        Assert.Equal(["Next meeting"], occurrences.Where(item => Emphasis(item) == "upcoming").Select(Title));

        agenda.Clock.Advance(TimeSpan.FromMinutes(5));
        using var nextStarts = await agenda.PollOnly();
        occurrences = PrimaryOccurrences(nextStarts);
        Assert.Equal(["Next meeting"], occurrences.Where(item => Emphasis(item) == "in_progress").Select(Title));
        Assert.DoesNotContain(occurrences, item => Emphasis(item) == "upcoming");

        agenda.Clock.Advance(TimeSpan.FromMinutes(10));
        using var laterEnds = await agenda.PollOnly();
        occurrences = PrimaryOccurrences(laterEnds);
        Assert.DoesNotContain(occurrences, item => Title(item) == "Later meeting");
        Assert.Equal(["After later meeting"], occurrences.Where(item => Emphasis(item) == "upcoming").Select(Title));
    }

    [Fact]
    public async Task Upcoming_uses_an_inclusive_fifteen_minute_window_and_ignores_all_day_and_excluded_events()
    {
        var ics = CalendarWithEvents(
            "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:All-day planning",
            "DTSTART:20261019T170000Z\nDTEND:20261019T183000Z\nSUMMARY:OOO",
            "DTSTART:20261019T181500Z\nDTEND:20261019T190000Z\nSUMMARY:UTC meeting",
            "DTSTART;TZID=America/Los_Angeles:20261019T111500\nDTEND;TZID=America/Los_Angeles:20261019T120000\nSUMMARY:Local meeting",
            "DTSTART:20261019T182000Z\nDTEND:20261019T190000Z\nSUMMARY:Later meeting");
        using var agenda = new AgendaHttp("2026-10-19T17:59:59.9999999Z", ics);
        var excludeOoo = JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"whole_word","value":"OOO"}]"""
        });

        using var justOutside = await agenda.Poll(excludeOoo);
        Assert.Equal("current", justOutside.RootElement.GetProperty("state").GetString());
        var occurrences = PrimaryOccurrences(justOutside);
        Assert.DoesNotContain(occurrences, item => Emphasis(item) is "in_progress" or "upcoming");
        Assert.DoesNotContain(occurrences, item => Title(item) == "OOO");

        agenda.Clock.Advance(TimeSpan.FromTicks(1));
        using var atBoundary = await agenda.PollOnly(excludeOoo);
        occurrences = PrimaryOccurrences(atBoundary);
        Assert.Equal(new[] { "Local meeting", "UTC meeting" },
            occurrences.Where(item => Emphasis(item) == "upcoming").Select(Title).Order(StringComparer.Ordinal));
        Assert.Contains(occurrences, item => Title(item) == "Later meeting"
            && !item.TryGetProperty("emphasis", out _));
        Assert.Contains(occurrences, item => Title(item) == "All-day planning"
            && !item.TryGetProperty("emphasis", out _));
    }

    [Fact]
    public async Task Stale_last_good_source_uses_the_current_agenda_time_without_renewing_source_success()
    {
        var ics = CalendarWithEvents(
            "DTSTART:20261019T180500Z\nDTEND:20261019T183000Z\nSUMMARY:Cached meeting",
            "DTSTART:20261019T183500Z\nDTEND:20261019T190000Z\nSUMMARY:Next meeting");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var initial = await agenda.Poll();
        Assert.Equal("upcoming", Emphasis(Assert.Single(PrimaryOccurrences(initial),
            item => Title(item) == "Cached meeting")));

        agenda.Clock.Advance(TimeSpan.FromMinutes(16));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var stale = await agenda.Poll();
        var body = stale.RootElement;
        var cachedMeeting = Assert.Single(PrimaryOccurrences(stale), item => Title(item) == "Cached meeting");

        Assert.Equal("stale", body.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:16:00Z"),
            body.GetProperty("generated_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal("in_progress", Emphasis(cachedMeeting));
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Http_emphasis_clock_transitions_reach_all_six_native_views_with_original_source_metadata(
        NativeView view)
    {
        using var agenda = new AgendaHttp("2026-10-19T17:59:59.9999999Z", CalendarWithEvents(
            "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:All-day planning",
            "DTSTART:20261019T170000Z\nDTEND:20261019T190000Z\nSUMMARY:OOO excluded overlap",
            "DTSTART:20261019T181500Z\nDTEND:20261019T182500Z\nSUMMARY:First meeting\nLOCATION:Studio A",
            "DTSTART:20261019T181700Z\nDTEND:20261019T182700Z\nSUMMARY:Overlapping meeting",
            "DTSTART:20261019T183500Z\nDTEND:20261019T190000Z\nSUMMARY:Reselected meeting",
            "DTSTART:20261020T180000Z\nDTEND:20261020T190000Z\nSUMMARY:Secondary meeting"));
        const string rules = """{"rules_json":"[{\"field\":\"title\",\"mode\":\"whole_word\",\"value\":\"OOO\"}]"}""";
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        using var outside = await agenda.Poll(rules);
        Assert.Equal("current", outside.RootElement.GetProperty("state").GetString());
        await ShowEmphasis(page, outside, view, null, []);
        agenda.Clock.Advance(TimeSpan.FromTicks(1));
        using var upcoming = await agenda.PollOnly(rules);
        Assert.Equal("current", upcoming.RootElement.GetProperty("state").GetString());
        await ShowEmphasis(page, upcoming, view, "upcoming", ["First meeting"], "11:15 AM - 11:25 AM");
        agenda.Clock.Advance(TimeSpan.FromMinutes(15));
        using var exactStart = await agenda.PollOnly(rules);
        Assert.Equal("stale", exactStart.RootElement.GetProperty("state").GetString());
        await ShowEmphasis(page, exactStart, view, "in_progress", ["First meeting"], "11:15 AM - 11:25 AM");
        agenda.Clock.Advance(TimeSpan.FromMinutes(2));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var overlap = await agenda.Poll(rules);
        await ShowEmphasis(page, overlap, view, "in_progress", ["First meeting", "Overlapping meeting"]);
        agenda.Clock.Advance(TimeSpan.FromMinutes(8));
        using var exactEnd = await agenda.PollOnly(rules);
        Assert.DoesNotContain(PrimaryOccurrences(exactEnd), item => Title(item) == "First meeting");
        await ShowEmphasis(page, exactEnd, view, "in_progress", ["Overlapping meeting"], "11:17 AM - 11:27 AM");
        agenda.Clock.Advance(TimeSpan.FromMinutes(2));
        using var reselected = await agenda.PollOnly(rules);
        Assert.Equal("stale", reselected.RootElement.GetProperty("state").GetString());
        await ShowEmphasis(page, reselected, view, "upcoming", ["Reselected meeting"], "11:35 AM - 12:00 PM");
        Assert.Equal(outside.RootElement.GetProperty("source_succeeded_at").GetString(),
            reselected.RootElement.GetProperty("source_succeeded_at").GetString());
        Assert.Equal(2, agenda.SourceRequests);
        agenda.Clock.Advance(TimeSpan.FromMinutes(33));
        using var expired = await agenda.PollOnly(rules);
        await ShowEmphasis(page, expired, view, null, []);
        using var unavailable = new AgendaHttp("2026-10-19T19:00:00Z", "", status: HttpStatusCode.ServiceUnavailable);
        using var noSource = await unavailable.Poll();
        await ShowEmphasis(page, noSource, view, null, []);
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Http_response_pressure_retains_both_card_states_over_ordinary_and_all_day_competition_in_native_views(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        var title = "Priority <meeting> & " + new string('W', 1000);
        var events = Enumerable.Range(0, 100).Select(index =>
            $"DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:All day {index:D3} {new string('W', 1000)}")
            .Concat(Enumerable.Range(0, 24).Select(index =>
                $"DTSTART:20261019T200000Z\nDTEND:20261019T210000Z\nSUMMARY:Ordinary timed {index:D3}"))
            .Concat([
                $"DTSTART:20261019T181500Z\nDTEND:20261019T190000Z\nSUMMARY:{title}\nLOCATION:{new string('L', 120)}",
                "DTSTART:20261020T180000Z\nDTEND:20261020T190000Z\nSUMMARY:Secondary meeting"
            ]).ToArray();
        foreach (var (now, emphasis) in new[]
        {
            ("2026-10-19T18:00:00Z", "upcoming"), ("2026-10-19T18:15:00Z", "in_progress")
        })
        {
            using var agenda = new AgendaHttp(now, CalendarWithEvents(events));
            using var current = await agenda.Poll();
            Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
            await Check(current);
            agenda.Clock.Advance(TimeSpan.FromMinutes(1));
            agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
            using var stale = await agenda.Poll();
            Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
            Assert.Equal(current.RootElement.GetProperty("source_succeeded_at").GetString(),
                stale.RootElement.GetProperty("source_succeeded_at").GetString());
            await Check(stale);

            async Task Check(JsonDocument result)
            {
                Assert.InRange(Encoding.UTF8.GetByteCount(result.RootElement.GetRawText()), 1, 95_000);
                Assert.Equal(125, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
                Assert.InRange(PrimaryOccurrences(result).Length, 2, 124);
                await ShowEmphasis(page, result, view, emphasis, [title], "11:15 AM - 12:00 PM");
                await Assertions.Expect(page.GetByText(title, new() { Exact = true })).ToBeVisibleAsync();
                var ordinary = page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis])");
                Assert.True(await ordinary.CountAsync()
                    > await page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis]):visible").CountAsync(),
                    "Real ordinary rows must compete and be omitted, not just emphasized-only input.");
            }
        }
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Http_tied_and_overlapping_emphasized_overflow_reaches_native_fitting_before_ordinary_rows(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        foreach (var (now, emphasis) in new[]
        {
            ("2026-10-19T18:00:00Z", "upcoming"), ("2026-10-19T18:18:00Z", "in_progress")
        })
        {
            using var agenda = new AgendaHttp(now, CalendarWithEvents(EmphasizedOverflowEvents(emphasis == "in_progress")));
            using var result = await agenda.Poll();
            var titles = PrimaryOccurrences(result).Where(item => Emphasis(item) == emphasis).Select(Title).ToArray();
            Assert.Equal(100, titles.Length);
            Assert.Contains(PrimaryOccurrences(result), item => Emphasis(item) is null
                && item.GetProperty("time_kind").GetString() == "all_day");
            Assert.Contains(PrimaryOccurrences(result), item => Emphasis(item) is null
                && item.GetProperty("time_kind").GetString() == "timed");
            await ShowEmphasis(page, result, view, emphasis, titles);
            var ordinary = page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis])");
            Assert.Equal(25, await ordinary.CountAsync());
            Assert.Equal(0, await page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis]):visible").CountAsync());
            var visibleIds = await page.Locator(".agenda-primary tbody tr:visible")
                .EvaluateAllAsync<string[]>("rows => rows.map(row => row.dataset.agendaId)");
            Assert.InRange(visibleIds.Length, 1, 99);
            Assert.Equal(PrimaryOccurrences(result).Where(item => Emphasis(item) == emphasis)
                .Take(visibleIds.Length).Select(item => item.GetProperty("id").GetString()), visibleIds);
        }
    }

    private static async Task ShowEmphasis(IPage page, JsonDocument result, NativeView view,
        string? emphasis, string[] expectedTitles, string? scheduledTime = null)
    {
        var body = result.RootElement;
        var occurrences = PrimaryOccurrences(result);
        Assert.Equal(expectedTitles.Order(StringComparer.Ordinal),
            occurrences.Where(item => Emphasis(item) is not null).Select(Title).Order(StringComparer.Ordinal));
        Assert.All(occurrences.Where(item => Emphasis(item) is not null),
            item => Assert.Equal(emphasis, Emphasis(item)));
        await DisplayTests.Show(page, body, view.Placement, view.Device);
        await AdaptiveDisplayTests.NativeBounds(page, view);
        if (body.GetProperty("state").GetString() == "error")
        {
            Assert.Equal(0, await page.Locator("tbody tr, .agenda-status").CountAsync());
            await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToBeVisibleAsync();
            return;
        }
        foreach (var name in new[] { "primary", "secondary" })
        {
            var day = body.GetProperty(name);
            await AdaptiveDisplayTests.DayCount(page, name, day.GetProperty("eligible_total").GetInt32());
            var suppliedIds = day.GetProperty("occurrences").EnumerateArray()
                .Select(item => item.GetProperty("id").GetString()).ToArray();
            Assert.Equal(suppliedIds.Length, suppliedIds.Distinct().Count());
            var visibleIds = await page.Locator($".agenda-{name} tbody tr:visible")
                .EvaluateAllAsync<string[]>("rows => rows.map(row => row.dataset.agendaId)");
            Assert.Equal(suppliedIds.Where(visibleIds.Contains), visibleIds);
        }
        var cards = page.Locator(".agenda-primary tbody tr[data-agenda-emphasis]:visible");
        if (emphasis is null)
            Assert.Equal(0, await cards.CountAsync());
        else
        {
            Assert.InRange(await cards.CountAsync(), 1, expectedTitles.Length);
            await Assertions.Expect(cards.First.Locator(".agenda-status"))
                .ToHaveTextAsync(emphasis == "in_progress" ? "IN PROGRESS" : "UPCOMING");
            if (scheduledTime is not null)
                await Assertions.Expect(cards.First.Locator(".agenda-time .label")).ToHaveTextAsync(scheduledTime);
        }
        await Assertions.Expect(page.Locator("[data-agenda-source]"))
            .ToHaveAttributeAsync("datetime", body.GetProperty("source_succeeded_at").GetString()!);
        if (body.GetProperty("state").GetString() == "stale")
        {
            await Assertions.Expect(page.GetByText("Stale agenda", new() { Exact = true })).ToBeVisibleAsync();
            await Assertions.Expect(page.GetByText(body.GetProperty("error").GetProperty("message").GetString()!,
                new() { Exact = true })).ToBeVisibleAsync();
        }
        if (scheduledTime is not null)
            await AdaptiveDisplayTests.VisibleInk(page,
                $"http-emphasis-{view.Device}-{view.Placement}-{emphasis}-{body.GetProperty("state").GetString()}",
                view, await page.Locator("""
                    .agenda-heading .title, .agenda-count, [data-agenda-source], .agenda-warning > *,
                    tbody tr[data-agenda-emphasis]:not([hidden]) .title,
                    tbody tr[data-agenda-emphasis]:not([hidden]) .agenda-status,
                    tbody tr[data-agenda-emphasis]:not([hidden]) .agenda-time .label
                    """).AllAsync());
    }

    private static string[] EmphasizedOverflowEvents(bool overlapping) =>
        Enumerable.Range(0, 100).Select(index =>
        {
            var start = index < 50 ? "DTSTART:20261019T181500Z"
                : overlapping ? "DTSTART;TZID=America/Los_Angeles:20261019T111700"
                : "DTSTART;TZID=America/Los_Angeles:20261019T111500";
            return $"{start}\nDTEND:20261019T190000Z\nSUMMARY:Card {index:D3}\nLOCATION:Studio {index:D3}";
        })
        .Concat(Enumerable.Range(0, 24).Select(index =>
            $"DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261020\nSUMMARY:Ordinary all-day {index:D3}"))
        .Append("DTSTART:20261019T200000Z\nDTEND:20261019T210000Z\nSUMMARY:Ordinary future meeting").ToArray();

    private static JsonElement[] PrimaryOccurrences(JsonDocument result) =>
        result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray().ToArray();

    private static string Title(JsonElement occurrence) => occurrence.GetProperty("title").GetString()!;

    private static string? Emphasis(JsonElement occurrence) =>
        occurrence.TryGetProperty("emphasis", out var value) ? value.GetString() : null;

    private static string CalendarWithEvents(params string[] events) =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TRMNL Calendar//Synthetic emphasis tests//EN\n"
        + string.Concat(events.Select((item, index) =>
            $"BEGIN:VEVENT\nUID:emphasis-{index}@synthetic.invalid\nDTSTAMP:20261018T120000Z\n{item}\nEND:VEVENT\n"))
        + "END:VCALENDAR\n";
}
