using System.Net;
using System.Text.Json;
using Microsoft.Playwright;
using Xunit;
using AgendaHttp = CalendarAgenda.Tests.AgendaHttpTests.AgendaHttp;
using NativeView = CalendarAgenda.Tests.AdaptiveDisplayTests.NativeView;

namespace CalendarAgenda.Tests;

public sealed class SourceFallbackDisplayTests
{
    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Scheduled_source_freshness_remains_visible_in_every_production_native_view(NativeView view)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics")));
        await agenda.Tick();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        agenda.Clock.Advance(TimeSpan.FromMinutes(15));
        using var stale = await agenda.PollOnly();
        Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
        Assert.Equal(2, stale.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, stale.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        await DisplayTests.Show(page, stale.RootElement, view.Placement, view.Device);
        await AdaptiveDisplayTests.NativeBounds(page, view);
        await AdaptiveDisplayTests.VisibleInk(page, $"scheduled-{view.Device}-{view.Placement}-stale", view,
            new[]
            {
                page.GetByText("Stale agenda", new() { Exact = true }),
                page.GetByText("The scheduled source refresh is delayed.", new() { Exact = true }),
                page.GetByText("Monday, Oct 19", new() { Exact = true }),
                page.GetByText("Tuesday, Oct 20", new() { Exact = true }),
                page.GetByText("2 eligible events", new() { Exact = true }),
                page.GetByText("1 eligible event", new() { Exact = true }),
                page.GetByText("Oct 19, 2026, 11:00 AM PDT", new() { Exact = true })
            });
        agenda.Clock.Advance(TimeSpan.FromMinutes(45));
        using var expired = await agenda.PollOnly();
        Assert.Equal("error", expired.RootElement.GetProperty("state").GetString());
        await DisplayTests.Show(page, expired.RootElement, view.Placement, view.Device);
        await AdaptiveDisplayTests.NativeBounds(page, view);
        await AdaptiveDisplayTests.VisibleInk(page, $"scheduled-{view.Device}-{view.Placement}-expired", view,
            new[]
            {
                page.GetByText("Agenda unavailable", new() { Exact = true }),
                page.GetByText("Source refresh error", new() { Exact = true }),
                page.GetByText("refresh_delayed", new() { Exact = true }),
                page.GetByText("The scheduled source refresh is delayed.", new() { Exact = true }),
                page.GetByText("Oct 19, 2026, 11:00 AM PDT", new() { Exact = true })
            });
        Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());
        Assert.DoesNotContain("No remaining events", await page.Locator("body").InnerTextAsync());
        Assert.Equal(1, agenda.SourceRequests);
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Production_views_display_HTTP_fresh_stale_empty_and_failed_source_states(
        NativeView view)
    {
        using var agenda = new AgendaHttp("2026-10-23T18:00:00Z", BusyCalendar(),
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_SOURCE_CREDENTIAL");
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        using var current = await agenda.Poll();
        await Agenda(current, "current", 32, 1, stale: false);

        var emptyRules = JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"commitment"}]"""
        });
        using var empty = await agenda.Poll(emptyRules);
        await Agenda(empty, "empty", 0, 0, stale: false);

        agenda.Clock.Advance(TimeSpan.FromMinutes(45));
        agenda.SetSource(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "this-and-future.ics")));
        using var stale = await agenda.Poll(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"whole_word","value":"1"}]"""
        }));
        await Agenda(stale, "stale", 31, 1, stale: true);
        Assert.DoesNotContain("Cached commitment 1", stale.RootElement.GetProperty("primary")
            .GetProperty("occurrences").EnumerateArray().Select(item => item.GetProperty("title").GetString()));
        Assert.DoesNotContain("11:45", await page.Locator("body").InnerTextAsync());

        using var staleEmpty = await agenda.Poll(emptyRules);
        await Agenda(staleEmpty, "stale-empty", 0, 0, stale: true);

        agenda.Clock.Advance(TimeSpan.FromMinutes(15));
        using var expired = await agenda.Poll();
        await Error(expired, "expired", "Compatibility error", "compatibility_unsupported",
            "Recurring changes with RANGE=THISANDFUTURE are not supported.", knownSuccess: true);

        using var configurationError = await agenda.Poll("{}");
        await Error(configurationError, "configuration", "Configuration error", "configuration_invalid",
            "Rule configuration is missing or malformed.", knownSuccess: false);

        using var noCache = new AgendaHttp("2026-10-23T19:00:00Z", "", status: HttpStatusCode.ServiceUnavailable);
        using var unavailable = await noCache.Poll();
        await Error(unavailable, "unavailable", "Source error", "source_unavailable",
            "The calendar source could not be checked.", knownSuccess: false);

        async Task Agenda(JsonDocument result, string name, int primaryTotal, int secondaryTotal, bool stale)
        {
            var body = result.RootElement;
            Assert.Equal(stale ? "stale" : "current", body.GetProperty("state").GetString());
            Assert.Equal(primaryTotal, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(secondaryTotal, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
            Assert.Equal(DateTimeOffset.Parse("2026-10-23T18:00:00Z"),
                body.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
            await DisplayTests.Show(page, body, view.Placement, view.Device);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var required = new List<ILocator>
            {
                page.GetByText("Friday, Oct 23", new() { Exact = true }),
                page.GetByText("Monday, Oct 26", new() { Exact = true }),
                page.Locator(".agenda-primary .agenda-heading .label"),
                page.Locator(".agenda-secondary .agenda-heading .label"),
                page.GetByText("Source checked:", new() { Exact = true }),
                page.GetByText("Oct 23, 2026, 11:00 AM PDT", new() { Exact = true })
            };
            if (stale)
            {
                required.Add(page.GetByText("Stale agenda", new() { Exact = true }));
                required.Add(page.GetByText("Recurring changes with RANGE=THISANDFUTURE are not supported.",
                    new() { Exact = true }));
            }
            else
                Assert.DoesNotContain("Stale agenda", await page.Locator("body").InnerTextAsync());
            if (primaryTotal == 0)
            {
                required.Add(page.Locator(".agenda-primary .agenda-empty"));
                required.Add(page.Locator(".agenda-secondary .agenda-empty"));
            }
            else
            {
                var rows = page.Locator(".agenda-primary tbody tr:visible");
                var visible = await rows.CountAsync();
                Assert.InRange(visible, 1, primaryTotal - 1);
                required.Add(rows.First.Locator("[data-agenda-start]"));
                required.Add(rows.First.Locator("td .title"));
                required.Add(page.GetByText($"+{primaryTotal - visible} more", new() { Exact = true }));
                Assert.Equal(0, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
            }
            await Assertions.Expect(page.Locator("[data-agenda-source]"))
                .ToHaveAttributeAsync("datetime", body.GetProperty("source_succeeded_at").GetString()!);
            await AdaptiveDisplayTests.VisibleInk(page, $"cache-{view.Device}-{view.Placement}-{name}", view, required);
        }

        async Task Error(JsonDocument result, string name, string kind, string code, string message, bool knownSuccess)
        {
            var body = result.RootElement;
            Assert.Equal("error", body.GetProperty("state").GetString());
            Assert.Equal(code, body.GetProperty("error").GetProperty("code").GetString());
            foreach (var day in new[] { "primary", "secondary" })
            {
                Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
                Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
            }
            await DisplayTests.Show(page, body, view.Placement, view.Device);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var required = new[]
            {
                page.GetByText("Agenda unavailable", new() { Exact = true }),
                page.GetByText(kind, new() { Exact = true }),
                page.GetByText(code, new() { Exact = true }),
                page.GetByText(message, new() { Exact = true }),
                page.GetByText("Source checked:", new() { Exact = true }),
                page.GetByText(knownSuccess ? "Oct 23, 2026, 11:00 AM PDT" : "No successful source check",
                    new() { Exact = true })
            };
            Assert.DoesNotContain("eligible event", await page.Locator("body").InnerTextAsync());
            Assert.DoesNotContain("No remaining events", await page.Locator("body").InnerTextAsync());
            await AdaptiveDisplayTests.VisibleInk(page, $"cache-{view.Device}-{view.Placement}-{name}", view, required);
        }
    }

    private static string BusyCalendar() =>
        "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//TRMNL Calendar//Synthetic cache display//EN\n"
        + string.Concat(Enumerable.Range(1, 32).Select(index =>
            $"BEGIN:VEVENT\nUID:cached-{index}@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
            + "DTSTART:20261023T180000Z\nDTEND:20261023T210000Z\n"
            + $"SUMMARY:Cached commitment {index}\nDESCRIPTION:CONFIDENTIAL_SOURCE_DESCRIPTION\nEND:VEVENT\n"))
        + "BEGIN:VEVENT\nUID:secondary@synthetic.invalid\nDTSTAMP:20261018T120000Z\n"
        + "DTSTART:20261026T180000Z\nDTEND:20261026T190000Z\nSUMMARY:Secondary commitment\n"
        + "END:VEVENT\nEND:VCALENDAR\n";
}
