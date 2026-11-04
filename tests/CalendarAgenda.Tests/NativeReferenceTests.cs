using System.Buffers.Binary;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Playwright;
using Xunit;
using Xunit.Abstractions;

namespace CalendarAgenda.Tests;

public sealed class NativeReferenceTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Native_OG_Full_references_bind_finished_production_PNGs_to_fixed_synthetic_inputs()
    {
        var directory = await NativeReferenceCapture.Create();
        output.WriteLine($"Native reference bundle: {directory}");
        using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "manifest.json")));
        Assert.Matches("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", manifest.RootElement.GetProperty("presentation_commit").GetString()!);
        Assert.Matches("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", manifest.RootElement.GetProperty("input_commit").GetString()!);
        var captures = manifest.RootElement.GetProperty("captures").EnumerateArray().ToArray();
        Assert.Equal(["normal-mixed", "dense-primary", "long-text", "emphasis-in-progress", "emphasis-upcoming"],
            captures.Select(capture => capture.GetProperty("scenario").GetString()));
        foreach (var capture in captures)
        {
            var scenario = capture.GetProperty("scenario").GetString()!;
            var scenarioBytes = await File.ReadAllBytesAsync(Path.Combine(directory, $"{scenario}.json"));
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(scenarioBytes)),
                capture.GetProperty("scenario_sha256").GetString());
            var agendaBytes = await File.ReadAllBytesAsync(Path.Combine(directory, $"{scenario}-agenda.json"));
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(agendaBytes)),
                capture.GetProperty("agenda_sha256").GetString());
            using var agenda = JsonDocument.Parse(agendaBytes);
            Assert.Equal(agenda.RootElement.GetProperty("generated_at").GetString(),
                capture.GetProperty("generated_at").GetString());
            Assert.Equal(agenda.RootElement.GetProperty("source_succeeded_at").GetString(),
                capture.GetProperty("source_succeeded_at").GetString());
            Assert.True(capture.GetProperty("readiness").GetProperty("framework").GetBoolean());
            Assert.True(capture.GetProperty("readiness").GetProperty("fitting").GetBoolean());
            Assert.Equal("loaded", capture.GetProperty("readiness").GetProperty("fonts").GetString());
            var image = await File.ReadAllBytesAsync(Path.Combine(directory, capture.GetProperty("png").GetString()!));
            Assert.Equal(800, BinaryPrimitives.ReadInt32BigEndian(image.AsSpan(16, 4)));
            Assert.Equal(480, BinaryPrimitives.ReadInt32BigEndian(image.AsSpan(20, 4)));
            foreach (var role in capture.GetProperty("roles").EnumerateArray())
            {
                Assert.NotEmpty(role.GetProperty("effective_fonts").EnumerateArray());
                Assert.True(role.GetProperty("raster").GetProperty("different_pixels").GetInt32() >= 20);
            }
        }
        var longTitles = captures[2].GetProperty("layout").GetProperty("days")[0].GetProperty("rows").EnumerateArray();
        Assert.Contains(longTitles, row => row.GetProperty("title_truncated").GetBoolean());
        Assert.Contains(captures[3].GetProperty("roles").EnumerateArray(),
            role => role.GetProperty("role").GetString() == "emphasized_title");
    }
}

internal static class NativeReferenceCapture
{
    private const string Roles = """
        .agenda-heading .title, .agenda-count, .agenda-source > span, [data-agenda-source],
        tbody tr:not([hidden]) .agenda-time .label, tbody tr:not([hidden]) td .title,
        tbody tr:not([hidden]) .agenda-status
        """;

