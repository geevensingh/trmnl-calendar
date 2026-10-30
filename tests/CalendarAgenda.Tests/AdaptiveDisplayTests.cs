using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class AdaptiveDisplayTests
{
    public sealed record NativeView(string Device, string Placement, int PhysicalWidth, int PhysicalHeight,
        float Density, int LogicalViewWidth, int LogicalViewHeight);

    public static TheoryData<NativeView> Views => new()
    {
        new("og", "full", 800, 480, 1, 780, 460),
        new("og", "half_horizontal", 800, 480, 1, 780, 225),
        new("og", "half_vertical", 800, 480, 1, 385, 460),
        new("v2", "full", 1872, 1404, 1.8f, 1020, 760),
        new("v2", "half_horizontal", 1872, 1404, 1.8f, 1020, 375),
        new("v2", "half_vertical", 1872, 1404, 1.8f, 505, 760)
    };

    public static IEnumerable<object[]> ScenarioCases => AgendaScenarios.Ids.Select(id => new object[] { id });

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Ordinary_title_lowercase_s_keeps_readable_native_raster_ink(NativeView view)
    {
        var data = Agenda(primaryRows: 2, secondaryRows: 0);
        data["primary"]!["occurrences"]![0]!["title"] = "Finalize the Offers";
        data["primary"]!["occurrences"]![1]!["title"] = "Doors";
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);
        var titles = page.Locator(".agenda-primary tbody tr:visible td .title");
        await Assertions.Expect(titles).ToHaveCountAsync(2);
        async Task<JsonElement> Glyphs() => await titles.EvaluateAllAsync<JsonElement>("""
            titles => titles.map(title => {
              const text = title.firstChild;
              const range = document.createRange();
              const index = text.textContent.lastIndexOf("s");
              range.setStart(text, index);
              range.setEnd(text, index + 1);
              const box = range.getBoundingClientRect();
              return { text: title.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
            })
            """);
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        var image = Path.Combine(DisplayTests.Root, "artifacts", $"title-strokes-{view.Device}-{view.Placement}.png");
        var referenceImage = Path.Combine(DisplayTests.Root, "artifacts", $"title-strokes-{view.Device}-{view.Placement}-reference.png");
        var regions = await Glyphs();
        await page.ScreenshotAsync(new() { Path = image });
        using var actual = JsonDocument.Parse(DisplayTests.RunRuby(
            Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"), new { image, regions }));
        var weight = view.Device == "og" ? 700 : 600;
        await page.AddStyleTagAsync(new()
        {
            Content = $".agenda td .title {{ --title-font-weight: {weight} !important; font-weight: {weight} !important; font-variation-settings: 'wght' {weight} !important; }}"
        });
        await page.EvaluateAsync("() => document.fonts.ready");
        Assert.All(await titles.EvaluateAllAsync<string[]>(
            "titles => titles.map(title => getComputedStyle(title).fontWeight)"),
            actualWeight => Assert.Equal(weight.ToString(), actualWeight));
        regions = await Glyphs();
        await page.ScreenshotAsync(new() { Path = referenceImage });
        using var reference = JsonDocument.Parse(DisplayTests.RunRuby(
            Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"), new { image = referenceImage, regions }));
        for (var index = 0; index < regions.GetArrayLength(); index++)
        {
            var ink = actual.RootElement[index].GetProperty("dark_pixels").GetInt32();
            var referenceInk = reference.RootElement[index].GetProperty("dark_pixels").GetInt32();
            Assert.True(referenceInk >= 20, "The stronger native reference must paint a readable lowercase s.");
            Assert.True(ink >= referenceInk * 0.9,
                $"{view.Device}/{view.Placement}: lowercase s in {regions[index].GetProperty("text")} " +
                $"has {ink} dark pixels; require at least 90% of the stronger native reference ({referenceInk}).");
        }
    }

    [Fact]
    public async Task Empty_primary_dense_secondary_uses_reclaimed_space_without_changing_event_geometry()
    {
        var data = Agenda(primaryRows: 0, secondaryRows: 32);
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 800, Height = 480 } });
        await DisplayTests.Show(page, data);
        var rows = page.Locator(".agenda-secondary tbody tr:visible");
        var count = await rows.CountAsync();
        var metrics = await rows.First.EvaluateAsync<JsonElement>("""
            row => {
              const title = row.querySelector("td .title");
              const time = row.querySelector(".agenda-time");
              const style = getComputedStyle(title);
              const range = document.createRange();
              range.selectNodeContents(title);
              return {
                count: document.querySelectorAll(".agenda-secondary tbody tr:not([hidden])").length,
                font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
                titleLines: new Set([...range.getClientRects()].map(rect => rect.top)).size,
                timeWidth: time.getBoundingClientRect().width,
                padding: getComputedStyle(time).padding, rowHeight: row.getBoundingClientRect().height
              };
            }
            """);
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        await File.WriteAllTextAsync(Path.Combine(DisplayTests.Root, "artifacts", "density-agenda.json"), data.ToJsonString());
        await File.WriteAllTextAsync(Path.Combine(DisplayTests.Root, "artifacts", "density-metrics.json"), metrics.ToString());
        await VisibleInk(page, "density-og-full", new("og", "full", 800, 480, 1, 780, 460),
            await page.Locator(".agenda-heading .title, [data-agenda-source], .agenda-secondary tbody tr:not([hidden]) .label--large, .agenda-secondary tbody tr:not([hidden]) td .title").AllAsync());
        // The unchanged renderer at b0bd1e4 displayed eight rows for this exact fixture.
        Assert.True(count > 8, metrics.ToString());
        Assert.Equal("TRMNL21", metrics.GetProperty("font").GetString());
        Assert.Equal("21px", metrics.GetProperty("fontSize").GetString());
        Assert.Equal("29.4px", metrics.GetProperty("lineHeight").GetString());
        Assert.Equal(1, metrics.GetProperty("titleLines").GetInt32());
        Assert.Equal(230, metrics.GetProperty("timeWidth").GetInt32());
        Assert.Equal("2px 0px", metrics.GetProperty("padding").GetString());
        Assert.Equal(33.390625, metrics.GetProperty("rowHeight").GetDouble(), precision: 4);
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Empty_days_keep_date_and_message_on_one_line_without_a_zero_count(NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, Agenda(primaryRows: 0, secondaryRows: 0), view.Placement, view.Device);
        foreach (var name in new[] { "primary", "secondary" })
        {
            var day = page.Locator($".agenda-{name}");
            var date = await day.Locator(".agenda-heading .title").BoundingBoxAsync();
            var empty = await day.Locator(".agenda-empty").BoundingBoxAsync();
            Assert.NotNull(date);
            Assert.NotNull(empty);
            Assert.True(Math.Max(date.Y, empty.Y) < Math.Min(date.Y + date.Height, empty.Y + empty.Height),
                "Empty date and message must share one line.");
            Assert.DoesNotContain("0 event", await day.InnerTextAsync());
            Assert.DoesNotContain("eligible", await day.InnerTextAsync());
        }
    }

    [Theory]
    [MemberData(nameof(ScenarioCases))]
    public async Task Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views(
        string scenario)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { DeviceScaleFactor = 1 });
        foreach (var values in Views.Cast<object[]>())
        {
            var view = Assert.IsType<NativeView>(values[0]);
            await page.SetViewportSizeAsync(view.PhysicalWidth, view.PhysicalHeight);
            var data = AgendaScenarios.Load(scenario);
            await DisplayTests.Show(page, data, view.Placement, view.Device);
            await NativeBounds(page, view);
            var emphases = new[] { "primary", "secondary" }
                .SelectMany(name => data[name]!["occurrences"]!.AsArray())
                .Select(item => item!["emphasis"]?.GetValue<string>()).OfType<string>().Distinct();
            foreach (var emphasis in emphases)
            {
                var status = emphasis == "in_progress" ? "IN PROGRESS" : "UPCOMING";
                Assert.True(await page.Locator(".agenda-emphasized:visible").CountAsync() > 0,
                    $"{scenario}/{view.Device}/{view.Placement} must retain an emphasized card.");
                await Assertions.Expect(page.GetByText(status, new() { Exact = true }).First).ToBeVisibleAsync();
            }
            var findings = await page.EvaluateAsync<JsonElement>("""
                async input => {
                  const checks = await import("/workbench/layout-checks.mjs");
                  return checks.checkLayout(document, JSON.parse(input.agendaJson), input.target).filter(item => !item.passed);
                }
                """, new { agendaJson = data.ToJsonString(), target = new { width = view.PhysicalWidth, height = view.PhysicalHeight } });
            Assert.True(findings.GetArrayLength() == 0, $"{scenario}/{view.Device}/{view.Placement}: {findings}");
            await VisibleInk(page, $"scenario-{scenario}-{view.Device}-{view.Placement}", view,
                await page.Locator("""
                    .agenda-heading .title, .agenda-day-label .label, .agenda-source > span, [data-agenda-source],
                    .agenda-warning > *, .agenda > .title, .agenda > .label:not(.agenda-source), .agenda > .description,
                    tbody tr:not([hidden]) .label--large, tbody tr:not([hidden]) .agenda-participation,
                    tbody tr.agenda-emphasized:not([hidden]) .title,
                    tbody tr.agenda-emphasized:not([hidden]) .agenda-status
                    """).AllAsync());
            Assert.Null(await page.EvaluateAsync<int?>("window.pwn"));
            Assert.Null(await page.EvaluateAsync<int?>("window.locationPwn"));
        }
    }

    [Fact]
    public async Task Raster_ink_requires_painted_inverse_and_ordinary_text_not_just_background()
    {
        var view = new NativeView("og", "full", 800, 480, 1, 780, 460);
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await page.RouteAsync("http://trmnl.local/", route => route.FulfillAsync(new()
        {
            Body = """
                <!doctype html>
                <style>
                  body { margin: 0; }
                  .view { width: 800px; height: 480px; overflow: hidden; }
                  span { display: block; padding: 8px; font: bold 24px/32px sans-serif; }
                  .inverse { background: black; color: white; }
                  .ordinary { background: white; color: black; }
                </style>
                <main class="view">
                  <span class="inverse">Inverse title</span>
                  <span class="inverse">IN PROGRESS</span>
                  <span class="inverse">11:00 AM - 12:00 PM</span>
                  <span class="ordinary">Ordinary title</span>
                </main>
                """,
            ContentType = "text/html"
        }));
        await page.RouteAsync("http://trmnl.local/workbench/layout-checks.mjs", route => route.FulfillAsync(new()
        {
            Path = Path.Combine(DisplayTests.Root, "display", "workbench", "layout-checks.mjs"),
            ContentType = "application/javascript"
        }));
        await page.GotoAsync("http://trmnl.local/");
        var required = await page.Locator("span").AllAsync();
        await VisibleInk(page, "painted-foreground", view, required);
        foreach (var content in required)
        {
            var originalStyle = await content.GetAttributeAsync("style");
            try
            {
                await content.EvaluateAsync("""
                    element => element.style.setProperty("-webkit-text-fill-color", "transparent", "important")
                    """);
                await Assert.ThrowsAsync<Xunit.Sdk.TrueException>(() =>
                    VisibleInk(page, "unpainted-foreground", view, new[] { content }));
            }
            finally
            {
                await content.EvaluateAsync("""
                    (element, style) => {
                      if (style === null) element.removeAttribute("style");
                      else element.setAttribute("style", style);
                    }
                    """, originalStyle);
            }
        }
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Emphasized_secondary_event_is_admitted_ahead_of_ordinary_primary_overflow(NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["schema_version"] = 2;
        var secondary = data["secondary"]!["occurrences"]!.AsArray()[0]!.DeepClone();
        secondary["id"] = "secondary-emphasized";
        secondary["title"] = "Upcoming secondary event";
        secondary["emphasis"] = "upcoming";
        data["secondary"]!["eligible_total"] = 1;
        data["secondary"]!["occurrences"] = new JsonArray(secondary);
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);

        var emphasized = page.Locator(".agenda-secondary tbody tr.agenda-emphasized:visible");
        await Assertions.Expect(emphasized).ToHaveCountAsync(1);
        await Assertions.Expect(emphasized.GetByText("UPCOMING", new() { Exact = true })).ToBeVisibleAsync();
        var title = emphasized.Locator("td .title");
        Assert.Equal("700", await title.EvaluateAsync<string>("element => getComputedStyle(element).fontWeight"));
        if (view.Device == "v2")
            Assert.Equal("\"wght\" 700", await title.EvaluateAsync<string>(
                "element => getComputedStyle(element).fontVariationSettings"));
        await DayCount(page, "primary", 32);
        await DayCount(page, "secondary", 1);
        await NativeBounds(page, view);
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Emphasized_overflow_is_admitted_in_chronological_order_before_ordinary_rows(NativeView view)
    {
        var data = Agenda(primaryRows: 56, secondaryRows: 0);
        data["schema_version"] = 2;
        foreach (var occurrence in data["primary"]!["occurrences"]!.AsArray().Skip(32))
            occurrence!["emphasis"] = "in_progress";
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);

        var visible = page.Locator(".agenda-primary tbody tr.agenda-emphasized:visible");
        var visibleCount = await visible.CountAsync();
        Assert.InRange(visibleCount, 1, 23);
        Assert.Equal(32, await page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis])").CountAsync());
        Assert.Equal(0, await page.Locator(".agenda-primary tbody tr:not([data-agenda-emphasis]):visible").CountAsync());
        var ids = await visible.EvaluateAllAsync<string[]>("rows => rows.map(row => row.dataset.agendaId)");
        Assert.Equal(Enumerable.Range(33, visibleCount).Select(index => $"primary-{index:D3}"), ids);
        await DayCount(page, "primary", 56);
        await NativeBounds(page, view);
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Longer_working_day_labels_keep_partial_counts_inside_native_headers(NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        data["generated_at"] = "2026-11-25T19:00:00Z";
        data["source_succeeded_at"] = "2026-11-25T19:00:00Z";
        foreach (var (name, date, label) in new[]
        {
            ("primary", "2026-11-25", "Wednesday, Nov 25"),
            ("secondary", "2026-11-26", "Thursday, Nov 26")
        })
        {
            data[name]!["date"] = date;
            data[name]!["label"] = label;
            foreach (var occurrence in data[name]!["occurrences"]!.AsArray())
            {
                occurrence!["start_at"] = $"{date}T19:00:00Z";
                occurrence["end_at"] = $"{date}T20:00:00Z";
            }
        }
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await VisibleInk(page, $"long-date-{view.Device}-{view.Placement}", view,
            await page.Locator(".agenda-heading .title, .agenda-count, [data-agenda-source]").AllAsync());
        foreach (var name in new[] { "primary", "secondary" })
        {
            data[name]!["eligible_total"] = 0;
            data[name]!["occurrences"] = new JsonArray();
        }
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await VisibleInk(page, $"long-date-empty-{view.Device}-{view.Placement}", view,
            await page.Locator(".agenda-heading .title, .agenda-empty, [data-agenda-source]").AllAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Counts_disclose_displayed_rows_and_complete_totals_even_without_occurrences(NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        var data = Agenda(primaryRows: 0, secondaryRows: 0);
        data["primary"]!["eligible_total"] = 9;
        data["secondary"]!["eligible_total"] = 1;
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await VisibleInsideView(page.GetByText("0 of 9 events shown", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("0 of 1 event shown", new() { Exact = true }));
        Assert.DoesNotContain("No remaining events", await page.Locator(".agenda").InnerTextAsync());
        Assert.Equal(0, await page.Locator(".agenda-overflow, .agenda-footer, .title_bar").CountAsync());
        await VisibleInk(page, $"zero-visible-{view.Device}-{view.Placement}", view,
            await page.Locator(".agenda-heading .title, .agenda-count, [data-agenda-source]").AllAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Essential_agenda_information_fits_each_native_physical_device_and_placement(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, DisplayTests.CurrentAgenda(), view.Placement, view.Device);

        await NativeBounds(page, view);
        var screenshot = await page.ScreenshotAsync();
        Assert.Equal(view.PhysicalWidth, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(16, 4)));
        Assert.Equal(view.PhysicalHeight, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(20, 4)));

        foreach (var text in new[]
        {
            "Friday, Oct 23", "1 event", "Synthetic planning", "11:00 AM - 12:00 PM",
            "Monday, Oct 26", "0 of 3 events shown", "Oct 23, 2026, 11:00 AM PDT"
        })
            await VisibleInsideView(page.GetByText(text, new() { Exact = true }));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Busy_primary_days_reserve_truthful_overflow_before_secondary_details(
        NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        data["secondary"]!["eligible_total"] = 19;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        var visible = page.Locator(".agenda-primary [data-agenda-start]:visible");
        var count = await visible.CountAsync();
        Assert.InRange(count, 1, 31);
        await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
        await DayCount(page, "primary", 47);
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await DayCount(page, "secondary", 19);
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
        Assert.Equal(0, await page.Locator(".agenda-secondary [data-agenda-start]:visible").CountAsync());
        for (var index = 0; index < count; index++)
        {
            await VisibleInsideView(visible.Nth(index));
            await VisibleInsideView(page.GetByText($"Primary commitment {index + 1}", new() { Exact = true }));
        }
        Assert.True(await visible.First.EvaluateAsync<float>(
            "element => parseFloat(getComputedStyle(element).fontSize)") >= 20);
        await ReadableRows(page.Locator(".agenda-primary tbody tr:visible"));
        var required = page.Locator("""
            .agenda-day .agenda-heading .title, .agenda-day .agenda-day-label .label,
            [data-agenda-source],
            .agenda-primary tbody tr:not([hidden]) .label--large,
            .agenda-primary tbody tr:not([hidden]) td .title
            """);
        Assert.Equal(5 + 2 * count, await required.CountAsync());
        await VisibleInk(page, $"busy-{(view.Device == "v2" ? "x" : view.Device)}-{view.Placement}",
            view, await required.AllAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Remaining_room_shows_secondary_details_and_their_truthful_overflow(
        NativeView view)
    {
        var data = Agenda(primaryRows: 1, secondaryRows: 32);
        data["secondary"]!["eligible_total"] = 50;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        await VisibleInsideView(page.GetByText("Primary commitment 1", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("1 event", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await DayCount(page, "secondary", 50);
        var secondary = page.Locator(".agenda-secondary [data-agenda-start]:visible");
        var count = await secondary.CountAsync();
        Assert.InRange(count, view.Device == "og" && view.Placement == "half_horizontal" ? 0 : 1, 31);
        for (var index = 0; index < count; index++)
        {
            await VisibleInsideView(secondary.Nth(index));
            await VisibleInsideView(page.GetByText($"Secondary commitment {index + 1}", new() { Exact = true }));
        }
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Optional_locations_use_only_space_left_after_essential_rows(
        NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
                occurrence!["location"] = null;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        var primaryCount = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        var secondaryCount = await page.Locator(".agenda-secondary tbody tr:visible").CountAsync();
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
                occurrence!["location"] = $"Optional studio {new string('W', 400)}";
        await DisplayTests.Show(page, data, view.Placement, view.Device);

        Assert.Equal(primaryCount, await page.Locator(".agenda-primary tbody tr:visible").CountAsync());
        Assert.Equal(secondaryCount, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
        Assert.True(await page.Locator(".agenda-location:visible").CountAsync() < primaryCount);
        await DayCount(page, "primary", 32);
        await VisibleInsideView(page.Locator("[data-agenda-source]"));

        await DisplayTests.Show(page, Agenda(primaryRows: 1, secondaryRows: 0), view.Placement, view.Device);
        await NativeBounds(page, view);
        await VisibleInsideView(page.Locator(".agenda-primary").GetByText("Studio A", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Primary commitment 1", new() { Exact = true }));
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Dense_long_titles_use_one_title_line_and_keep_truthful_ordered_fitting(
        NativeView view)
    {
        var data = DenseLongTitleAgenda();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        var rows = page.Locator(".agenda-primary tbody tr:visible");
        var count = await rows.CountAsync();
        Assert.InRange(count, 1, 31);
        Assert.Equal(0, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
        await DayCount(page, "primary", 47);
        await DayCount(page, "secondary", 19);
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
        for (var index = 0; index < count; index++)
        {
            Assert.Equal(data["primary"]!["occurrences"]![index]!["title"]!.GetValue<string>(),
                await rows.Nth(index).Locator("td .title").TextContentAsync());
            await VisibleInsideView(rows.Nth(index).Locator("[data-agenda-start]"));
        }

        var measurements = await rows.EvaluateAllAsync<JsonElement>("""
            rows => rows.map(row => {
              const title = row.querySelector("td .title");
              const style = getComputedStyle(title);
              const time = row.querySelector(".agenda-time");
              const timing = time.querySelector(".label");
              const range = document.createRange();
              range.selectNodeContents(title);
              return {
                titleHeight: parseFloat(style.height), lineHeight: parseFloat(style.lineHeight),
                fontSize: parseFloat(style.fontSize), fontFamily: style.fontFamily,
                textLines: [...new Set([...range.getClientRects()].map(rect => rect.top))].length,
                timeWidth: getComputedStyle(time).width,
                timeFontSize: getComputedStyle(timing).fontSize,
                timeFontFamily: getComputedStyle(timing).fontFamily,
                paddingTop: getComputedStyle(time).paddingTop,
                paddingBottom: getComputedStyle(time).paddingBottom
              };
            })
            """);
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        await page.ScreenshotAsync(new()
        {
            Path = Path.Combine(DisplayTests.Root, "artifacts", $"title-density-{view.Device}-{view.Placement}.png")
        });
        await File.WriteAllTextAsync(
            Path.Combine(DisplayTests.Root, "artifacts", $"title-density-{view.Device}-{view.Placement}.json"),
            JsonSerializer.Serialize(new { count, measurements }));
        Assert.True(measurements.EnumerateArray().All(item =>
            item.GetProperty("textLines").GetInt32() == 1
            && item.GetProperty("titleHeight").GetDouble() <= item.GetProperty("lineHeight").GetDouble() + 1),
            $"{view.Device}/{view.Placement}: {count} displayed primary events; {measurements[0]}");
        if (view is { Device: "og", Placement: "full" })
            Assert.True(count > 4, "The unchanged two-line renderer displayed four events for this same fixture.");
        await ReadableRows(rows);
        var required = page.Locator("""
            .agenda-heading .title, .agenda-day-label .label, [data-agenda-source],
            .agenda-primary tbody tr:not([hidden]) .label--large,
            .agenda-primary tbody tr:not([hidden]) td .title
            """);
        Assert.Equal(5 + 2 * count, await required.CountAsync());
        await VisibleInk(page, $"title-density-{view.Device}-{view.Placement}", view, await required.AllAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Timed_and_all_day_titles_preserve_text_and_typography_with_visible_end_ellipsis(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight },
            DeviceScaleFactor = 1
        });
        foreach (var (name, text) in new[]
        {
            ("short", "Plan"),
            ("long", string.Join(" ", Enumerable.Repeat("A very long calendar planning title", 20))),
            ("unbroken", new string('W', 600)),
            ("markup", $"<svg onload=window.pwn=1> & \"quoted\" {new string('W', 600)}")
        })
            foreach (var allDay in new[] { false, true })
            {
                var data = Agenda(primaryRows: 1, secondaryRows: 0);
                var occurrence = data["primary"]!["occurrences"]![0]!.AsObject();
                occurrence["title"] = text;
                occurrence["location"] = null;
                if (allDay)
                {
                    occurrence["time_kind"] = "all_day";
                    occurrence.Remove("start_at");
                    occurrence.Remove("end_at");
                    occurrence["start_date"] = "2026-10-23";
                    occurrence["end_date_exclusive"] = "2026-10-24";
                }
                await DisplayTests.Show(page, data, view.Placement, view.Device);
                await NativeBounds(page, view);
                var row = page.Locator(".agenda-primary tbody tr:visible");
                await Assertions.Expect(row).ToHaveCountAsync(1);
                var title = row.Locator("td .title");
                Assert.Equal(text, await title.TextContentAsync());
                await VisibleInsideView(title, textMayBeTruncated: true);
                await ReadableRows(row);
                var timing = row.Locator(".agenda-time .label");
                Assert.Equal(allDay ? "All day" : "11:00 AM - 12:00 PM",
                    (await timing.InnerTextAsync()).Trim());
                await VisibleInsideView(timing);
                Assert.Null(await page.EvaluateAsync<int?>("window.pwn"));
                Assert.Equal(0, await page.Locator(".agenda svg, .agenda img, .agenda script").CountAsync());
                var metrics = await row.EvaluateAsync<JsonElement>("""
                    row => {
                      const title = row.querySelector("td .title");
                      const time = row.querySelector(".agenda-time");
                      const label = time.querySelector(".label");
                      const style = getComputedStyle(title);
                      return {
                        font: style.fontFamily, size: parseFloat(style.fontSize),
                        lineHeight: parseFloat(style.lineHeight),
                        timeSize: parseFloat(getComputedStyle(label).fontSize),
                        timeFont: getComputedStyle(label).fontFamily,
                        timeWidth: parseFloat(getComputedStyle(time).width),
                        paddingTop: getComputedStyle(time).paddingTop,
                        paddingBottom: getComputedStyle(time).paddingBottom,
                        timeAbove: label.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1,
                        overflowing: title.scrollWidth > title.clientWidth
                      };
                    }
                    """);
                Assert.Equal(21, metrics.GetProperty("size").GetDouble());
                Assert.Equal(29.4, metrics.GetProperty("lineHeight").GetDouble(), precision: 1);
                Assert.Equal(view.Device == "og" ? "TRMNL21" : "\"Inter Variable\", Inter",
                    metrics.GetProperty("font").GetString());
                Assert.Equal(21, metrics.GetProperty("timeSize").GetDouble());
                Assert.Equal("\"Inter Variable\", Inter", metrics.GetProperty("timeFont").GetString());
                Assert.Equal("2px", metrics.GetProperty("paddingTop").GetString());
                Assert.Equal("2px", metrics.GetProperty("paddingBottom").GetString());
                var compact = view.LogicalViewWidth < 600;
                Assert.Equal(compact, metrics.GetProperty("timeAbove").GetBoolean());
                if (!compact) Assert.Equal(230, metrics.GetProperty("timeWidth").GetDouble());
                Assert.Equal(name != "short", metrics.GetProperty("overflowing").GetBoolean());
                await TitleEndInk(page, title,
                    $"title-{view.Device}-{view.Placement}-{name}-{(allDay ? "all-day" : "timed")}",
                    view, overflowing: name != "short");
            }
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Long_untrusted_calendar_strings_cannot_displace_essential_information_or_execute_markup(
        NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
            {
                occurrence!["title"] = $"{occurrence["title"]!.GetValue<string>()} <svg onload=window.pwn=1> & \"quoted\" {new string('W', 600)}";
                occurrence["location"] = $"Studio </span><img src=x onerror=window.locationPwn=1> {new string('W', 600)}";
                occurrence["description"] = "DO NOT DISPLAY DESCRIPTION";
                occurrence["attendees"] = new JsonArray("DO NOT DISPLAY ATTENDEE");
            }
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        var count = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        Assert.InRange(count, 1, 31);
        await DayCount(page, "primary", 47);
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await DayCount(page, "secondary", 12);
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
        var title = page.Locator(".agenda-primary td .title:visible").First;
        Assert.Equal(data["primary"]!["occurrences"]![0]!["title"]!.GetValue<string>(), await title.InnerTextAsync());
        await VisibleInsideView(title, textMayBeTruncated: true);
        await VisibleInsideView(page.Locator(".agenda-primary [data-agenda-start]:visible").First);
        Assert.True(await title.EvaluateAsync<float>("element => parseFloat(getComputedStyle(element).fontSize)") >= 20);
        Assert.Null(await page.EvaluateAsync<int?>("window.pwn"));
        Assert.Null(await page.EvaluateAsync<int?>("window.locationPwn"));
        Assert.Equal(0, await page.Locator(".agenda svg, .agenda img, .agenda script").CountAsync());
        Assert.DoesNotContain("DO NOT DISPLAY", await page.Locator("body").InnerTextAsync());

        var sparse = Agenda(primaryRows: 1, secondaryRows: 0);
        const string location = "Studio <svg onload=window.locationPwn=1> & \"North\"";
        sparse["primary"]!["occurrences"]![0]!["location"] = location;
        await DisplayTests.Show(page, sparse, view.Placement, view.Device);
        var visibleLocation = page.Locator(".agenda-primary .agenda-location:visible");
        Assert.Equal(location, await visibleLocation.InnerTextAsync());
        await VisibleInsideView(visibleLocation, textMayBeTruncated: true);
        Assert.Null(await page.EvaluateAsync<int?>("window.locationPwn"));
        Assert.Equal(0, await page.Locator(".agenda svg").CountAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task All_day_contract_entries_keep_their_label_and_weekend_Monday_priority(
        NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["generated_at"] = "2026-10-24T18:05:00Z";
        data["source_succeeded_at"] = "2026-10-24T18:00:00Z";
        data["primary"]!["date"] = "2026-10-26";
        data["primary"]!["label"] = "Monday, Oct 26";
        data["primary"]!["eligible_total"] = 47;
        data["secondary"]!["date"] = "2026-10-27";
        data["secondary"]!["label"] = "Tuesday, Oct 27";
        data["primary"]!["occurrences"]![0] = new JsonObject
        {
            ["time_kind"] = "all_day",
            ["id"] = "synthetic-all-day",
            ["title"] = "All-day preparation",
            ["participation_expectation"] = "definite",
            ["location"] = null,
            ["start_date"] = "2026-10-23",
            ["end_date_exclusive"] = "2026-10-27"
        };
        foreach (var occurrence in data["primary"]!["occurrences"]!.AsArray().Skip(1))
        {
            occurrence!["start_at"] = "2026-10-26T18:00:00Z";
            occurrence["end_at"] = "2026-10-26T19:00:00Z";
        }
        foreach (var occurrence in data["secondary"]!["occurrences"]!.AsArray())
        {
            occurrence!["start_at"] = "2026-10-27T18:00:00Z";
            occurrence["end_at"] = "2026-10-27T19:00:00Z";
        }
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        var rows = page.Locator(".agenda-primary tbody tr:visible");
        var count = await rows.CountAsync();
        Assert.InRange(count, 1, 31);
        await VisibleInsideView(rows.First.GetByText("All day", new() { Exact = true }));
        await VisibleInsideView(rows.First.GetByText("All-day preparation", new() { Exact = true }));
        Assert.Equal(0, await rows.First.Locator("[data-agenda-start], [data-agenda-end]").CountAsync());
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Tuesday, Oct 27", new() { Exact = true }));
        await DayCount(page, "primary", 47);
        await DayCount(page, "secondary", 12);
        await VisibleInsideView(page.GetByText("Oct 24, 2026, 11:00 AM PDT", new() { Exact = true }));
        Assert.Equal(0, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
        Assert.DoesNotContain("tomorrow", await page.Locator("body").InnerTextAsync(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("12:00 AM", await rows.First.InnerTextAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Stale_contract_keeps_commitments_warning_and_original_source_success_visible(
        NativeView view)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["state"] = "stale";
        data["generated_at"] = "2026-10-23T18:45:00Z";
        data["primary"]!["eligible_total"] = 47;
        data["error"] = new JsonObject
        {
            ["code"] = "source_unavailable",
            ["message"] = "The calendar source could not be checked."
        };
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);

        await VisibleInsideView(page.GetByText("Stale agenda", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("The calendar source could not be checked.", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
        await DayCount(page, "primary", 47);
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await DayCount(page, "secondary", 12);
        var count = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        Assert.True(count is >= 1 and <= 31, await page.Locator(".agenda").EvaluateAsync<string>("""
            element => JSON.stringify({
              height: element.clientHeight, used: element.scrollHeight,
              children: [...element.children].map(child => ({
                className: child.className, height: child.getBoundingClientRect().height
              }))
            })
            """));
        await VisibleInsideView(page.GetByText("Oct 23, 2026, 11:00 AM PDT", new() { Exact = true }));
        await Assertions.Expect(page.Locator("[data-agenda-source]"))
            .ToHaveAttributeAsync("datetime", "2026-10-23T18:00:00Z");
        Assert.DoesNotContain("11:45", await page.Locator("body").InnerTextAsync());
        Assert.DoesNotContain("Agenda unavailable", await page.Locator("body").InnerTextAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Configuration_source_compatibility_and_unknown_errors_are_readable_not_empty_agendas(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        foreach (var (code, kind, message, knownSuccess) in new[]
        {
            ("configuration_invalid", "Configuration error", "Rule configuration is missing or malformed.", false),
            ("source_unavailable", "Source error", "The calendar source could not be checked.", false),
            ("compatibility_unsupported", "Compatibility error", "The source contains unsupported calendar semantics.", false),
            ("agenda_too_large", "Agenda error", "The agenda metadata exceeds the polling response budget.", true),
            ("future_error", "Agenda error", "Synthetic failure <img src=x onerror=window.pwn=1> & \"quoted\".", false)
        })
        {
            var data = Agenda(primaryRows: 0, secondaryRows: 0);
            data["state"] = "error";
            data["generated_at"] = "2026-10-23T23:45:00Z";
            data["source_succeeded_at"] = knownSuccess ? "2026-10-23T18:00:00Z" : null;
            data["primary"]!["eligible_total"] = null;
            data["secondary"]!["eligible_total"] = null;
            data["error"] = new JsonObject { ["code"] = code, ["message"] = message };
            await DisplayTests.Show(page, data, view.Placement, view.Device);
            await NativeBounds(page, view);

            await VisibleInsideView(page.GetByText("Agenda unavailable", new() { Exact = true }));
            await VisibleInsideView(page.GetByText(kind, new() { Exact = true }));
            await VisibleInsideView(page.GetByText(message, new() { Exact = true }));
            await VisibleInsideView(page.GetByText(code, new() { Exact = true }));
            await VisibleInsideView(page.GetByText(knownSuccess
                ? "Oct 23, 2026, 11:00 AM PDT" : "No successful source check", new() { Exact = true }));
            var text = await page.Locator("body").InnerTextAsync();
            Assert.DoesNotContain("eligible event", text);
            Assert.DoesNotContain("No remaining events", text);
            Assert.DoesNotContain("4:45", text);
            Assert.Null(await page.EvaluateAsync<int?>("window.pwn"));
            Assert.Equal(0, await page.Locator(".agenda img").CountAsync());
        }
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Empty_primary_days_keep_selected_dates_instead_of_promoting_secondary_commitments(
        NativeView view)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        foreach (var secondaryRows in new[] { 0, 32 })
        {
            await DisplayTests.Show(page, Agenda(primaryRows: 0, secondaryRows), view.Placement, view.Device);
            await NativeBounds(page, view);
            await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
            await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
            await VisibleInsideView(page.Locator(".agenda-primary").GetByText("No remaining events", new() { Exact = true }));
            await VisibleInsideView(page.Locator(".agenda-primary .agenda-empty"));
            Assert.Equal(0, await page.Locator(".agenda-primary tbody tr:visible").CountAsync());
            if (secondaryRows == 0)
            {
                await VisibleInsideView(page.Locator(".agenda-secondary").GetByText("No remaining events", new() { Exact = true }));
                await VisibleInsideView(page.Locator(".agenda-secondary .agenda-empty"));
            }
            else
            {
                await DayCount(page, "secondary", 32);
                await VisibleInsideView(page.GetByText("Secondary commitment 1", new() { Exact = true }));
            }
            await VisibleInsideView(page.Locator("[data-agenda-source]"));
            var text = await page.Locator("body").InnerTextAsync();
            Assert.DoesNotContain("Agenda unavailable", text);
            Assert.DoesNotContain("Stale agenda", text);
            Assert.DoesNotContain("tomorrow", text, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task Larger_native_views_use_extra_room_for_primary_then_secondary_commitments()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var counts = new Dictionary<(string Device, string Placement), (int Primary, int Secondary)>();
        foreach (var (device, width, height) in new[] { ("og", 800, 480), ("v2", 1872, 1404) })
            foreach (var placement in new[] { "full", "half_horizontal", "half_vertical" })
            {
                var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
                await DisplayTests.Show(page, Agenda(primaryRows: 32, secondaryRows: 12), placement, device);
                var primary = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
                Assert.Equal(0, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
                await DisplayTests.Show(page, Agenda(primaryRows: 1, secondaryRows: 32), placement, device);
                await VisibleInsideView(page.GetByText("Primary commitment 1", new() { Exact = true }));
                var secondary = await page.Locator(".agenda-secondary tbody tr:visible").CountAsync();
                counts[(device, placement)] = (primary, secondary);
                await page.CloseAsync();
            }

        foreach (var placement in new[] { "full", "half_horizontal", "half_vertical" })
        {
            Assert.True(counts[("v2", placement)].Primary > counts[("og", placement)].Primary);
            Assert.True(counts[("v2", placement)].Secondary > counts[("og", placement)].Secondary);
        }
        foreach (var device in new[] { "og", "v2" })
        {
            Assert.True(counts[(device, "full")].Primary > counts[(device, "half_horizontal")].Primary);
            Assert.True(counts[(device, "full")].Secondary > counts[(device, "half_horizontal")].Secondary);
        }
    }

    [Fact]
    public async Task Fitting_reacts_to_available_view_dimensions_without_a_per_device_row_limit()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = 1872, Height = 1404 } });
        await DisplayTests.Show(page, Agenda(primaryRows: 32, secondaryRows: 12), "full", "v2");
        var rows = page.Locator(".agenda-primary tbody tr:visible");
        var original = await rows.CountAsync();
        await page.Locator(".agenda-view").EvaluateAsync("element => { element.style.height = '350px'; }");
        await page.WaitForFunctionAsync("""
            original => document.querySelector(".agenda").dataset.agendaReady === "true"
              && [...document.querySelectorAll(".agenda-primary tbody tr")].filter(row => !row.hidden).length < original
            """, original);
        var compact = await rows.CountAsync();
        Assert.InRange(compact, 1, original - 1);
        await DayCount(page, "primary", 32);
        await DayCount(page, "secondary", 12);
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
        await page.Locator(".agenda-view").EvaluateAsync("element => { element.style.removeProperty('height'); }");
        await Assertions.Expect(rows).ToHaveCountAsync(original);
        await DayCount(page, "primary", 32);
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Native_capture_readiness_is_not_published_before_production_fitting_completes(
        NativeView view)
    {
        var data = DenseLongTitleAgenda();
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = view.PhysicalWidth, Height = view.PhysicalHeight }
        });
        await page.AddInitScriptAsync("""
            (() => {
              let ready;
              window.agendaNativeReadySnapshots = [];
              Object.defineProperty(window, "TRMNL_PLUGINS_READY", {
                configurable: true,
                get: () => ready,
                set: value => {
                  ready = value;
                  const agenda = document.querySelector(".agenda");
                  if (value !== true || !agenda) return;
                  const view = agenda.closest(".view").getBoundingClientRect();
                  const inside = element => {
                    const box = element.getBoundingClientRect();
                    return box.width > 0 && box.height > 0 && box.left >= view.left
                      && box.top >= view.top && box.right <= view.right && box.bottom <= view.bottom;
                  };
                  const primary = agenda.querySelector(".agenda-primary");
                  const count = primary.querySelector(".agenda-count");
                  window.agendaNativeReadySnapshots.push({
                    fitted: agenda.dataset.agendaReady === "true",
                    rows: [...primary.querySelectorAll("tbody tr")].filter(row => !row.hidden).length,
                    count: count.textContent,
                    countInside: inside(count),
                    secondaryCount: agenda.querySelector(".agenda-secondary .agenda-count").textContent,
                    sourceInside: inside(document.querySelector("[data-agenda-source]")),
                    countsInside: [...agenda.querySelectorAll(".agenda-heading .title, .agenda-day-label .label")]
                      .every(inside),
                    timesInside: [...primary.querySelectorAll("tr:not([hidden]) [data-agenda-start]")]
                      .every(time => inside(time) && time.textContent === "11:00 AM - 12:00 PM"),
                    titlesCorrect: [...primary.querySelectorAll("tr:not([hidden]) td .title")].every(title => {
                      const style = getComputedStyle(title);
                      const range = document.createRange();
                      range.selectNodeContents(title);
                      const rectangles = [...range.getClientRects()];
                      return inside(title) && parseFloat(style.fontSize) === 21
                        && title.clientHeight <= Math.ceil(parseFloat(style.lineHeight)) + 1
                        && rectangles.every(rect => Math.abs(rect.top - rectangles[0].top) < 1);
                    })
                  });
                }
              });
            })();
            """);
        await DisplayTests.Show(page, data, view.Placement, view.Device);
        await NativeBounds(page, view);
        var snapshots = await page.EvaluateAsync<JsonElement>("window.agendaNativeReadySnapshots");
        Assert.NotEmpty(snapshots.EnumerateArray());
        foreach (var snapshot in snapshots.EnumerateArray())
        {
            Assert.True(snapshot.GetProperty("fitted").GetBoolean(), snapshot.GetRawText());
            var count = snapshot.GetProperty("rows").GetInt32();
            Assert.InRange(count, 1, 31);
            Assert.Equal($"{count} of 47 events shown", snapshot.GetProperty("count").GetString());
            Assert.Equal("0 of 19 events shown", snapshot.GetProperty("secondaryCount").GetString());
            Assert.True(snapshot.GetProperty("countInside").GetBoolean());
            Assert.True(snapshot.GetProperty("sourceInside").GetBoolean());
            Assert.True(snapshot.GetProperty("countsInside").GetBoolean());
            Assert.True(snapshot.GetProperty("timesInside").GetBoolean());
            Assert.True(snapshot.GetProperty("titlesCorrect").GetBoolean());
        }
    }

    private static JsonObject DenseLongTitleAgenda()
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        data["secondary"]!["eligible_total"] = 19;
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
            {
                occurrence!["title"] = $"{occurrence["title"]!.GetValue<string>()}: " +
                    string.Concat(Enumerable.Repeat("Planning across native placements at unchanged readable typography. ", 8));
                occurrence["location"] = null;
            }
        return data;
    }

    private static JsonObject Agenda(int primaryRows, int secondaryRows)
    {
        if ((primaryRows, secondaryRows) is (32, 12) or (1, 32))
        {
            var scenario = AgendaScenarios.Load(primaryRows == 32 ? "dense-primary" : "dense-secondary");
            scenario["primary"]!["eligible_total"] = primaryRows;
            scenario["secondary"]!["eligible_total"] = secondaryRows;
            return scenario;
        }
        var data = DisplayTests.CurrentAgenda();
        var prototype = data["primary"]!["occurrences"]![0]!.DeepClone();
        foreach (var (day, label, count) in new[]
        {
            ("primary", "Primary", primaryRows), ("secondary", "Secondary", secondaryRows)
        })
        {
            var occurrences = new JsonArray();
            for (var index = 1; index <= count; index++)
            {
                var occurrence = prototype.DeepClone();
                occurrence["id"] = $"{day}-{index:D3}";
                occurrence["title"] = $"{label} commitment {index}";
                if (day == "secondary")
                {
                    occurrence["start_at"] = "2026-10-26T18:00:00Z";
                    occurrence["end_at"] = "2026-10-26T19:00:00Z";
                }
                occurrences.Add(occurrence);
            }
            data[day]!["eligible_total"] = count;
            data[day]!["occurrences"] = occurrences;
        }
        return data;
    }

    internal static async Task<ILocator> DayCount(IPage page, string name, int total)
    {
        var day = page.Locator($".agenda-{name}");
        var visible = await day.Locator("tbody tr:visible").CountAsync();
        var text = total == 0 ? "No remaining events"
            : visible == total ? $"{total} event{(total == 1 ? "" : "s")}"
            : $"{visible} of {total} event{(total == 1 ? "" : "s")} shown";
        var count = day.GetByText(text, new() { Exact = true });
        await VisibleInsideView(count);
        return count;
    }

    internal static async Task NativeBounds(IPage page, NativeView nativeView)
    {
        var screen = await page.Locator(".screen").BoundingBoxAsync();
        var view = await page.Locator(".view:has(.agenda)").BoundingBoxAsync();
        Assert.NotNull(screen);
        Assert.NotNull(view);
        Assert.Equal(nativeView.PhysicalWidth, screen.Width);
        Assert.Equal(nativeView.PhysicalHeight, screen.Height);
        Assert.Equal(nativeView.LogicalViewWidth * nativeView.Density, view.Width, precision: 1);
        Assert.Equal(nativeView.LogicalViewHeight * nativeView.Density, view.Height, precision: 1);
    }

    internal static async Task VisibleInk(IPage page, string name, NativeView view, IEnumerable<ILocator> required)
    {
        var regions = new List<JsonElement>();
        var contents = required.ToList();
        contents.AddRange(await page.Locator(".agenda-participation:visible").AllAsync());
        foreach (var content in contents)
        {
            await VisibleInsideView(content, textMayBeTruncated:
                await content.EvaluateAsync<bool>("element => element.matches('td .title')"));
            regions.Add(await content.EvaluateAsync<JsonElement>("""
                element => {
                  const box = element.getBoundingClientRect();
                  return { text: element.textContent.trim(), x: box.x, y: box.y, width: box.width, height: box.height };
                }
                """));
        }
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        var image = Path.Combine(DisplayTests.Root, "artifacts", $"{name}.png");
        var comparison = Path.Combine(DisplayTests.Root, "artifacts", $"{name}-no-text.png");
        var screenshot = await page.ScreenshotAsync(new() { Path = image });
        Assert.Equal(view.PhysicalWidth, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(16, 4)));
        Assert.Equal(view.PhysicalHeight, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(20, 4)));
        await page.ScreenshotAsync(new()
        {
            Path = comparison,
            Style = "* { -webkit-text-fill-color: transparent !important; text-shadow: none !important; }"
        });
        using var ink = JsonDocument.Parse(DisplayTests.RunRuby(
            Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"),
            new { image, comparison_image = comparison, regions }));
        foreach (var region in ink.RootElement.EnumerateArray())
            Assert.True(region.GetProperty("different_pixels").GetInt32() >= 20,
                $"Required text has no readable raster ink: {region.GetProperty("text").GetString()}");
    }

    private static async Task TitleEndInk(IPage page, ILocator title, string name, NativeView view, bool overflowing)
    {
        var region = await title.EvaluateAsync<JsonElement>("""
            (element, density) => {
              const box = element.getBoundingClientRect();
              const width = Math.min(box.width, 48 * density);
              return { text: element.textContent, x: box.right - width, y: box.top, width, height: box.height };
            }
            """, (double)view.Density);
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        var image = Path.Combine(DisplayTests.Root, "artifacts", $"{name}.png");
        var comparison = Path.Combine(DisplayTests.Root, "artifacts", $"{name}-clip.png");
        var screenshot = await page.ScreenshotAsync(new() { Path = image });
        Assert.Equal(view.PhysicalWidth, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(16, 4)));
        Assert.Equal(view.PhysicalHeight, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(20, 4)));
        await title.EvaluateAsync("element => { element.style.textOverflow = 'clip'; }");
        try
        {
            await page.ScreenshotAsync(new() { Path = comparison });
        }
        finally
        {
            await title.EvaluateAsync("element => { element.style.removeProperty('text-overflow'); }");
        }
        using var ink = JsonDocument.Parse(DisplayTests.RunRuby(
            Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"),
            new { image, comparison_image = comparison, regions = new[] { region } }));
        var result = ink.RootElement[0];
        if (overflowing)
        {
            Assert.True(result.GetProperty("dark_pixels").GetInt32() >= 3, "The title end must paint visible ink.");
            Assert.True(result.GetProperty("different_pixels").GetInt32() > 0,
                "The painted end ellipsis must differ from silent hard clipping.");
        }
        else Assert.Equal(0, result.GetProperty("different_pixels").GetInt32());
    }

    private static async Task ReadableRows(ILocator rows)
    {
        var problems = await rows.EvaluateAllAsync<string[]>("""
            async rows => (await import("/workbench/layout-checks.mjs")).rowProblems(rows)
            """);
        Assert.Empty(problems);
    }

    internal static async Task VisibleInsideView(ILocator content, bool textMayBeTruncated = false)
    {
        await Assertions.Expect(content).ToBeVisibleAsync();
        Assert.True(await content.EvaluateAsync<bool>("""
            async (element, truncated) =>
              (await import("/workbench/layout-checks.mjs")).textInsideView(element, truncated)
            """, textMayBeTruncated), $"Required text is clipped or outside its native view: {await content.InnerTextAsync()}");
    }
}
