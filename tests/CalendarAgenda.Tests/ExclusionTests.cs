using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Xunit;
using AgendaHttp = CalendarAgenda.Tests.AgendaHttpTests.AgendaHttp;

namespace CalendarAgenda.Tests;

public sealed class ExclusionTests
{
    [Fact]
    public async Task Configured_contains_exclusion_hides_occurrences_and_recounts_both_days()
    {
        var ics = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"))
            .Replace("Secondary day meeting", "Design follow-up");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll(Request(
            """[{"field":"title","mode":"contains","value":"DESIGN"}]"""));
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(["Ongoing planning"], Titles(body, "primary"));
        Assert.Empty(Titles(body, "secondary"));
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(0, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("Design", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("working from", "WoRkInG FrOm home", false)]
    [InlineData("working from", "Policy discussion about working from home", true)]
    [InlineData("working from", "working from", false)]
    [InlineData("working from", " working from home", true)]
    [InlineData("Following: ", "fOlLoWiNg: Roadmap", false)]
    [InlineData("Following: ", "Following:Roadmap", true)]
    [InlineData("Following: ", "Following:\tRoadmap", true)]
    [InlineData("Following: ", "Discussion about Following: Roadmap", true)]
    public async Task Prefix_exclusions_preserve_literal_whitespace_and_never_match_in_the_middle(
        string value, string title, bool eligible)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle(title));
        using var result = await agenda.Poll(Request(JsonSerializer.Serialize(
            new[] { new { field = "title", mode = "starts_with", value } })));
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(eligible ? 1 : 0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(eligible ? new[] { title } : [], Titles(body, "primary"));
    }

    [Theory]
    [InlineData("OOO", "(OOO)", false)]
    [InlineData("OOO", "OOO/PTO", false)]
    [InlineData("OOF", "OOF_holiday", false)]
    [InlineData("OOF", "Holiday_oOf", false)]
    [InlineData("OOO", "OOOps", true)]
    [InlineData("OOF", "Proofreading session", true)]
    [InlineData("OOF", "OOF2", true)]
    [InlineData("OOF", "2OOF", true)]
    [InlineData("OOF", "\u00e9OOF", true)]
    [InlineData("OOF", "OOF\u00e9", true)]
    [InlineData("OOF", "\U00010400OOF", true)]
    [InlineData("OOF", "OOF\U00010400", true)]
    [InlineData("OOF", "OOF\u0301", true)]
    [InlineData("OOO", "OOOps, then ooo", false)]
    [InlineData("OOF", "Proofreading then OOF", false)]
    [InlineData("OOO", "OOO\nPTO", false)]
    [InlineData("annual leave", "(Annual Leave)", false)]
    [InlineData("annual leave", "Annual leaveback planning", true)]
    [InlineData("A+B", "Meeting A+B review", false)]
    [InlineData("A+B", "Meeting AAAB review", true)]
    public async Task Whole_word_exclusions_use_punctuation_and_underscores_not_letters_or_numbers_as_boundaries(
        string value, string title, bool eligible)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle(title));
        using var result = await agenda.Poll(Request(JsonSerializer.Serialize(
            new[] { new { field = "title", mode = "whole_word", value } })));
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(eligible ? 1 : 0, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(eligible ? new[] { title } : [], Titles(body, "primary"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("true")]
    [InlineData("\"[]\"")]
    [InlineData("[null]")]
    [InlineData("[[]]")]
    [InlineData("[true]")]
    [InlineData("[\"rule\"]")]
    [InlineData("[{}]")]
    [InlineData("""[{"mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"contains"}]""")]
    [InlineData("""[{"field":null,"mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":1,"mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"Title","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"description","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"participants","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"location","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":null,"value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":[],"value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"regex","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"whole-word","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"Contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"0","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":null}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":42}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":false}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":[]}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":{}}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":""}]""")]
    [InlineData("""[{"field":"title","mode":"starts_with","value":" "}]""")]
    [InlineData("""[{"field":"title","mode":"whole_word","value":"\r\n\t"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF","extra":true}]""")]
    [InlineData("""[{"field":"title","field":"title","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF","value":"OOO"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF"},{"field":"location","mode":"contains","value":"x"}]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF"},null]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF"},]""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"OOF"}] []""")]
    [InlineData("""[{"field":"title","mode":"contains","value":"\ud800"}]""")]
    [InlineData("""[{"field":"\ud800","mode":"contains","value":"OOF"}]""")]
    [InlineData("""[{"field":"title","mode":"\udc00","value":"OOF"}]""")]
    public async Task Complete_rule_validation_returns_an_explicit_error_before_source_or_matching(string rules)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle("OOF"),
            status: HttpStatusCode.ServiceUnavailable);
        using var result = await agenda.Poll(Request(rules));
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("configuration_invalid", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(Titles(body, day));
        }
        Assert.DoesNotContain("OOF", body.GetRawText());
    }

