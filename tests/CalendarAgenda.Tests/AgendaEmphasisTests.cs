using System.Net;
using System.Text.Json;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
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
