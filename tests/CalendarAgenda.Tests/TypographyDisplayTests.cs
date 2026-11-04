using System.Text.Json;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class TypographyDisplayTests
{
    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Stale_error_and_missing_success_keep_original_provenance_and_messages_across_dates(
        AdaptiveDisplayTests.NativeView view)
    {
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        foreach (var scenario in new[] { "stale", "error-known-success", "error-source" })
        {
            var data = AgendaScenarios.Load(scenario);
            data["generated_at"] = "2027-01-01T08:05:00Z";
            if (data["source_succeeded_at"] is not null)
                data["source_succeeded_at"] = "2027-01-01T07:55:00Z";
            await DisplayTests.Show(page, data, view.Placement, view.Device);
            var message = data["error"]!["message"]!.GetValue<string>();
            await Assertions.Expect(page.GetByText(message, new() { Exact = true })).ToBeVisibleAsync();
            var source = page.Locator("[data-agenda-source]");
            if (scenario == "error-source")
            {
                await Assertions.Expect(source).ToHaveCountAsync(0);
                await Assertions.Expect(page.GetByText("No successful source check", new() { Exact = true })).ToBeVisibleAsync();
            }
            else
            {
                await Assertions.Expect(source).ToHaveTextAsync("Dec 31, 2026, 11:55 PM PST");
                await Assertions.Expect(source).ToHaveAttributeAsync("datetime", "2027-01-01T07:55:00Z");
            }
            await Assertions.Expect(page.GetByText(scenario == "stale" ? "Stale agenda" : "Agenda unavailable",
                new() { Exact = true })).ToBeVisibleAsync();
            await AdaptiveDisplayTests.NativeBounds(page, view);
            await AdaptiveDisplayTests.VisibleInk(page, $"source-provenance-{scenario}-{view.Device}-{view.Placement}", view,
                await page.Locator(".agenda-source > *, .agenda-warning > *, .agenda > .title, .agenda > .description").AllAsync());
        }
    }

    [Theory]
    [InlineData("2026-01-02T07:55:00Z", "2026-01-02T08:05:00Z", "Jan 1, 2026, 11:55 PM PST")]
    [InlineData("2027-01-01T07:55:00Z", "2027-01-01T08:05:00Z", "Dec 31, 2026, 11:55 PM PST")]
    [InlineData("2026-07-04T06:55:00Z", "2026-07-04T07:05:00Z", "Jul 3, 2026, 11:55 PM PDT")]
    [InlineData("2026-01-01T23:55:00Z", "2026-01-02T00:05:00Z", "3:55 PM PST")]
    [InlineData("2026-07-03T23:55:00Z", "2026-07-04T00:05:00Z", "4:55 PM PDT")]
    [InlineData("2026-11-01T08:55:00Z", "2026-11-01T09:05:00Z", "1:55 AM PDT")]
    [InlineData("2026-11-01T09:05:00Z", "2026-11-01T09:15:00Z", "1:05 AM PST")]
    [InlineData("2026-10-24T18:00:00Z", "2026-10-24T18:05:00Z", "11:00 AM PDT")]
    [InlineData("2026-10-23T18:00:00Z", "2026-10-24T18:05:00Z", "Oct 23, 2026, 11:00 AM PDT")]
    public async Task Source_check_uses_exactly_two_Los_Angeles_date_branches_against_the_supplied_reference(
        string succeeded, string generated, string expected)
    {
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = 800, Height = 480 },
            DeviceScaleFactor = 1,
            TimezoneId = "Pacific/Auckland"
        });
        await page.Clock.SetFixedTimeAsync(new DateTime(2032, 1, 1, 12, 0, 0, DateTimeKind.Utc));
        var data = AgendaScenarios.Load("weekend-labels");
        data["source_succeeded_at"] = succeeded;
        data["generated_at"] = generated;
        await DisplayTests.Show(page, data);
        await Assertions.Expect(page.Locator("[data-agenda-source]")).ToHaveTextAsync(expected);
        await Assertions.Expect(page.Locator("[data-agenda-source]")).ToHaveAttributeAsync("datetime", succeeded);
        var view = new AdaptiveDisplayTests.NativeView("og", "full", 800, 480, 1, 780, 460);
        await AdaptiveDisplayTests.VisibleInk(page, $"source-boundary-{succeeded.Replace(':', '-')}", view,
            await page.Locator(".agenda-source > *").AllAsync());
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Matching_ordinary_title_and_time_glyphs_have_equal_native_ink_height_and_bold_title_strokes(
        AdaptiveDisplayTests.NativeView view)
    {
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        var data = AgendaScenarios.Load("normal-mixed");
        var occurrences = data["primary"]!["occurrences"]!.AsArray();
        occurrences.RemoveAt(2);
        occurrences[0]!["title"] = "All day";
        occurrences[1]!["title"] = "11:00 AM";
        occurrences[1]!["start_at"] = "2026-10-23T18:00:00Z";
        occurrences[1]!["end_at"] = "2026-10-23T19:00:00Z";
        foreach (var occurrence in occurrences) occurrence!["location"] = null;
        data["primary"]!["eligible_total"] = 2;
        data["secondary"]!["eligible_total"] = 0;
        data["secondary"]!["occurrences"] = new System.Text.Json.Nodes.JsonArray();
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        var rows = page.Locator(".agenda-primary tbody tr:visible");
        await Assertions.Expect(rows).ToHaveCountAsync(2);
        var name = $"matching-glyphs-{view.Device}-{view.Placement}";
        await AdaptiveDisplayTests.VisibleInk(page, name, view,
            await rows.Locator(".title, .agenda-time .label").AllAsync());
        var measurements = new List<object>();
        foreach (var row in await rows.AllAsync())
        {
            foreach (var role in await row.Locator(".title, .agenda-time .label").AllAsync())
                Assert.Equal("Inter", await EffectiveFont(page, role));
            var glyphs = await row.EvaluateAsync<JsonElement>("""
                row => [row.querySelector(".title"), row.querySelector(".agenda-time .label")].map(node => {
                  const text = row.querySelector(".title").textContent;
                  const range = document.createRange();
                  range.setStart(node.firstChild, 0);
                  range.setEnd(node.firstChild, text.length);
                  const box = range.getBoundingClientRect();
                  return { text, x: box.x, y: box.y, width: box.width, height: box.height };
                })
                """);
            var glyphRows = glyphs.EnumerateArray().Select(glyph =>
            {
                var y = glyph.GetProperty("y").GetDouble();
                var firstRow = (int)Math.Floor(y);
                var rowCount = (int)Math.Ceiling(y + glyph.GetProperty("height").GetDouble()) - firstRow;
                return (glyph, firstRow, rowCount);
            }).ToArray();
            var regions = glyphRows.SelectMany(item =>
                Enumerable.Range(item.firstRow, item.rowCount)
                    .Select(y => new
                    {
                        text = item.glyph.GetProperty("text").GetString(),
                        x = item.glyph.GetProperty("x").GetDouble(),
                        y,
                        width = item.glyph.GetProperty("width").GetDouble(),
                        height = 1
                    })).ToArray();
            using var raster = JsonDocument.Parse(DisplayTests.RunRuby(
                Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"), new
                {
                    image = Path.Combine(DisplayTests.Root, "artifacts", $"{name}.png"),
                    comparison_image = Path.Combine(DisplayTests.Root, "artifacts", $"{name}-no-text.png"),
                    regions
                }));
            var offset = 0;
            var heights = new List<int>();
            var ink = new List<int>();
            foreach (var item in glyphRows)
            {
                var strips = raster.RootElement.EnumerateArray().Skip(offset).Take(item.rowCount).ToArray();
                var painted = strips.Select((strip, index) => (strip, index))
                    .Where(item => item.strip.GetProperty("different_pixels").GetInt32() > 0)
                    .Select(item => item.index).ToArray();
                Assert.NotEmpty(painted);
                heights.Add(painted[^1] - painted[0] + 1);
                ink.Add(strips.Sum(strip => strip.GetProperty("dark_pixels").GetInt32()));
                offset += item.rowCount;
            }
            Assert.InRange(Math.Abs(heights[0] - heights[1]), 0, Math.Ceiling(view.Density));
            Assert.True(ink[0] > ink[1], $"Matching bold title glyphs must paint stronger strokes: {ink[0]} / {ink[1]}.");
            measurements.Add(new { glyphs, heights, ink });
        }
        await File.WriteAllTextAsync(Path.Combine(DisplayTests.Root, "artifacts", $"{name}.json"),
            JsonSerializer.Serialize(measurements));
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Same_reference_date_source_check_is_subordinate_and_independent_of_the_browser_clock(
        AdaptiveDisplayTests.NativeView view)
    {
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1,
            TimezoneId = "Pacific/Auckland"
        });
        await page.Clock.SetFixedTimeAsync(new DateTime(2032, 1, 1, 12, 0, 0, DateTimeKind.Utc));
        await DisplayTests.Show(page, DisplayTests.CurrentAgenda(), view.Placement, view.Device);
        var source = page.Locator("[data-agenda-source]");
        await Assertions.Expect(source).ToHaveTextAsync("11:00 AM PDT");
        await Assertions.Expect(source).ToHaveAttributeAsync("datetime", "2026-10-23T18:00:00Z");
        await Assertions.Expect(page.GetByText("Source checked:", new() { Exact = true })).ToBeVisibleAsync();
        var style = await source.EvaluateAsync<JsonElement>("""
            node => {
              const style = getComputedStyle(node);
              return { size: style.fontSize, weight: style.fontWeight };
            }
            """);
        Assert.Equal("16px", style.GetProperty("size").GetString());
        Assert.Equal("400", style.GetProperty("weight").GetString());
        Assert.Equal("Inter", await EffectiveFont(page, source));
        await AdaptiveDisplayTests.NativeBounds(page, view);
        await AdaptiveDisplayTests.VisibleInk(page, $"source-same-date-{view.Device}-{view.Placement}", view,
            await page.Locator(".agenda-source > *").AllAsync());
    }

    [Theory]
    [MemberData(nameof(AdaptiveDisplayTests.Views), MemberType = typeof(AdaptiveDisplayTests))]
    public async Task Date_and_count_share_effective_fonts_and_a_typographic_baseline(
        AdaptiveDisplayTests.NativeView view)
    {
        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, AgendaScenarios.Load("normal-mixed"), view.Placement, view.Device);
        await AdaptiveDisplayTests.NativeBounds(page, view);
        foreach (var day in new[] { "primary", "secondary" })
        {
            var heading = page.Locator($".agenda-{day} .agenda-day-label");
            var metrics = await heading.EvaluateAsync<JsonElement>("""
                heading => [...heading.children].map(node => {
                  const style = getComputedStyle(node);
                  const original = [...node.childNodes];
                  const wrapper = document.createElement("span");
                  const marker = document.createElement("span");
                  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
                  wrapper.append(...original, marker);
                  node.append(wrapper);
                  const baseline = marker.getBoundingClientRect().top;
                  node.replaceChildren(...original);
                  return { family: style.fontFamily, size: parseFloat(style.fontSize),
                    weight: style.fontWeight, baseline };
                })
                """);
            Assert.All(metrics.EnumerateArray(), role =>
                Assert.Equal("\"Inter Variable\", Inter", role.GetProperty("family").GetString()));
            Assert.True(int.Parse(metrics[0].GetProperty("weight").GetString()!) >= 600);
            Assert.InRange(Math.Abs(metrics[0].GetProperty("baseline").GetDouble()
                - metrics[1].GetProperty("baseline").GetDouble()), 0, view.Density);
            foreach (var role in await heading.Locator(".title, .label").AllAsync())
                Assert.Equal("Inter", await EffectiveFont(page, role));
        }
        await AdaptiveDisplayTests.VisibleInk(page, $"typography-header-{view.Device}-{view.Placement}", view,
            await page.Locator(".agenda-day-label > *, .agenda-source > *").AllAsync());
    }

    private static async Task<string> EffectiveFont(IPage page, ILocator role)
    {
        await role.EvaluateAsync("node => node.setAttribute('data-typography-probe', '')");
        try
        {
            var fonts = Assert.Single(await DisplayTests.PlatformFonts(page, "[data-typography-probe]"));
            var font = Assert.Single(fonts.EnumerateArray());
            Assert.True(font.GetProperty("isCustomFont").GetBoolean());
            Assert.True(font.GetProperty("glyphCount").GetInt32() > 0);
            return font.GetProperty("familyName").GetString()!;
        }
        finally
        {
            await role.EvaluateAsync("node => node.removeAttribute('data-typography-probe')");
        }
    }
}
