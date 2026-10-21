using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class AgendaRefreshPersistenceTests
{
    [Theory]
    [InlineData("none", false, "current", null)]
    [InlineData("none", true, "current", null)]
    [InlineData("source_generation_future", true, "stale", "refresh_incomplete")]
    [InlineData("source_generation_pending", true, "stale", "refresh_incomplete")]
    [InlineData("source_generation_older", true, "stale", "refresh_incomplete")]
    [InlineData("source_start", false, "stale", "refresh_incomplete")]
    [InlineData("source_start", true, "stale", "refresh_incomplete")]
    [InlineData("source_identity", true, "stale", "refresh_incomplete")]
    [InlineData("source_success_time", true, "stale", "refresh_incomplete")]
    [InlineData("legacy_with_v2_metadata", false, "error", "cache_invalid")]
    [InlineData("legacy_with_v2_metadata", true, "error", "cache_invalid")]
    [InlineData("legacy_with_default_v2_field", true, "error", "cache_invalid")]
    [InlineData("legacy", false, "stale", "refresh_incomplete")]
    [InlineData("legacy", true, "stale", "refresh_incomplete")]
    [InlineData("status_completed_generation_missing", true, "error", "cache_invalid")]
    [InlineData("status_completed_generation_zero", true, "error", "cache_invalid")]
    [InlineData("status_completed_generation_pending", true, "error", "cache_invalid")]
    [InlineData("status_completed_generation_future", true, "error", "cache_invalid")]
    [InlineData("status_allocated_generation_without_pending", false, "error", "cache_invalid")]
    [InlineData("status_pending_reuses_completed_id", true, "error", "cache_invalid")]
    [InlineData("status_pending_before_completion", true, "error", "cache_invalid")]
    [InlineData("status_pending_allocation_mismatch", true, "error", "cache_invalid")]
    [InlineData("status_pending_allocation_gap", true, "current", null)]
    public async Task Only_a_complete_matching_source_identity_remains_current_during_pending_refresh(
        string corruption, bool inFlight, string expectedState, string? expectedCode)
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        var ioClock = new FakeTimeProvider();
        using var completed = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Basic(), cacheDirectory: directory);
        using var worker = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", "CONFIDENTIAL_PENDING_SOURCE",
            cacheDirectory: directory, sourceDelay: Timeout.InfiniteTimeSpan, ioClock: ioClock);
        Task? pending = null;
        try
        {
            await completed.Tick();
            if (corruption == "source_generation_older")
                await completed.Tick();
            if (inFlight)
            {
                pending = worker.Tick();
                await worker.SourceRequested.WaitAsync(TimeSpan.FromSeconds(5));
            }
            var path = Path.Combine(directory, corruption.StartsWith("status_", StringComparison.Ordinal)
                ? "source-refresh-status.json" : "last-good-source.json");
            var data = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            switch (corruption)
            {
                case "source_generation_future":
                    data["Generation"] = 99;
                    break;
                case "source_generation_pending":
                    data["Generation"] = 2;
                    break;
                case "source_generation_older":
                    data["Generation"] = 1;
                    break;
                case "source_start":
                    data["RefreshStartedAt"] = "2026-10-19T17:59:59Z";
                    break;
                case "source_identity":
                    data["RefreshId"] = Guid.NewGuid().ToString("N");
                    break;
                case "source_success_time":
                    data["SucceededAt"] = "2026-10-19T18:00:00.0000001Z";
                    break;
                case "legacy_with_v2_metadata":
                    data["Version"] = 1;
                    break;
                case "legacy":
                case "legacy_with_default_v2_field":
                    data["Version"] = 1;
                    data.Remove("RefreshStartedAt");
                    data.Remove("RefreshId");
                    data.Remove("Generation");
                    if (corruption == "legacy_with_default_v2_field")
                        data["Generation"] = 0;
                    break;
                case "status_completed_generation_missing":
                    data.Remove("CompletedGeneration");
                    break;
                case "status_completed_generation_zero":
                    data["CompletedGeneration"] = 0;
                    break;
                case "status_completed_generation_pending":
                    data["CompletedGeneration"] = 2;
                    break;
                case "status_completed_generation_future":
                    data["CompletedGeneration"] = 99;
                    break;
                case "status_allocated_generation_without_pending":
                case "status_pending_allocation_mismatch":
                    data["Generation"] = 99;
                    break;
                case "status_pending_reuses_completed_id":
                    data["Pending"]!["RefreshId"] = data["RefreshId"]!.DeepClone();
                    break;
                case "status_pending_before_completion":
                    data["Pending"]!["StartedAt"] = "2026-10-19T17:59:59Z";
                    break;
                case "status_pending_allocation_gap":
                    data["Generation"] = 7;
                    data["Pending"]!["Generation"] = 7;
                    break;
            }
            await File.WriteAllTextAsync(path, data.ToJsonString());

            using var result = await worker.PollOnly();

            var body = result.RootElement;
            Assert.Equal(expectedState, body.GetProperty("state").GetString());
            Assert.Equal(expectedCode, body.GetProperty("error").ValueKind == JsonValueKind.Null
                ? null : body.GetProperty("error").GetProperty("code").GetString());
            if (expectedState == "error")
            {
                Assert.Equal(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
                foreach (var day in new[] { "primary", "secondary" })
                {
                    Assert.Equal(JsonValueKind.Null, body.GetProperty(day).GetProperty("eligible_total").ValueKind);
                    Assert.Empty(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
                }
            }
            else
            {
                Assert.Equal(DateTimeOffset.Parse(corruption == "source_success_time"
                    ? "2026-10-19T18:00:00.0000001Z" : "2026-10-19T18:00:00Z"),
                    body.GetProperty("source_succeeded_at").GetDateTimeOffset());
                Assert.Equal(2, body.GetProperty("primary").GetProperty("eligible_total").GetInt32());
                Assert.Contains("Design review", body.GetRawText());
            }
            Assert.DoesNotContain("CONFIDENTIAL", body.GetRawText());
            Assert.Equal(inFlight ? 1 : 0, worker.SourceRequests);
        }
        finally
        {
            if (pending is not null)
            {
                ioClock.Advance(TimeSpan.FromSeconds(30));
                await pending.WaitAsync(TimeSpan.FromSeconds(5));
            }
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("committing_true_then_false")]
    [InlineData("committing_false_then_true")]
    [InlineData("generation")]
    [InlineData("identity")]
    [InlineData("unknown")]
    [InlineData("nested_unknown")]
    public async Task Corrupt_pending_metadata_cannot_mask_a_committing_refresh_as_current(string corruption)
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Basic(), cacheDirectory: directory);
        try
        {
            await agenda.Tick();
            var path = Path.Combine(directory, "source-refresh-status.json");
            var status = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            status["Generation"] = 2;
            status["Pending"] = new JsonObject
            {
                ["SourceKey"] = status["SourceKey"]!.DeepClone(),
                ["RefreshId"] = Guid.NewGuid().ToString("N"),
                ["StartedAt"] = "2026-10-19T18:00:00Z",
                ["Generation"] = 2,
                ["Committing"] = corruption == "committing_false_then_true"
            };
            var duplicate = corruption switch
            {
                "committing_true_then_false" => "\"Committing\":true,",
                "committing_false_then_true" => "\"Committing\":false,",
                "generation" => "\"Generation\":99,",
                "identity" => "\"RefreshId\":\"CONFIDENTIAL_INVALID_IDENTITY\",",
                "unknown" => "\"private_source_url\":\"CONFIDENTIAL_SOURCE_AND_RULES\",",
                "nested_unknown" => "\"private_metadata\":{\"Committing\":true,\"Committing\":false},",
                _ => throw new ArgumentOutOfRangeException(nameof(corruption))
            };
            await File.WriteAllTextAsync(path, status.ToJsonString().Replace(
                "\"Pending\":{", "\"Pending\":{" + duplicate, StringComparison.Ordinal));

            using var result = await agenda.PollOnly();

            Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
            Assert.Equal("cache_invalid", result.RootElement.GetProperty("error").GetProperty("code").GetString());
            foreach (var day in new[] { "primary", "secondary" })
            {
                Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty(day).GetProperty("eligible_total").ValueKind);
                Assert.Empty(result.RootElement.GetProperty(day).GetProperty("occurrences").EnumerateArray());
            }
            Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
            Assert.Equal(1, agenda.SourceRequests);
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("status_extra")]
    [InlineData("status_duplicate")]
    [InlineData("status_missing_code")]
    [InlineData("status_private_code")]
    [InlineData("status_detail")]
    [InlineData("status_oversize")]
    [InlineData("status_key")]
    [InlineData("status_pending_missing_field")]
    [InlineData("status_failed_success_time")]
    [InlineData("source_extra")]
    [InlineData("source_duplicate")]
    [InlineData("source_oversize")]
    public async Task An_untrusted_persisted_source_or_outcome_is_not_silently_current(string corruption)
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics")),
            cacheDirectory: directory);
        try
        {
            await agenda.Tick();
            var path = Path.Combine(directory, corruption.StartsWith("status", StringComparison.Ordinal)
                ? "source-refresh-status.json" : "last-good-source.json");
            var text = await File.ReadAllTextAsync(path);
            var data = JsonNode.Parse(text)!.AsObject();
            switch (corruption)
            {
                case "status_extra":
                case "source_extra":
                    data["private_source_url"] = "CONFIDENTIAL_SOURCE_URL_AND_RULES";
                    break;
                case "status_duplicate":
                case "source_duplicate":
                    text = text.Insert(1, "\"Version\":1,");
                    break;
                case "status_missing_code":
                    data.Remove("ErrorCode");
                    break;
                case "status_private_code":
                    data["ErrorCode"] = "private_calendar_title_and_source_key";
                    break;
                case "status_detail":
                    data["FailureDetail"] = 99999;
                    break;
                case "status_key":
                    data["SourceKey"] = new string('z', 64);
                    break;
                case "source_oversize":
                    data["Calendar"] = new string('X', 2 * 1024 * 1024 + 1);
                    break;
                case "status_oversize":
                    text += new string(' ', 4096);
                    break;
                case "status_pending_missing_field":
                    data["Generation"] = 2;
                    data["Pending"] = new JsonObject
                    {
                        ["SourceKey"] = data["SourceKey"]!.DeepClone(),
                        ["RefreshId"] = Guid.NewGuid().ToString("N"),
                        ["StartedAt"] = "2026-10-19T18:00:00Z",
                        ["Generation"] = 2
                    };
                    break;
                case "status_failed_success_time":
                    data["ErrorCode"] = "source_unavailable";
                    break;
            }
            await File.WriteAllTextAsync(path, corruption.EndsWith("duplicate", StringComparison.Ordinal) || corruption == "status_oversize"
                ? text : data.ToJsonString());

            using var result = await agenda.PollOnly();

            Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
            Assert.Equal("cache_invalid", result.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("primary").GetProperty("eligible_total").ValueKind);
            Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
            Assert.DoesNotContain("private_calendar", result.RootElement.GetRawText());
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task A_missing_outcome_after_process_recreation_cannot_certify_a_recent_source_as_current()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        try
        {
            using (var first = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Basic(), cacheDirectory: directory))
                await first.Tick();
            File.Delete(Path.Combine(directory, "source-refresh-status.json"));
            using var recreated = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", "CONFIDENTIAL_UNREQUESTED",
                cacheDirectory: directory);
            using var stale = await recreated.PollOnly();
            Assert.Equal("stale", stale.RootElement.GetProperty("state").GetString());
            Assert.Equal("refresh_missing", stale.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                stale.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Contains("Design review", stale.RootElement.GetRawText());
            Assert.Equal(0, recreated.SourceRequests);
            recreated.Clock.Advance(TimeSpan.FromMinutes(55));
            using var expired = await recreated.PollOnly();
            Assert.Equal("error", expired.RootElement.GetProperty("state").GetString());
            Assert.Equal(JsonValueKind.Null, expired.RootElement.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("source")]
    [InlineData("final_status")]
    [InlineData("status_read_race")]
    public async Task A_partial_or_racing_publication_is_visibly_incomplete_not_silently_current(string failure)
    {
        var storage = new FaultableStorage();
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Basic(), sourceCache: storage);
        await agenda.Tick();
        agenda.Clock.Advance(TimeSpan.FromMinutes(5));
        storage.Failure = failure;
        if (failure != "status_read_race")
            await agenda.Tick();

        using var result = await agenda.PollOnly();

        Assert.Equal("stale", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("refresh_incomplete", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("Design review", result.RootElement.GetRawText());
        Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
        Assert.Equal(DateTimeOffset.Parse(failure == "final_status" ? "2026-10-19T18:05:00Z" : "2026-10-19T18:00:00Z"),
            result.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        storage.Failure = "read";
        using var invalidRules = await agenda.PollOnly("""{"rules_json":"CONFIDENTIAL_INVALID_RULES"}""");
        Assert.Equal("configuration_invalid", invalidRules.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, invalidRules.RootElement.GetProperty("source_succeeded_at").ValueKind);
        using var storageError = await agenda.PollOnly();
        Assert.Equal("cache_unavailable", storageError.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.DoesNotContain("CONFIDENTIAL", storageError.RootElement.GetRawText());
    }

    [Fact]
    public async Task Refresh_status_is_one_small_fixed_shape_without_source_or_rule_text()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            Basic().Replace("Design review", "CONFIDENTIAL_CALENDAR_TITLE"),
            sourceUrl: "https://synthetic.invalid/CONFIDENTIAL_SOURCE_CREDENTIAL", cacheDirectory: directory);
        try
        {
            await agenda.Tick();
            var text = await File.ReadAllTextAsync(Path.Combine(directory, "source-refresh-status.json"));
            using var status = JsonDocument.Parse(text);
            Assert.Equal(
                ["Version", "SourceKey", "RefreshId", "StartedAt", "CompletedAt", "SourceSucceededAt", "ErrorCode",
                        "FailureDetail", "Generation", "Pending", "CompletedGeneration"],
                status.RootElement.EnumerateObject().Select(property => property.Name));
            Assert.InRange(System.Text.Encoding.UTF8.GetByteCount(text), 1, 4096);
            Assert.DoesNotContain("CONFIDENTIAL", text);
            Assert.DoesNotContain("Calendar", text);
            Assert.DoesNotContain("http", text);
            Assert.Equal(JsonValueKind.Null, status.RootElement.GetProperty("ErrorCode").ValueKind);
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                status.RootElement.GetProperty("SourceSucceededAt").GetDateTimeOffset());
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    private static string Basic() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics"));

    private sealed class FaultableStorage : SourceCache
    {
        private SourceSnapshot? snapshot;
        private RefreshStatus? status;
        public string? Failure { get; set; }

        internal override Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            if (Failure == "read")
                throw new SourceCacheException("cache_unavailable", "CONFIDENTIAL_STORAGE_EXCEPTION");
            if (Failure == "status_read_race")
                status = status! with { RefreshId = Guid.NewGuid().ToString("N") };
            return Task.FromResult(snapshot);
        }

        internal override Task<RefreshStatus?> ReadStatus(CancellationToken cancellationToken)
        {
            if (Failure == "read")
                throw new SourceCacheException("cache_unavailable", "CONFIDENTIAL_STORAGE_EXCEPTION");
            return Task.FromResult(status);
        }

        internal override Task Write(SourceSnapshot value, CancellationToken cancellationToken)
        {
            if (Failure == "source")
                throw new SourceCacheException("cache_unavailable", "CONFIDENTIAL_STORAGE_EXCEPTION");
            snapshot = value;
            return Task.CompletedTask;
        }

        protected override Task WriteStatus(RefreshStatus value, CancellationToken cancellationToken, string? leaseId = null)
        {
            if (Failure == "final_status" && value.Pending is null)
                throw new SourceCacheException("cache_unavailable", "CONFIDENTIAL_STORAGE_EXCEPTION");
            status = value;
            return Task.CompletedTask;
        }
    }
}
