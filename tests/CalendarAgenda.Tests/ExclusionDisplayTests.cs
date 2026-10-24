using System.Text.Json;
using Microsoft.Playwright;
using Xunit;
using AgendaHttp = CalendarAgenda.Tests.AgendaHttpTests.AgendaHttp;

namespace CalendarAgenda.Tests;

public sealed class ExclusionDisplayTests
{
    [Fact]
    public async Task Native_code_editor_seeds_exact_defaults_and_filters_the_real_agenda()
    {
        using var settings = JsonDocument.Parse(DisplayTests.Render("settings", new { }));
        var editor = settings.RootElement.GetProperty("custom_fields").EnumerateArray()
            .Single(field => field.GetProperty("keyname").GetString() == "rules_json");
        Assert.Equal("code", editor.GetProperty("field_type").GetString());
        Assert.Equal("post", settings.RootElement.GetProperty("polling_verb").GetString());
        Assert.Equal("{{ agenda_endpoint }}", settings.RootElement.GetProperty("polling_url").GetString());
        Assert.Contains("x-functions-key: {{ function_key }}",
            settings.RootElement.GetProperty("polling_headers").GetString());
        Assert.Equal("password", settings.RootElement.GetProperty("custom_fields").EnumerateArray()
            .Single(field => field.GetProperty("keyname").GetString() == "function_key")
            .GetProperty("field_type").GetString());
        var rules = editor.GetProperty("default").GetString()!;
        using var defaults = JsonDocument.Parse(rules);
        Assert.All(defaults.RootElement.EnumerateArray(),
            rule => Assert.Equal("title", rule.GetProperty("field").GetString()));
        Assert.Equal(["whole_word", "whole_word", "starts_with", "starts_with"],
            defaults.RootElement.EnumerateArray().Select(rule => rule.GetProperty("mode").GetString()));
        Assert.Equal(["OOF", "OOO", "working from", "Following: "],
            defaults.RootElement.EnumerateArray().Select(rule => rule.GetProperty("value").GetString()));

        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "exclusions.ics")));
        using var result = await agenda.Poll(DisplayTests.Render("polling-body", new { rules_json = rules }));
        var body = result.RootElement;

        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(
            ["Ongoing planning", "Policy discussion about working from home", "Proofreading session",
                "OOOps", "Following:Roadmap", "Source metadata review"],
            body.GetProperty("primary").GetProperty("occurrences").EnumerateArray()
                .Select(item => item.GetProperty("title").GetString()));
        Assert.Equal(6, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal("Customer check-in",
            Assert.Single(body.GetProperty("secondary").GetProperty("occurrences").EnumerateArray())
                .GetProperty("title").GetString());
        Assert.DoesNotContain("confidential", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("excluded-person", body.GetRawText());
        Assert.DoesNotContain("synthetic.invalid", body.GetRawText());
        Assert.DoesNotContain("OOF_holiday", body.GetRawText());
        Assert.DoesNotContain("Quarterly roadmap", body.GetRawText());
    }

    [Fact]
    public async Task Literal_quotes_and_newlines_cross_native_polling_as_data_and_match_the_real_source_title()
    {
        const string value = "\"quoted\"\nnext line";
        var rules = JsonSerializer.Serialize(new[] { new { field = "title", mode = "contains", value } });
        var request = DisplayTests.Render("polling-body", new { rules_json = rules });
        using var outer = JsonDocument.Parse(request);
        Assert.Single(outer.RootElement.EnumerateObject());
        Assert.Equal(rules, outer.RootElement.GetProperty("rules_json").GetString());
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"))
            .Replace("SUMMARY:Design review", "SUMMARY:Prefix \"quoted\"\\nnext line suffix");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", source);
        using var result = await agenda.Poll(request);

        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("Ongoing planning",
            Assert.Single(result.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
                .GetProperty("title").GetString());
        Assert.Equal(1, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("quoted", result.RootElement.GetRawText());
    }

    [Fact]
    public async Task Editing_native_rules_changes_visible_titles_and_counts_and_invalid_edits_show_an_error()
    {
        var source = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"))
            .Replace("Secondary day meeting", "Design follow-up");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", source);
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });

        using var original = await agenda.Poll(DisplayTests.Render("polling-body", new { rules_json = "[]" }));
        await DisplayTests.Show(page, original.RootElement);
        await Assertions.Expect(page.GetByText("Design review", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("2 events", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();

        using var edited = await agenda.Poll(DisplayTests.Render("polling-body", new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"dEsIgN"}]"""
        }));
        await DisplayTests.Show(page, edited.RootElement);
        await Assertions.Expect(page.GetByText("Ongoing planning", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Design review", new() { Exact = true })).ToHaveCountAsync(0);
        await Assertions.Expect(page.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No remaining events", new() { Exact = true })).ToBeVisibleAsync();
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-secondary"));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));
        Assert.DoesNotContain("Design", edited.RootElement.GetRawText(), StringComparison.OrdinalIgnoreCase);

        const string malformed = "\"}\n,\"rules_json\":\"[]\",\"source_url\":\"https://synthetic.invalid/credential\"";
        var invalidRequest = DisplayTests.Render("polling-body", new { rules_json = malformed });
        using var outer = JsonDocument.Parse(invalidRequest);
        Assert.Single(outer.RootElement.EnumerateObject());
        Assert.Equal(malformed, outer.RootElement.GetProperty("rules_json").GetString());
        using var invalid = await agenda.Poll(invalidRequest);
        await DisplayTests.Show(page, invalid.RootElement);
        await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("configuration_invalid", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Rule configuration is missing or malformed.", new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("No successful source check", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Ongoing planning", new() { Exact = true })).ToHaveCountAsync(0);
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());
        Assert.DoesNotContain("credential", await page.Locator("body").InnerTextAsync());
        await DisplayTests.InsideScreen(page, page.GetByText("configuration_invalid", new() { Exact = true }));
        await DisplayTests.InsideScreen(page, page.Locator(".agenda-source"));

        using var cleared = await agenda.Poll(DisplayTests.Render("polling-body", new { rules_json = "[]" }));
        await DisplayTests.Show(page, cleared.RootElement);
        await Assertions.Expect(page.GetByText("Design review", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("2 events", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("1 event", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Agenda unavailable", new() { Exact = true })).ToHaveCountAsync(0);
    }
}
