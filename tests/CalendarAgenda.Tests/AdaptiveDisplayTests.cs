using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class AdaptiveDisplayTests
{
    public static TheoryData<string, string, int, int, float, int, int> Views => new()
    {
        { "og", "full", 800, 480, 1, 780, 460 },
        { "og", "half_horizontal", 800, 480, 1, 780, 225 },
        { "og", "half_vertical", 800, 480, 1, 385, 460 },
        { "v2", "full", 1872, 1404, 1.8f, 1020, 760 },
        { "v2", "half_horizontal", 1872, 1404, 1.8f, 1020, 375 },
        { "v2", "half_vertical", 1872, 1404, 1.8f, 505, 760 }
    };

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Essential_agenda_information_fits_each_native_physical_device_and_placement(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = width, Height = height },
            DeviceScaleFactor = 1
        });
        await DisplayTests.Show(page, DisplayTests.CurrentAgenda(), placement, device);

        await NativeBounds(page, width, height, density, viewWidth, viewHeight);
        var screenshot = await page.ScreenshotAsync();
        Assert.Equal(device == "og" ? 800 : 1872, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(16, 4)));
        Assert.Equal(device == "og" ? 480 : 1404, BinaryPrimitives.ReadInt32BigEndian(screenshot.AsSpan(20, 4)));

        foreach (var text in new[]
        {
            "Friday, Oct 23", "1 eligible event", "Synthetic planning", "11:00 AM - 12:00 PM",
            "Monday, Oct 26", "3 eligible events", "Oct 23, 2026, 11:00 AM PDT"
        })
            await VisibleInsideView(page.GetByText(text, new() { Exact = true }));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Busy_primary_days_reserve_truthful_overflow_before_secondary_details(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        data["secondary"]!["eligible_total"] = 19;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        Directory.CreateDirectory(Path.Combine(DisplayTests.Root, "artifacts"));
        var screenshot = Path.Combine(DisplayTests.Root, "artifacts",
            $"busy-{(device == "v2" ? "x" : device)}-{placement}.png");
        await page.ScreenshotAsync(new() { Path = screenshot });
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);

        var visible = page.Locator(".agenda-primary [data-agenda-start]:visible");
        var count = await visible.CountAsync();
        Assert.InRange(count, 1, 31);
        await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
        await VisibleInsideView(page.GetByText($"+{47 - count} more", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("47 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("19 eligible events", new() { Exact = true }));
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
        var regions = await page.Locator("""
            .agenda-day .agenda-heading .title, .agenda-day .agenda-heading .label,
            .agenda-primary .agenda-overflow, [data-agenda-source],
            .agenda-primary tbody tr:not([hidden]) .label--large,
            .agenda-primary tbody tr:not([hidden]) td .title
            """).EvaluateAllAsync<JsonElement>("""
                elements => elements.map(element => {
                  const box = element.getBoundingClientRect();
                  return { text: element.textContent.trim(), x: box.x, y: box.y, width: box.width, height: box.height };
                })
                """);
        Assert.Equal(6 + 2 * count, regions.GetArrayLength());
        using var raster = JsonDocument.Parse(DisplayTests.RunRuby(
            Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"), new { image = screenshot, regions }));
        foreach (var region in raster.RootElement.EnumerateArray())
            Assert.True(region.GetProperty("dark_pixels").GetInt32() >= 20,
                $"Required text has no readable ink in the actual screenshot: {region.GetProperty("text").GetString()}");
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Remaining_room_shows_secondary_details_and_their_truthful_overflow(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        var data = Agenda(primaryRows: 1, secondaryRows: 32);
        data["secondary"]!["eligible_total"] = 50;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);

        await VisibleInsideView(page.GetByText("Primary commitment 1", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("1 eligible event", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("50 eligible events", new() { Exact = true }));
        var secondary = page.Locator(".agenda-secondary [data-agenda-start]:visible");
        var count = await secondary.CountAsync();
        Assert.InRange(count, device == "og" && placement == "half_horizontal" ? 0 : 1, 31);
        await VisibleInsideView(page.GetByText($"+{50 - count} more", new() { Exact = true }));
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
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
                occurrence!["location"] = null;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        var primaryCount = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        var secondaryCount = await page.Locator(".agenda-secondary tbody tr:visible").CountAsync();
        foreach (var day in new[] { "primary", "secondary" })
            foreach (var occurrence in data[day]!["occurrences"]!.AsArray())
                occurrence!["location"] = $"Optional studio {new string('W', 400)}";
        await DisplayTests.Show(page, data, placement, device);

        Assert.Equal(primaryCount, await page.Locator(".agenda-primary tbody tr:visible").CountAsync());
        Assert.Equal(secondaryCount, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
        Assert.True(await page.Locator(".agenda-location:visible").CountAsync() < primaryCount);
        await VisibleInsideView(page.GetByText($"+{32 - primaryCount} more", new() { Exact = true }));
        await VisibleInsideView(page.Locator("[data-agenda-source]"));

        await DisplayTests.Show(page, Agenda(primaryRows: 1, secondaryRows: 0), placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);
        await VisibleInsideView(page.Locator(".agenda-primary").GetByText("Studio A", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Primary commitment 1", new() { Exact = true }));
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Long_untrusted_calendar_strings_cannot_displace_essential_information_or_execute_markup(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
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
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);

        var count = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        Assert.InRange(count, 1, 31);
        await VisibleInsideView(page.GetByText($"+{47 - count} more", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("47 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("12 eligible events", new() { Exact = true }));
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
        await DisplayTests.Show(page, sparse, placement, device);
        var visibleLocation = page.Locator(".agenda-primary .agenda-location:visible");
        Assert.Equal(location, await visibleLocation.InnerTextAsync());
        await VisibleInsideView(visibleLocation, textMayBeTruncated: true);
        Assert.Null(await page.EvaluateAsync<int?>("window.locationPwn"));
        Assert.Equal(0, await page.Locator(".agenda svg").CountAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task All_day_contract_entries_keep_their_label_and_weekend_Monday_priority(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
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
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);

        var rows = page.Locator(".agenda-primary tbody tr:visible");
        var count = await rows.CountAsync();
        Assert.InRange(count, 1, 31);
        await VisibleInsideView(rows.First.GetByText("All day", new() { Exact = true }));
        await VisibleInsideView(rows.First.GetByText("All-day preparation", new() { Exact = true }));
        Assert.Equal(0, await rows.First.Locator("[data-agenda-start], [data-agenda-end]").CountAsync());
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Tuesday, Oct 27", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("47 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("12 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.GetByText($"+{47 - count} more", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Oct 24, 2026, 11:00 AM PDT", new() { Exact = true }));
        Assert.Equal(0, await page.Locator(".agenda-secondary tbody tr:visible").CountAsync());
        Assert.DoesNotContain("tomorrow", await page.Locator("body").InnerTextAsync(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("12:00 AM", await rows.First.InnerTextAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Stale_contract_keeps_commitments_warning_and_original_source_success_visible(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
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
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        await DisplayTests.Show(page, data, placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);

        await VisibleInsideView(page.GetByText("Stale agenda", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("The calendar source could not be checked.", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("47 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("12 eligible events", new() { Exact = true }));
        var count = await page.Locator(".agenda-primary tbody tr:visible").CountAsync();
        Assert.True(count is >= 1 and <= 31, await page.Locator(".agenda").EvaluateAsync<string>("""
            element => JSON.stringify({
              height: element.clientHeight, used: element.scrollHeight,
              children: [...element.children].map(child => ({
                className: child.className, height: child.getBoundingClientRect().height
              }))
            })
            """));
        await VisibleInsideView(page.GetByText($"+{47 - count} more", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("Oct 23, 2026, 11:00 AM PDT", new() { Exact = true }));
        await Assertions.Expect(page.Locator("[data-agenda-source]"))
            .ToHaveAttributeAsync("datetime", "2026-10-23T18:00:00Z");
        Assert.DoesNotContain("11:45", await page.Locator("body").InnerTextAsync());
        Assert.DoesNotContain("Agenda unavailable", await page.Locator("body").InnerTextAsync());
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Configuration_source_compatibility_and_unknown_errors_are_readable_not_empty_agendas(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        foreach (var (code, kind, message, knownSuccess) in new[]
        {
            ("configuration_invalid", "Configuration error", "Rule configuration is missing or malformed.", false),
            ("source_unavailable", "Source error", "The calendar source could not be checked.", false),
            ("compatibility_unsupported", "Compatibility error", "The source contains unsupported calendar semantics.", false),
            ("agenda_too_large", "Agenda error", "The complete agenda exceeds the response budget.", true),
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
            await DisplayTests.Show(page, data, placement, device);
            await NativeBounds(page, width, height, density, viewWidth, viewHeight);

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
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
        foreach (var secondaryRows in new[] { 0, 32 })
        {
            await DisplayTests.Show(page, Agenda(primaryRows: 0, secondaryRows), placement, device);
            await NativeBounds(page, width, height, density, viewWidth, viewHeight);
            await VisibleInsideView(page.GetByText("Friday, Oct 23", new() { Exact = true }));
            await VisibleInsideView(page.GetByText("Monday, Oct 26", new() { Exact = true }));
            await VisibleInsideView(page.Locator(".agenda-primary").GetByText("0 eligible events", new() { Exact = true }));
            await VisibleInsideView(page.Locator(".agenda-primary .agenda-empty"));
            Assert.Equal(0, await page.Locator(".agenda-primary tbody tr:visible").CountAsync());
            if (secondaryRows == 0)
            {
                await VisibleInsideView(page.Locator(".agenda-secondary").GetByText("0 eligible events", new() { Exact = true }));
                await VisibleInsideView(page.Locator(".agenda-secondary .agenda-empty"));
            }
            else
            {
                await VisibleInsideView(page.GetByText("32 eligible events", new() { Exact = true }));
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
        await VisibleInsideView(page.GetByText($"+{32 - compact} more", new() { Exact = true }));
        await VisibleInsideView(page.GetByText("12 eligible events", new() { Exact = true }));
        await VisibleInsideView(page.Locator("[data-agenda-source]"));
        await page.Locator(".agenda-view").EvaluateAsync("element => { element.style.removeProperty('height'); }");
        await Assertions.Expect(rows).ToHaveCountAsync(original);
        await VisibleInsideView(page.GetByText($"+{32 - original} more", new() { Exact = true }));
    }

    [Theory]
    [MemberData(nameof(Views))]
    public async Task Native_capture_readiness_is_not_published_before_production_fitting_completes(
        string device, string placement, int width, int height, float density, int viewWidth, int viewHeight)
    {
        var data = Agenda(primaryRows: 32, secondaryRows: 12);
        data["primary"]!["eligible_total"] = 47;
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync();
        var page = await browser.NewPageAsync(new() { ViewportSize = new() { Width = width, Height = height } });
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
                  const overflow = primary.querySelector(".agenda-overflow");
                  window.agendaNativeReadySnapshots.push({
                    fitted: agenda.dataset.agendaReady === "true",
                    rows: [...primary.querySelectorAll("tbody tr")].filter(row => !row.hidden).length,
                    overflow: overflow.textContent,
                    overflowInside: inside(overflow),
                    sourceInside: inside(document.querySelector("[data-agenda-source]"))
                  });
                }
              });
            })();
            """);
        await DisplayTests.Show(page, data, placement, device);
        await NativeBounds(page, width, height, density, viewWidth, viewHeight);
        var snapshots = await page.EvaluateAsync<JsonElement>("window.agendaNativeReadySnapshots");
        Assert.NotEmpty(snapshots.EnumerateArray());
        foreach (var snapshot in snapshots.EnumerateArray())
        {
            Assert.True(snapshot.GetProperty("fitted").GetBoolean(), snapshot.GetRawText());
            var count = snapshot.GetProperty("rows").GetInt32();
            Assert.InRange(count, 1, 31);
            Assert.Equal($"+{47 - count} more", snapshot.GetProperty("overflow").GetString());
            Assert.True(snapshot.GetProperty("overflowInside").GetBoolean());
            Assert.True(snapshot.GetProperty("sourceInside").GetBoolean());
        }
    }

    private static JsonObject Agenda(int primaryRows, int secondaryRows)
    {
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

    private static async Task NativeBounds(IPage page, int width, int height, float density, int viewWidth, int viewHeight)
    {
        var screen = await page.Locator(".screen").BoundingBoxAsync();
        var view = await page.Locator(".view:has(.agenda)").BoundingBoxAsync();
        Assert.NotNull(screen);
        Assert.NotNull(view);
        Assert.Equal(width, screen.Width);
        Assert.Equal(height, screen.Height);
        Assert.Equal(viewWidth * density, view.Width, precision: 1);
        Assert.Equal(viewHeight * density, view.Height, precision: 1);
    }

    private static async Task ReadableRows(ILocator rows)
    {
        float previousBottom = 0;
        for (var index = 0; index < await rows.CountAsync(); index++)
        {
            var row = rows.Nth(index);
            var bounds = await row.BoundingBoxAsync();
            var time = await row.Locator(".agenda-time .label").BoundingBoxAsync();
            var title = await row.Locator("td .title").BoundingBoxAsync();
            Assert.NotNull(bounds);
            Assert.NotNull(time);
            Assert.NotNull(title);
            Assert.True(bounds.Y >= previousBottom - 1, "Visible occurrence rows must not overlap.");
            Assert.True(time.Y >= bounds.Y - 1 && time.Y + time.Height <= bounds.Y + bounds.Height + 1,
                "The time range must fit inside its occurrence row.");
            Assert.True(title.Y >= bounds.Y - 1 && title.Y + title.Height <= bounds.Y + bounds.Height + 1,
                "The title must fit inside its occurrence row.");
            Assert.True(time.X + time.Width <= title.X + 1 || title.X + title.Width <= time.X + 1
                || time.Y + time.Height <= title.Y + 1 || title.Y + title.Height <= time.Y + 1,
                "Essential time and title text must not overlap.");
            previousBottom = bounds.Y + bounds.Height;
        }
    }

    internal static async Task VisibleInsideView(ILocator content, bool textMayBeTruncated = false)
    {
        await Assertions.Expect(content).ToBeVisibleAsync();
        Assert.True(await content.EvaluateAsync<bool>("""
            (element, truncated) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              if (truncated && element.firstChild?.nodeType === Node.TEXT_NODE)
                range.setEnd(element.firstChild, Math.min(12, element.firstChild.length));
              const rectangles = [...range.getClientRects()];
              for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
                const style = getComputedStyle(ancestor);
                if (ancestor.matches(".view") || /(hidden|clip|auto|scroll)/.test(style.overflow)) {
                  const bounds = ancestor.getBoundingClientRect();
                  if (rectangles.some(rect => rect.left < bounds.left - 1 || rect.top < bounds.top - 1
                    || rect.right > bounds.right + 1 || rect.bottom > bounds.bottom + 1)) return false;
                }
                if (ancestor.matches(".view")) break;
              }
              return rectangles.length > 0;
            }
            """, textMayBeTruncated), $"Required text is clipped or outside its native view: {await content.InnerTextAsync()}");
    }
}
