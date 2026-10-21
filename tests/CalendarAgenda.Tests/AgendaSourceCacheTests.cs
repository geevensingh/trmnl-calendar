using System.Net;
using System.Text.Json;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed partial class AgendaHttpTests
{
    [Fact]
    public async Task A_source_failure_uses_last_good_source_strictly_before_one_hour_without_renewing_success()
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var current = await agenda.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());

        agenda.Clock.Advance(TimeSpan.FromHours(1) - TimeSpan.FromTicks(1));
        agenda.SetSource("Synthetic rejected contents must not escape.", HttpStatusCode.ServiceUnavailable);
        using var stale = await agenda.Poll();
        var body = stale.RootElement;

        Assert.Equal("stale", body.GetProperty("state").GetString());
        Assert.Equal("source_unavailable", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:59:59.9999999Z"),
            body.GetProperty("generated_at").GetDateTimeOffset());
        Assert.Equal("Design review", Assert.Single(
            body.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.DoesNotContain("Synthetic rejected", body.GetRawText());
    }

    [Theory]
    [InlineData("rejected", "source_unavailable")]
    [InlineData("redirect", "source_unavailable")]
    [InlineData("timeout", "source_unavailable")]
    [InlineData("transport", "source_unavailable")]
    [InlineData("malformed", "source_invalid")]
    [InlineData("invalid_utf8", "source_invalid")]
    [InlineData("invalid_interval", "source_invalid")]
    [InlineData("oversized", "source_invalid")]
    [InlineData("unsupported", "compatibility_unsupported")]
    public async Task Failed_checks_never_replace_last_good_source_or_extend_the_one_hour_limit(
        string failure, string code)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var current = await agenda.Poll();
        var sourceSucceededAt = DateTimeOffset.Parse("2026-10-19T18:00:00Z");
        Assert.Equal(sourceSucceededAt, current.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        var failedSource = failure switch
        {
            "malformed" => "CONFIDENTIAL invalid calendar",
            "invalid_interval" => CalendarWithEvent("DTSTART:20261019T200000Z\nDTEND:20261019T190000Z"),
            "oversized" => new string('X', 2 * 1024 * 1024 + 1),
            "unsupported" => Fixture("this-and-future.ics"),
            _ => "CONFIDENTIAL failed response"
        };
        agenda.SetSource(failedSource, failure switch
        {
            "rejected" => HttpStatusCode.Forbidden,
            "redirect" => HttpStatusCode.Redirect,
            _ => HttpStatusCode.OK
        }, timeout: failure == "timeout", transportFailure: failure == "transport");
        if (failure == "invalid_utf8")
            agenda.SetSourceBytes([0xff, 0xfe, 0x80]);

        foreach (var minutes in new[] { 20, 20 })
        {
            agenda.Clock.Advance(TimeSpan.FromMinutes(minutes));
            using var stale = await agenda.Poll();
            var body = stale.RootElement;
            Assert.Equal("stale", body.GetProperty("state").GetString());
            Assert.Equal(code, body.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(sourceSucceededAt, body.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Contains("Design review", body.GetRawText());
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
        }

        agenda.Clock.Advance(TimeSpan.FromMinutes(20));
        using var expired = await agenda.Poll();
        var error = expired.RootElement;
        Assert.Equal("error", error.GetProperty("state").GetString());
        Assert.Equal(code, error.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(sourceSucceededAt, error.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T19:00:00Z"),
            error.GetProperty("generated_at").GetDateTimeOffset());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, error.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(error.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }
        Assert.DoesNotContain("Design review", error.GetRawText());

        agenda.Clock.Advance(TimeSpan.FromTicks(1));
        using var stillExpired = await agenda.Poll();
        Assert.Equal("error", stillExpired.RootElement.GetProperty("state").GetString());
        Assert.Equal(sourceSucceededAt, stillExpired.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
    }

    [Fact]
    public async Task A_recreated_adapter_rebuilds_current_rules_from_persisted_unfiltered_source()
    {
        using var storage = new CacheDirectory();
        using (var first = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"), cacheDirectory: storage.Path))
        using (var current = await first.Poll(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"Design"}]"""
        })))
        {
            Assert.Equal("Ongoing planning", Assert.Single(
                current.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
                .GetProperty("title").GetString());
            Assert.DoesNotContain("Design review", current.RootElement.GetRawText());
        }

        using var recreated = new AgendaHttp("2026-10-19T18:10:00Z", "CONFIDENTIAL rejected replacement",
            status: HttpStatusCode.ServiceUnavailable, cacheDirectory: storage.Path);
        using var edited = await recreated.Poll(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"planning"}]"""
        }));
        var body = edited.RootElement;
        Assert.Equal("stale", body.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(
            body.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.Equal(1, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, body.GetProperty("secondary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.DoesNotContain("Ongoing planning", body.GetRawText());
        Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
        Assert.DoesNotContain("description", body.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("attendee", body.GetRawText(), StringComparison.OrdinalIgnoreCase);

        recreated.Clock.Advance(TimeSpan.FromMinutes(20));
        using var cleared = await recreated.Poll();
        Assert.Equal("stale", cleared.RootElement.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(
            cleared.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            cleared.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
    }

    [Theory]
    [InlineData("2026-10-23T06:45:00Z", "2026-10-22", "2026-10-23", "2026-10-26",
        "2026-10-23T16:00:00Z", "2026-10-26T16:00:00Z")]
    [InlineData("2026-10-24T06:45:00Z", "2026-10-23", "2026-10-26", "2026-10-27",
        "2026-10-26T16:00:00Z", "2026-10-27T16:00:00Z")]
    public async Task Cached_recurrence_recalculates_the_working_dates_after_Los_Angeles_midnight(
        string sourceSucceededAt, string initialPrimary, string primary, string secondary,
        string primaryStart, string secondaryStart)
    {
        var ics = CalendarWithEvent("DTSTART;TZID=America/Los_Angeles:20261019T090000\n"
            + "DTEND;TZID=America/Los_Angeles:20261019T100000\nRRULE:FREQ=DAILY;COUNT=14\n"
            + "SUMMARY:Recurring cached planning");
        using var agenda = new AgendaHttp(sourceSucceededAt, ics);
        using var current = await agenda.Poll();
        Assert.Equal(initialPrimary, current.RootElement.GetProperty("primary").GetProperty("date").GetString());
        Assert.Equal(0, current.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.Equal(1, current.RootElement.GetProperty("secondary").GetProperty("eligible_total").GetInt32());

        agenda.Clock.Advance(TimeSpan.FromMinutes(45));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var stale = await agenda.Poll();
        var body = stale.RootElement;
        Assert.Equal("stale", body.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse(sourceSucceededAt), body.GetProperty("source_succeeded_at").GetDateTimeOffset());
        foreach (var (day, date, start) in new[]
        {
            ("primary", primary, primaryStart), ("secondary", secondary, secondaryStart)
        })
        {
            var selected = body.GetProperty(day);
            Assert.Equal(date, selected.GetProperty("date").GetString());
            Assert.Equal(1, selected.GetProperty("eligible_total").GetInt32());
            var occurrence = Assert.Single(selected.GetProperty("occurrences").EnumerateArray());
            Assert.Equal("Recurring cached planning", occurrence.GetProperty("title").GetString());
            Assert.Equal(DateTimeOffset.Parse(start), occurrence.GetProperty("start_at").GetDateTimeOffset());
        }
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"rules_json":"{"}""")]
    [InlineData("""{"rules_json":"[{\"field\":\"description\",\"mode\":\"contains\",\"value\":\"planning\"}]"}""")]
    [InlineData("""{"rules_json":"[{\"field\":\"title\",\"mode\":\"contains\",\"value\":\"\"}]"}""")]
    public async Task Invalid_current_configuration_never_falls_back_or_changes_the_retained_source_clock(string request)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"));
        using var current = await agenda.Poll(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"Design"}]"""
        }));
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        agenda.Clock.Advance(TimeSpan.FromMinutes(40));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);

        using var invalid = await agenda.Poll(request);
        var body = invalid.RootElement;
        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("configuration_invalid", body.GetProperty("error").GetProperty("code").GetString());
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
            Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
        }

        using var cleared = await agenda.Poll();
        Assert.Equal("stale", cleared.RootElement.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(
            cleared.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            cleared.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        agenda.Clock.Advance(TimeSpan.FromMinutes(20));
        using var expired = await agenda.Poll();
        Assert.Equal("error", expired.RootElement.GetProperty("state").GetString());
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("http://127.0.0.1/", "private-cache")]
    [InlineData("https://storage.example.invalid/?sig=CONFIDENTIAL", "private-cache")]
    [InlineData("https://storage.example.invalid/", "Invalid_Container")]
    public async Task Production_requires_safe_persistent_storage_configuration_and_never_uses_the_local_substitute(
        string? serviceUri, string? container)
    {
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"),
            runtimeSettings: new Dictionary<string, string?>
            {
                ["AZURE_FUNCTIONS_ENVIRONMENT"] = "Production",
                ["Agenda:CacheServiceUri"] = serviceUri,
                ["Agenda:CacheContainer"] = container
            });
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("cache_configuration", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
        Assert.DoesNotContain("storage.example", body.GetRawText());
    }

    [Fact]
    public async Task A_later_supported_source_check_replaces_the_retained_source_and_its_success_clock()
    {
        using var storage = new CacheDirectory();
        using (var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"), cacheDirectory: storage.Path))
        {
            using var initial = await agenda.Poll();
            Assert.Equal("current", initial.RootElement.GetProperty("state").GetString());
            agenda.Clock.Advance(TimeSpan.FromMinutes(20));
            agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
            using var stale = await agenda.Poll();
            Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());

            agenda.Clock.Advance(TimeSpan.FromMinutes(25));
            agenda.SetSource(CalendarWithEvent(
                "DTSTART:20261019T200000Z\nDTEND:20261019T210000Z\nSUMMARY:Fresh replacement"));
            using var recovered = await agenda.Poll();
            Assert.Equal("current", recovered.RootElement.GetProperty("state").GetString());
            Assert.Equal(JsonValueKind.Null, recovered.RootElement.GetProperty("error").ValueKind);
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:45:00Z"),
                recovered.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Equal("Fresh replacement", Assert.Single(
                recovered.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
                .GetProperty("title").GetString());
        }

        using var recreated = new AgendaHttp("2026-10-19T19:15:00Z", "", timeout: true, cacheDirectory: storage.Path);
        using var retained = await recreated.Poll();
        Assert.Equal("stale", retained.RootElement.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:45:00Z"),
            retained.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal("Fresh replacement", Assert.Single(
            retained.RootElement.GetProperty("primary").GetProperty("occurrences").EnumerateArray())
            .GetProperty("title").GetString());
        Assert.DoesNotContain("Design review", retained.RootElement.GetRawText());
    }

    [Fact]
    public async Task A_different_configured_feed_cannot_receive_the_previous_feeds_cached_commitments()
    {
        using var storage = new CacheDirectory();
        using (var original = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"),
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_ORIGINAL_SOURCE", cacheDirectory: storage.Path))
        using (var current = await original.Poll())
            Assert.Equal("current", current.RootElement.GetProperty("state").GetString());

        using var changed = new AgendaHttp("2026-10-19T18:10:00Z", "", timeout: true,
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_NEW_SOURCE", cacheDirectory: storage.Path);
        using var result = await changed.Poll();
        var body = result.RootElement;
        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("source_unavailable", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("Design review", body.GetRawText());
        Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
    }

    [Fact]
    public async Task A_storage_write_failure_is_an_explicit_error_not_silently_lost_persistence()
    {
        using var storage = new CacheDirectory();
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(storage.Path)!);
        await File.WriteAllTextAsync(storage.Path, "CONFIDENTIAL blocked storage");
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"), cacheDirectory: storage.Path);
        using var result = await agenda.Poll();
        var body = result.RootElement;

        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("cache_unavailable", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
        Assert.DoesNotContain(storage.Path, body.GetRawText());
    }

    [Fact]
    public async Task An_unusable_persistent_snapshot_is_an_error_until_a_supported_check_repairs_it()
    {
        using var storage = new CacheDirectory();
        using var agenda = new AgendaHttp("2026-10-19T18:00:00Z", Fixture("basic.ics"), cacheDirectory: storage.Path);
        using var current = await agenda.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        foreach (var file in Directory.EnumerateFiles(storage.Path))
            await File.WriteAllTextAsync(file, "CONFIDENTIAL damaged snapshot");
        agenda.Clock.Advance(TimeSpan.FromMinutes(20));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var unusable = await agenda.Poll();
        var body = unusable.RootElement;
        Assert.Equal("error", body.GetProperty("state").GetString());
        Assert.Equal("cache_invalid", body.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        Assert.Empty(body.GetProperty("primary").GetProperty("occurrences").EnumerateArray());
        Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
        Assert.DoesNotContain("Design review", body.GetRawText());

        agenda.SetSource(Fixture("basic.ics"));
        using var repaired = await agenda.Poll();
        Assert.Equal("current", repaired.RootElement.GetProperty("state").GetString());
        agenda.Clock.Advance(TimeSpan.FromMinutes(10));
        agenda.SetSource("", HttpStatusCode.ServiceUnavailable);
        using var retained = await agenda.Poll();
        Assert.Equal("stale", retained.RootElement.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:20:00Z"),
            retained.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
    }

    private sealed class CacheDirectory : IDisposable
    {
        public string Path { get; } = System.IO.Path.Combine(DisplayTests.Root, "artifacts", "source-cache",
            Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, recursive: true);
            else if (File.Exists(Path))
                File.Delete(Path);
        }
    }
}
