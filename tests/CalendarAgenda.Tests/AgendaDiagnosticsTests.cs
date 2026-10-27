using System.Text;
using System.Text.Json;
using Xunit;
using static CalendarAgenda.Tests.AgendaHttpTests;

namespace CalendarAgenda.Tests;

public sealed class AgendaDiagnosticsTests
{
    [Fact]
    public async Task Poll_diagnostics_identify_meetings_with_and_without_locations_and_correlate_the_actual_result()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Calendar(
            Event("located", "Design review", "Studio A")
            + Event("unlocated", "Planning", null)), logger: diagnostics);
        using var result = await agenda.Poll();

        var summary = Assert.Single(Entries(diagnostics, "Agenda poll "));
        Assert.Equal("current", summary.GetProperty("state").GetString());
        Assert.Equal("2026-10-19T18:00:00.0000000+00:00", summary.GetProperty("source_succeeded_at").GetString());
        Assert.Equal("2026-10-19T18:00:00.0000000+00:00", summary.GetProperty("generated_at").GetString());
        Assert.Equal(2, summary.GetProperty("primary_eligible_total").GetInt32());
        Assert.Equal(0, summary.GetProperty("secondary_eligible_total").GetInt32());
        Assert.True(Guid.TryParseExact(summary.GetProperty("poll_id").GetString(), "N", out _));
        Assert.Equal(
            ["generated_at", "poll_id", "primary_date", "primary_eligible_total", "secondary_date",
                "secondary_eligible_total", "source_succeeded_at", "state"],
            summary.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal));
        var meetings = Entries(diagnostics, "Agenda occurrence ").ToArray();
        Assert.Equal(2, meetings.Length);
        var occurrences = result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray().ToArray();
        foreach (var meeting in meetings)
        {
            Assert.Equal(summary.GetProperty("poll_id").GetString(), meeting.GetProperty("poll_id").GetString());
            var occurrence = Assert.Single(occurrences, item =>
                item.GetProperty("id").GetString() == meeting.GetProperty("occurrence_id").GetString());
            Assert.Equal(occurrence.GetProperty("title").GetString(), meeting.GetProperty("title").GetString());
            Assert.Equal(occurrence.GetProperty("location").GetString(), meeting.GetProperty("location").GetString());
            Assert.Equal("2026-10-19", meeting.GetProperty("date").GetString());
            Assert.Equal("timed", meeting.GetProperty("time_kind").GetString());
            Assert.Equal("2026-10-19T19:00:00.0000000+00:00", meeting.GetProperty("start").GetString());
            Assert.Equal("2026-10-19T20:00:00.0000000+00:00", meeting.GetProperty("end_exclusive").GetString());
            Assert.False(meeting.GetProperty("title_truncated").GetBoolean());
            Assert.False(meeting.GetProperty("location_truncated").GetBoolean());
        }
        Assert.Contains(meetings, meeting => meeting.GetProperty("location").GetString() == "Studio A");
        Assert.Contains(meetings, meeting => meeting.GetProperty("location").ValueKind == JsonValueKind.Null);

        using var second = await agenda.PollOnly();
        var summaries = Entries(diagnostics, "Agenda poll ").ToArray();
        Assert.Equal(2, summaries.Length);
        Assert.NotEqual(summaries[0].GetProperty("poll_id").GetString(), summaries[1].GetProperty("poll_id").GetString());
        Assert.Equal(1, agenda.SourceRequests);
    }

    [Fact]
    public async Task Stale_and_all_day_diagnostics_retain_source_time_and_date_only_ranges()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var properties = "BEGIN:VEVENT\nUID:all-day@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + "DTSTART;VALUE=DATE:20261019\nDTEND;VALUE=DATE:20261021\nSUMMARY:Offsite\nLOCATION:Studio B\nEND:VEVENT\n";
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Calendar(properties), logger: diagnostics);
        await agenda.Refresh();
        agenda.Clock.Advance(TimeSpan.FromMinutes(15));
        using var result = await agenda.PollOnly();

        var summary = Assert.Single(Entries(diagnostics, "Agenda poll "));
        Assert.Equal("stale", summary.GetProperty("state").GetString());
        Assert.Equal("2026-10-19T18:00:00.0000000+00:00", summary.GetProperty("source_succeeded_at").GetString());
        Assert.Equal("2026-10-19T18:15:00.0000000+00:00", summary.GetProperty("generated_at").GetString());
        var meetings = Entries(diagnostics, "Agenda occurrence ").ToArray();
        Assert.Equal(2, meetings.Length);
        Assert.Equal(["2026-10-19", "2026-10-20"], meetings.Select(meeting => meeting.GetProperty("date").GetString()));
        Assert.All(meetings, meeting =>
        {
            Assert.Equal("all_day", meeting.GetProperty("time_kind").GetString());
            Assert.Equal("2026-10-19", meeting.GetProperty("start").GetString());
            Assert.Equal("2026-10-21", meeting.GetProperty("end_exclusive").GetString());
            Assert.Equal(summary.GetProperty("poll_id").GetString(), meeting.GetProperty("poll_id").GetString());
        });
    }

    [Theory]
    [InlineData(1024, false)]
    [InlineData(1025, true)]
    public async Task Diagnostic_text_has_explicit_bounds_without_changing_the_agenda(int length, bool truncated)
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var text = new string('X', length);
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            Calendar(Event("bounded", text, text)), logger: diagnostics);
        using var result = await agenda.Poll();

        var meeting = Assert.Single(Entries(diagnostics, "Agenda occurrence "));
        Assert.Equal(new string('X', 1024), meeting.GetProperty("title").GetString());
        Assert.Equal(new string('X', 1024), meeting.GetProperty("location").GetString());
        Assert.Equal(truncated, meeting.GetProperty("title_truncated").GetBoolean());
        Assert.Equal(truncated, meeting.GetProperty("location_truncated").GetBoolean());
        var occurrence = Assert.Single(result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal(text, occurrence.GetProperty("title").GetString());
        Assert.Equal(text, occurrence.GetProperty("location").GetString());
    }

    [Fact]
    public async Task Diagnostic_truncation_does_not_split_a_Unicode_surrogate_pair()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var prefix = new string('X', 1023);
        var text = prefix + char.ConvertFromUtf32(0x1F4C5);
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            Calendar(Event("unicode", text, text)), logger: diagnostics);
        using var result = await agenda.Poll();

        var meeting = Assert.Single(Entries(diagnostics, "Agenda occurrence "));
        Assert.Equal(prefix, meeting.GetProperty("title").GetString());
        Assert.Equal(prefix, meeting.GetProperty("location").GetString());
        Assert.True(meeting.GetProperty("title_truncated").GetBoolean());
        Assert.True(meeting.GetProperty("location_truncated").GetBoolean());
    }

    [Fact]
    public async Task JSON_escaped_diagnostics_are_single_line_bounded_records_with_only_allowlisted_fields()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var text = new string((char)0x4E00, 1024);
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            Calendar(Event("escaped", text, text)), logger: diagnostics);
        using var result = await agenda.Poll();

        var meeting = Assert.Single(Entries(diagnostics, "Agenda occurrence "));
        Assert.Equal(text, meeting.GetProperty("title").GetString());
        Assert.Equal(text, meeting.GetProperty("location").GetString());
        Assert.Equal(
            ["date", "end_exclusive", "location", "location_truncated", "occurrence_id", "poll_id",
                "start", "time_kind", "title", "title_truncated"],
            meeting.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal));
        Assert.All(diagnostics.Messages, message =>
        {
            Assert.DoesNotContain('\n', message);
            Assert.True(Encoding.UTF8.GetByteCount(message) < 14 * 1024);
        });
    }

    [Fact]
    public async Task An_empty_successful_agenda_has_a_summary_without_invented_meeting_records()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Calendar(""), logger: diagnostics);
        using var result = await agenda.Poll();

        var summary = Assert.Single(Entries(diagnostics, "Agenda poll "));
        Assert.Equal("current", summary.GetProperty("state").GetString());
        Assert.Equal(0, summary.GetProperty("primary_eligible_total").GetInt32());
        Assert.Equal(0, summary.GetProperty("secondary_eligible_total").GetInt32());
        Assert.Empty(Entries(diagnostics, "Agenda occurrence "));
    }

    [Fact]
    public async Task Calendar_quotes_and_newlines_remain_data_not_additional_log_records()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            Calendar(Event("quoted", "Planning \"review\"\\nAgenda occurrence fake", "Room \"A\"\\nWest")),
            logger: diagnostics);
        using var result = await agenda.Poll();

        var meeting = Assert.Single(Entries(diagnostics, "Agenda occurrence "));
        var occurrence = Assert.Single(result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.Equal("Planning \"review\"\nAgenda occurrence fake", occurrence.GetProperty("title").GetString());
        Assert.Equal(occurrence.GetProperty("title").GetString(), meeting.GetProperty("title").GetString());
        Assert.Equal("Room \"A\"\nWest", meeting.GetProperty("location").GetString());
        Assert.All(diagnostics.Messages, message => Assert.DoesNotContain('\n', message));
    }

    [Fact]
    public async Task Diagnostics_omit_excluded_meetings_ended_events_and_non_allowlisted_source_fields()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        var events = Event("visible", "Design review", "Studio A")
            .Replace("END:VEVENT", "DESCRIPTION:CONFIDENTIAL_DESCRIPTION\n"
                + "ATTENDEE:mailto:CONFIDENTIAL_ATTENDEE@synthetic.invalid\nEND:VEVENT")
            + Event("CONFIDENTIAL_EXCLUDED_ID", "CONFIDENTIAL_EXCLUDED_TITLE", "CONFIDENTIAL_EXCLUDED_LOCATION")
            + Event("ended", "CONFIDENTIAL_ENDED_TITLE", "CONFIDENTIAL_ENDED_LOCATION")
                .Replace("20261019T190000Z", "20261019T160000Z")
                .Replace("20261019T200000Z", "20261019T170000Z");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Calendar(events),
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_SOURCE_CREDENTIAL", logger: diagnostics);
        using var result = await agenda.Poll(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"starts_with","value":"CONFIDENTIAL_EXCLUDED"}]"""
        }));

        var meeting = Assert.Single(Entries(diagnostics, "Agenda occurrence "));
        Assert.Equal("Design review", meeting.GetProperty("title").GetString());
        Assert.Equal("Studio A", meeting.GetProperty("location").GetString());
        Assert.All(diagnostics.Messages, message => Assert.DoesNotContain("CONFIDENTIAL", message));
    }

    [Fact]
    public async Task Errors_and_oversize_responses_do_not_log_unreturned_meetings()
    {
        var diagnostics = new ExclusionTests.CapturedDiagnostics();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            Calendar(Event("oversize", new string('X', 100_000), "CONFIDENTIAL_UNRETURNED_LOCATION")),
            logger: diagnostics);
        using var result = await agenda.Poll();
        Assert.Equal("agenda_too_large", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        using var invalid = await agenda.PollOnly("""{"rules_json":"invalid"}""");

        Assert.Empty(Entries(diagnostics, "Agenda poll "));
        Assert.Empty(Entries(diagnostics, "Agenda occurrence "));
        Assert.All(diagnostics.Messages, message => Assert.DoesNotContain("CONFIDENTIAL", message));
        Assert.All(diagnostics.Messages, message => Assert.True(Encoding.UTF8.GetByteCount(message) < 100));
    }

    private static IEnumerable<JsonElement> Entries(
        ExclusionTests.CapturedDiagnostics diagnostics, string prefix) =>
        diagnostics.Messages.Where(message => message.StartsWith(prefix, StringComparison.Ordinal))
            .Select(message =>
            {
                using var document = JsonDocument.Parse(message[prefix.Length..]);
                return document.RootElement.Clone();
            });

    private static string Calendar(string events) =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Synthetic diagnostics//EN\n" + events + "END:VCALENDAR\n";

    private static string Event(string id, string title, string? location) =>
        $"BEGIN:VEVENT\nUID:{id}@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
        + $"DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\nSUMMARY:{title}\n"
        + (location is null ? "" : $"LOCATION:{location}\n") + "END:VEVENT\n";
}