    [Fact]
    public async Task Missing_source_title_is_not_guessed_from_the_display_placeholder_or_other_metadata()
    {
        var ics = CalendarWithTitle("Placeholder").Replace("SUMMARY:Placeholder",
            "DESCRIPTION:(Untitled)\nLOCATION:(Untitled)\nATTENDEE:mailto:untitled@synthetic.invalid");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", ics);
        using var result = await agenda.Poll(Request(
            """[{"field":"title","mode":"contains","value":"(Untitled)"}]"""));

        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("(Untitled)", Assert.Single(Titles(result.RootElement, "primary")));
        Assert.Equal(1, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"rules_json":null}""")]
    [InlineData("""{"rules_json":"{"}""")]
    [InlineData("""{"rules_json":"[null]"}""")]
    public async Task Every_poll_uses_current_rules_instead_of_a_previous_ruleset_or_an_unfiltered_fallback(
        string invalidRequest)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle("Design review"));
        using var excluded = await agenda.Poll(Request(
            """[{"field":"title","mode":"contains","value":"Design"}]"""));
        Assert.Equal("current", excluded.RootElement.GetProperty("state").GetString());
        Assert.Equal(0, excluded.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());

        using var invalid = await agenda.Poll(invalidRequest);
        Assert.Equal("error", invalid.RootElement.GetProperty("state").GetString());
        Assert.Equal("configuration_invalid", invalid.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, invalid.RootElement.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(Titles(invalid.RootElement, "primary"));

        using var cleared = await agenda.Poll(Request("[]"));
        Assert.Equal("current", cleared.RootElement.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(Titles(cleared.RootElement, "primary")));
        Assert.Equal(1, cleared.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
    }

    [Theory]
    [InlineData("working from", "Policy discussion about working from home", false)]
    [InlineData("OOO", "OOOps", false)]
    [InlineData(".*", "Ordinary planning", true)]
    [InlineData(".[x]", "Literal .[x] review", false)]
    [InlineData("keep ", "keep", true)]
    [InlineData(" keep", " keep", false)]
    public async Task Contains_is_literal_and_matches_the_middle_without_trimming(
        string value, string title, bool eligible)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle(title));
        using var result = await agenda.Poll(Request(JsonSerializer.Serialize(
            new[] { new { field = "title", mode = "contains", value } })));

        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal(eligible ? new[] { title } : [], Titles(result.RootElement, "primary"));
    }

    [Theory]
    [InlineData("""{"rules_json":"\ud800"}""")]
    [InlineData("""{"rules_json":"[]","rules\u005fjson":"[]"}""")]
    [InlineData("""{"rules_json":false}""")]
    [InlineData("""{"rules_json":42}""")]
    [InlineData("""{"rules_json":{}}""")]
    [InlineData("""["[]"]""")]
    public async Task Invalid_outer_configuration_cannot_bypass_required_string_validation(string request)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle("Design review"));
        using var result = await agenda.Poll(request);

        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("configuration_invalid", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(Titles(result.RootElement, "primary"));
    }

    [Fact]
    public async Task Request_budget_accepts_16_KiB_and_rejects_even_one_additional_byte()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle("Design review"));
        var request = Request("[]").PadRight(16 * 1024);
        using var atLimit = await agenda.Poll(request);
        Assert.Equal("current", atLimit.RootElement.GetProperty("state").GetString());

        using var overLimit = await agenda.Poll(request + " ");
        Assert.Equal("error", overLimit.RootElement.GetProperty("state").GetString());
        Assert.Equal("configuration_invalid", overLimit.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Empty(Titles(overLimit.RootElement, "primary"));
    }

    [Fact]
    public async Task Rule_text_and_source_credentials_are_absent_from_responses_and_diagnostics()
    {
        var diagnostics = new CapturedDiagnostics();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", CalendarWithTitle("Design review"),
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_SOURCE_CREDENTIAL", logger: diagnostics);
        using var current = await agenda.Poll(Request(
            """[{"field":"title","mode":"contains","value":"CONFIDENTIAL_RULE_LITERAL"}]"""));
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        Assert.DoesNotContain("CONFIDENTIAL", current.RootElement.GetRawText());
        Assert.Empty(diagnostics.Messages);

        using var invalid = await agenda.Poll(Request(
            """[{"field":"description","mode":"contains","value":"CONFIDENTIAL_RULE_LITERAL"}]"""));
        Assert.Equal("error", invalid.RootElement.GetProperty("state").GetString());
        Assert.DoesNotContain("CONFIDENTIAL", invalid.RootElement.GetRawText());
        Assert.Equal("Agenda failed with code configuration_invalid.", Assert.Single(diagnostics.Messages));
    }

    private static string Request(string rules) => JsonSerializer.Serialize(new { rules_json = rules });

    private static string CalendarWithTitle(string title) =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TRMNL Calendar//Synthetic exclusions//EN\n"
        + "BEGIN:VEVENT\nUID:exclusion@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
        + "DTSTART:20261019T190000Z\nDTEND:20261019T200000Z\n"
        + $"SUMMARY:{title.Replace("\\", "\\\\").Replace("\r\n", "\n").Replace("\n", "\\n")
            .Replace(",", "\\,").Replace(";", "\\;")}\nEND:VEVENT\nEND:VCALENDAR\n";

    private static IEnumerable<string?> Titles(JsonElement body, string day) =>
        body.GetProperty(day).GetProperty("occurrences").EnumerateArray()
            .Select(item => item.GetProperty("title").GetString());

    private sealed class CapturedDiagnostics : ILogger<AgendaFunction>
    {
        public List<string> Messages { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
            Exception? exception, Func<TState, Exception?, string> formatter)
        {
            Messages.Add(formatter(state, exception));
            if (exception is not null)
                Messages.Add(exception.ToString());
        }
    }
}