    internal static async Task<string> Create()
    {
        var presentation = await Commit("TRMNL_REFERENCE_PRESENTATION_COMMIT");
        var input = await Commit("TRMNL_REFERENCE_INPUT_COMMIT", presentation);
        var harness = await Commit(null);
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "native-references", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var files = new List<object>();
        foreach (var path in new[] { "display/render.rb", "display/timing.rb", "display/src/shared.liquid",
            "display/src/full.liquid", "display/src/half_horizontal.liquid", "display/src/half_vertical.liquid",
            "docs/agenda-contract.md" })
        {
            var bytes = await Git("show", $"{presentation}:{path}");
            var destination = Path.Combine(directory, path.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            await File.WriteAllBytesAsync(destination, bytes);
            files.Add(new { path, sha256 = Hash(bytes) });
        }
        var contract = await File.ReadAllTextAsync(Path.Combine(directory, "docs", "agenda-contract.md"));
        Assert.Contains("# Agenda HTTP and display contract, version 3", contract);
        Assert.Contains("**label-free**", contract);
        var renderer = await File.ReadAllTextAsync(Path.Combine(directory, "display", "render.rb"));
        Assert.Contains("/css/3.4.3/plugins.css", renderer);
        Assert.Contains("/js/3.4.3/plugins.js", renderer);
        var assets = new List<object>();
        var harnessFiles = new List<object>();
        foreach (var path in new[] { "tests/CalendarAgenda.Tests/NativeReferenceTests.cs",
            "tests/CalendarAgenda.Tests/DisplayTests.cs", "tests/CalendarAgenda.Tests/AdaptiveDisplayTests.cs",
            "display/workbench/layout-checks.mjs", "Gemfile.lock" })
            harnessFiles.Add(new
            {
                path,
                sha256 = Hash(await File.ReadAllBytesAsync(
                Path.Combine(DisplayTests.Root, path.Replace('/', Path.DirectorySeparatorChar))))
            });
        var framework = Path.Combine(DisplayTests.Root, ".tools", "framework");
        foreach (var path in new[] { Path.Combine("css", "3.4.3", "plugins.css"), Path.Combine("js", "3.4.3", "plugins.js") }
            .Concat(Directory.GetFiles(Path.Combine(framework, "fonts")).Select(path => Path.GetRelativePath(framework, path)))
            .Order(StringComparer.Ordinal))
            assets.Add(new { path, sha256 = Hash(await File.ReadAllBytesAsync(Path.Combine(framework, path))) });

        using var playwright = await ValidationTiming.CreatePlaywright();
        await using var browser = await ValidationTiming.Launch(playwright);
        var page = await browser.NewPageAsync(new()
        {
            ViewportSize = new() { Width = 800, Height = 480 },
            DeviceScaleFactor = 1
        });
        var browserErrors = new List<string>();
        page.PageError += (_, error) => browserErrors.Add(error);
        page.RequestFailed += (_, request) => browserErrors.Add($"Failed asset: {request.Url}");
        var captures = new List<object>();
        foreach (var scenario in new[] { "normal-mixed", "dense-primary", "long-text", "emphasis-in-progress", "emphasis-upcoming" })
        {
            var bytes = await Git("show", $"{input}:display/scenarios/{scenario}.json");
            await File.WriteAllBytesAsync(Path.Combine(directory, $"{scenario}.json"), bytes);
            var agenda = JsonNode.Parse(bytes)!["agenda"]!.AsObject();
            var payload = Encoding.UTF8.GetBytes(agenda.ToJsonString());
            await File.WriteAllBytesAsync(Path.Combine(directory, $"{scenario}-agenda.json"), payload);
            var html = DisplayTests.RunRuby(Path.Combine(directory, "display", "render.rb"), agenda, "full", "og");
            await File.WriteAllTextAsync(Path.Combine(directory, $"{scenario}.html"), html);
            await DisplayTests.Show(page, agenda, renderedHtml: html);
            Assert.Empty(browserErrors);
            var view = new AdaptiveDisplayTests.NativeView("og", "full", 800, 480, 1, 780, 460);
            await AdaptiveDisplayTests.NativeBounds(page, view);
            var regions = await page.Locator(Roles).EvaluateAllAsync<JsonElement>("""
                nodes => nodes.map(node => {
                  const style = getComputedStyle(node);
                  const box = node.getBoundingClientRect();
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  return { role: node.matches(".agenda-heading .title") ? "date"
                      : node.matches(".agenda-count") ? "count"
                      : node.closest(".agenda-source") ? "source"
                      : node.matches(".agenda-status") ? "emphasized_status"
                      : (node.closest(".agenda-emphasized") ? "emphasized_" : "ordinary_")
                        + (node.matches(".title") ? "title" : "time"),
                    text: node.textContent.trim(), family: style.fontFamily, size: style.fontSize,
                    weight: style.fontWeight, line_height: style.lineHeight,
                    text_rectangles: [...range.getClientRects()].map(rect => ({
                      x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
                    x: box.x, y: box.y, width: box.width, height: box.height };
                })
                """);
            var name = Path.Combine("native-references", Path.GetFileName(directory), scenario);
            await AdaptiveDisplayTests.VisibleInk(page, name, view, await page.Locator(Roles).AllAsync());
            using var raster = JsonDocument.Parse(DisplayTests.RunRuby(Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"),
                new
                {
                    image = Path.Combine(directory, $"{scenario}.png"),
                    comparison_image = Path.Combine(directory, $"{scenario}-no-text.png"),
                    regions
                }));
            var roles = new List<JsonObject>();
            var platformFonts = await DisplayTests.PlatformFonts(page, Roles);
            Assert.Equal(regions.GetArrayLength(), platformFonts.Length);
            for (var index = 0; index < platformFonts.Length; index++)
            {
                var fonts = platformFonts[index];
                Assert.NotEmpty(fonts.EnumerateArray());
                Assert.Contains(fonts.EnumerateArray(), font => font.GetProperty("isCustomFont").GetBoolean()
                    && font.GetProperty("glyphCount").GetInt32() > 0);
                var role = JsonNode.Parse(regions[index].GetRawText())!.AsObject();
                role["effective_fonts"] = JsonNode.Parse(fonts.GetRawText());
                role["raster"] = JsonNode.Parse(raster.RootElement[index].GetRawText());
                roles.Add(role);
            }
            var readiness = await page.EvaluateAsync<JsonElement>("""
                ({ framework: window.TRMNL_PLUGINS_READY === true,
                   fitting: document.querySelector(".agenda").dataset.agendaReady === "true",
                   fonts: document.fonts.status, capture_findings: window.agendaCaptureFindings,
                   device_scale_factor: devicePixelRatio, viewport: [innerWidth, innerHeight] })
                """);
            var layout = await page.EvaluateAsync<JsonElement>("""
                (() => {
                  const box = node => {
                    const rect = node.getBoundingClientRect();
                    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                  };
                  return { screen: box(document.querySelector(".screen")), view: box(document.querySelector(".agenda-view")),
                    days: [...document.querySelectorAll(".agenda-day")].map(day => ({
                      day: day.classList.contains("agenda-primary") ? "primary" : "secondary",
                      eligible: Number(day.dataset.agendaTotal),
                      displayed: day.querySelectorAll("tbody tr:not([hidden])").length,
                      count: day.querySelector(".agenda-count, .agenda-empty").textContent.trim(),
                      header_alignment: getComputedStyle(day.querySelector(".agenda-day-label")).alignItems,
                      rows: [...day.querySelectorAll("tbody tr")].map(row => {
                        const title = row.querySelector("td .title");
                        const location = row.querySelector(".agenda-location");
                        return { id: row.dataset.agendaId, displayed: !row.hidden,
                          emphasis: row.dataset.agendaEmphasis ?? null, title: title.textContent,
                          title_truncated: !row.hidden && title.scrollWidth > title.clientWidth,
                          title_overflow: getComputedStyle(title).textOverflow,
                          location: location?.textContent ?? null,
                          location_admitted: !row.hidden && Boolean(location && !location.hidden),
                          location_truncated: !row.hidden && Boolean(location && !location.hidden
                            && location.scrollWidth > location.clientWidth) };
                      })
                    })) };
                })()
                """);
            var fontFaces = await page.EvaluateAsync<JsonElement>("""
                [...document.fonts].map(face => ({ family: face.family, weight: face.weight,
                  style: face.style, status: face.status }))
                """);
            captures.Add(new
            {
                scenario,
                scenario_sha256 = Hash(bytes),
                agenda_sha256 = Hash(payload),
                generated_at = agenda["generated_at"]!.GetValue<string>(),
                source_succeeded_at = agenda["source_succeeded_at"]!.GetValue<string>(),
                html = $"{scenario}.html",
                html_sha256 = Hash(Encoding.UTF8.GetBytes(html)),
                png = $"{scenario}.png",
                png_sha256 = Hash(await File.ReadAllBytesAsync(Path.Combine(directory, $"{scenario}.png"))),
                readiness,
                font_faces = fontFaces,
                layout,
                roles
            });
        }
        await File.WriteAllTextAsync(Path.Combine(directory, "manifest.json"), JsonSerializer.Serialize(new
        {
            presentation_commit = presentation,
            input_commit = input,
            captured_at = DateTimeOffset.UtcNow,
            harness_commit = harness,
            harness_files = harnessFiles,
            harness_working_tree_dirty = (await Git("status", "--porcelain")).Length > 0,
            framework_version = "3.4.3",
            browser_version = browser.Version,
            capture_kind = "native production PNG; not a scaled preview or physical-panel simulation",
            device = "og",
            placement = "full",
            native_width = 800,
            native_height = 480,
            presentation_files = files,
            assets,
            captures
        }, new JsonSerializerOptions { WriteIndented = true }));
        return directory;
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static async Task<string> Commit(string? variable, string fallback = "HEAD")
    {
        var revision = variable is null ? fallback : Environment.GetEnvironmentVariable(variable) ?? fallback;
        var commit = Encoding.UTF8.GetString(await Git("rev-parse", "--verify", "--end-of-options", $"{revision}^{{commit}}")).Trim();
        Assert.Matches("^(?:[0-9a-f]{40}|[0-9a-f]{64})$", commit);
        return commit;
    }

    private static async Task<byte[]> Git(params string[] arguments)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = DisplayTests.Root,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in new[] { "--no-replace-objects", "--no-optional-locks" }.Concat(arguments))
            start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        using var bytes = new MemoryStream();
        var stdout = process.StandardOutput.BaseStream.CopyToAsync(bytes);
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await stdout;
            Assert.True(process.ExitCode == 0, $"Native reference Git read failed: {await stderr}");
            return bytes.ToArray();
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }
}
