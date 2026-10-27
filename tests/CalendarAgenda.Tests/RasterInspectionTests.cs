using System.Text.Json;
using Xunit;
using Xunit.Sdk;

namespace CalendarAgenda.Tests;

public sealed class RasterInspectionTests(RasterInspectionTests.Images images)
    : IClassFixture<RasterInspectionTests.Images>
{
    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(2, false)]
    [InlineData(3, false)]
    [InlineData(4, false)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    [InlineData(2, true)]
    [InlineData(3, true)]
    [InlineData(4, true)]
    public void Json_process_preserves_exact_RGBA_ink_and_difference_counts_for_every_filter_and_interlace(
        int filter, bool interlace)
    {
        var image = images.PathFor($"rgba-{filter}-{interlace.ToString().ToLowerInvariant()}");
        var regions = Enumerable.Range(0, 12).Select(index =>
            new { text = $"pixel {index}", x = index % 4, y = index / 4, width = 1, height = 1 }).ToArray();
        using var result = Inspect(new
        {
            image,
            comparison_image = images.PathFor(
            $"rgba-{filter}-{interlace.ToString().ToLowerInvariant()}-comparison"),
            regions
        });
        Assert.Equal(12, result.RootElement.GetArrayLength());
        int[] dark = [0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1];
        int[] different = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
        for (var index = 0; index < 12; index++)
        {
            var actual = result.RootElement[index];
            Assert.Equal($"pixel {index}", actual.GetProperty("text").GetString());
            Assert.Equal(dark[index], actual.GetProperty("dark_pixels").GetInt32());
            Assert.Equal(different[index], actual.GetProperty("different_pixels").GetInt32());
        }
    }

    [Theory]
    [InlineData("rgb", 1, 1, 0, 0)]
    [InlineData("gray", 1, 1, 0, 0)]
    [InlineData("gray-alpha", 0, 1, 1, 0)]
    [InlineData("gray-1", 1, 0, 1, 0)]
    [InlineData("gray-2", 1, 1, 0, 0)]
    [InlineData("gray-4", 1, 1, 0, 0)]
    [InlineData("indexed-1", 0, 1, 0, 1)]
    [InlineData("indexed-2", 0, 1, 1, 0)]
    [InlineData("indexed-4", 0, 1, 1, 0)]
    [InlineData("indexed-8", 0, 1, 1, 0)]
    [InlineData("gray-16", 1, 0, 1, 0)]
    [InlineData("rgb-16", 1, 0, 1, 0)]
    [InlineData("gray-alpha-16", 1, 0, 1, 0)]
    [InlineData("rgba-16", 1, 0, 1, 0)]
    [InlineData("gray-transparent", 1, 0, 0, 0)]
    [InlineData("rgb-transparent", 1, 0, 0, 0)]
    public void Json_process_preserves_color_depth_palette_and_transparency_semantics(
        string name, int first, int second, int third, int fourth)
    {
        using var result = Inspect(new
        {
            image = images.PathFor(name),
            regions = Enumerable.Range(0, 4).Select(x => new { text = $"pixel {x}", x, y = 0, width = 1, height = 1 })
        });
        Assert.Equal(4, result.RootElement.GetArrayLength());
        Assert.Equal([first, second, third, fourth],
            result.RootElement.EnumerateArray().Select(region => region.GetProperty("dark_pixels").GetInt32()));
        Assert.All(result.RootElement.EnumerateArray(),
            region => Assert.False(region.TryGetProperty("different_pixels", out _)));
    }

    [Fact]
    public void Json_process_floors_origins_ceils_edges_and_keeps_region_order_overlap_and_empty_regions()
    {
        using var result = Inspect(new
        {
            image = images.PathFor("rgba-4-false"),
            comparison_image = images.PathFor("rgba-4-false-comparison"),
            regions = new[]
            {
                new { text = "fractional", x = 0.9, y = 0.9, width = 1.2, height = 0.2 },
                new { text = "whole", x = 0.0, y = 0.0, width = 4.0, height = 3.0 },
                new { text = "empty at edge", x = 8.0, y = 8.0, width = 0.0, height = 0.0 },
                new { text = "overlap", x = 1.0, y = 0.0, width = 2.0, height = 1.0 }
            }
        });
        var actual = result.RootElement.EnumerateArray().Select(region => (
            region.GetProperty("text").GetString(),
            region.GetProperty("dark_pixels").GetInt32(),
            region.GetProperty("different_pixels").GetInt32()));
        Assert.Equal(
            [("fractional", 2, 4), ("whole", 5, 6), ("empty at edge", 0, 0), ("overlap", 2, 1)],
            actual);
    }

    [Theory]
    [InlineData(-0.1, 0, 1, 1)]
    [InlineData(0, -0.1, 1, 1)]
    [InlineData(7.1, 0, 1, 1)]
    [InlineData(0, 7.1, 1, 1)]
    public void Json_process_rejects_regions_outside_the_physical_image(double x, double y, double width, double height)
    {
        var error = Assert.Throws<TrueException>(() => Inspect(new
        {
            image = images.PathFor("rgba-4-false"),
            regions = new[] { new { text = "outside", x, y, width, height } }
        }));
        Assert.Contains("Required text is outside the physical screenshot.", error.Message);
    }

    [Fact]
    public void Json_process_rejects_comparison_dimension_mismatch()
    {
        var error = Assert.Throws<TrueException>(() => Inspect(new
        {
            image = images.PathFor("rgba-4-false"),
            comparison_image = images.PathFor("rgb-16"),
            regions = Array.Empty<object>()
        }));
        Assert.Contains("Raster comparison must use identical physical dimensions.", error.Message);
    }

    [Theory]
    [InlineData("signature")]
    [InlineData("truncated")]
    [InlineData("crc")]
    [InlineData("filter")]
    [InlineData("short-scanline")]
    [InlineData("missing")]
    public void Json_process_reports_malformed_or_missing_images_without_success_output(string fault)
    {
        Assert.Equal(fault != "missing", File.Exists(images.PathFor(fault)));
        var error = Assert.Throws<TrueException>(() => Inspect(new
        {
            image = images.PathFor(fault),
            regions = Array.Empty<object>()
        }));
        Assert.NotEmpty(error.Message);
    }

    private static JsonDocument Inspect(object request) => JsonDocument.Parse(DisplayTests.RunRuby(
        Path.Combine(DisplayTests.Root, "tests", "display-ink.rb"), request));

    public sealed class Images : IDisposable
    {
        private readonly string directory = Path.Combine(Path.GetTempPath(), $"agenda-raster-{Guid.NewGuid():N}");

        public Images()
        {
            Directory.CreateDirectory(directory);
            try
            {
                DisplayTests.RunRuby(Path.Combine(DisplayTests.Root, "tests", "display-ink-fixtures.rb"),
                    new { directory });
                File.WriteAllText(PathFor("signature"), "not a PNG");
                var png = File.ReadAllBytes(PathFor("rgba-4-false"));
                File.WriteAllBytes(PathFor("truncated"), png[..^8]);
                png[29] ^= 1;
                File.WriteAllBytes(PathFor("crc"), png);
            }
            catch
            {
                Directory.Delete(directory, recursive: true);
                throw;
            }
        }

        public string PathFor(string name) => Path.Combine(directory, $"{name}.png");
        public void Dispose() => Directory.Delete(directory, recursive: true);
    }
}
