using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace CalendarAgenda.Tests;

public sealed class AgendaRefreshTests
{
    [Theory]
    [InlineData("2026-10-19T15:45:00Z", true)]
    [InlineData("2026-10-19T15:50:00Z", false)]
    [InlineData("2026-10-19T15:55:00Z", false)]
    [InlineData("2026-10-19T16:00:00Z", true)]
    [InlineData("2026-10-19T16:05:00Z", true)]
    [InlineData("2026-10-19T16:10:00Z", true)]
    [InlineData("2026-10-20T00:50:00Z", true)]
    [InlineData("2026-10-20T00:55:00Z", true)]
    [InlineData("2026-10-20T01:00:00Z", true)]
    [InlineData("2026-10-20T01:05:00Z", false)]
    [InlineData("2026-10-20T01:10:00Z", false)]
    [InlineData("2026-10-20T01:15:00Z", true)]
    [InlineData("2026-10-20T01:30:00Z", true)]
    [InlineData("2026-10-20T01:45:00Z", true)]
    [InlineData("2026-10-24T16:05:00Z", false)]
    [InlineData("2026-10-24T16:15:00Z", true)]
    [InlineData("2026-10-25T16:10:00Z", false)]
    [InlineData("2026-10-25T16:30:00Z", true)]
    [InlineData("2026-10-19T06:05:00Z", false)]
    [InlineData("2026-10-19T06:45:00Z", true)]
    [InlineData("2026-10-24T06:55:00Z", false)]
    [InlineData("2026-10-24T07:00:00Z", true)]
    [InlineData("2026-10-24T07:05:00Z", false)]
    [InlineData("2026-05-25T16:05:00Z", true)]
    [InlineData("2026-12-25T17:05:00Z", true)]
    [InlineData("2026-10-30T16:05:00Z", true)]
    [InlineData("2026-11-02T16:55:00Z", false)]
    [InlineData("2026-11-02T17:00:00Z", true)]
    [InlineData("2026-11-02T17:05:00Z", true)]
    [InlineData("2026-11-03T01:55:00Z", true)]
    [InlineData("2026-11-03T02:00:00Z", true)]
    [InlineData("2026-11-03T02:05:00Z", false)]
    [InlineData("2026-03-08T09:05:00Z", false)]
    [InlineData("2026-03-08T10:05:00Z", false)]
    [InlineData("2026-03-08T09:15:00Z", true)]
    [InlineData("2026-03-08T10:15:00Z", true)]
    [InlineData("2026-11-01T08:05:00Z", false)]
    [InlineData("2026-11-01T09:05:00Z", false)]
    [InlineData("2026-11-01T08:15:00Z", true)]
    [InlineData("2026-11-01T09:15:00Z", true)]
    public async Task The_actual_timer_handler_observes_Los_Angeles_working_hours_DST_and_quarter_hours(
        string now, bool refreshes)
    {
        using var agenda = new AgendaHttpTests.AgendaHttp(now, Calendar("Scheduled synthetic commitment"));

        await agenda.Tick();
        using var poll = await agenda.PollOnly();

        Assert.Equal(refreshes ? 1 : 0, agenda.SourceRequests);
        Assert.Equal(refreshes ? "current" : "error", poll.RootElement.GetProperty("state").GetString());
        if (!refreshes)
            Assert.Equal("refresh_missing", poll.RootElement.GetProperty("error").GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("2026-10-20T01:01:02Z", "2026-10-20T00:55:00Z", true)]
    [InlineData("2026-10-19T16:05:00Z", "2026-10-19T15:55:00Z", false)]
    [InlineData("2026-11-02T17:06:00Z", "2026-11-02T17:05:00Z", true)]
    public async Task Late_timer_delivery_uses_the_scheduled_UTC_tick_but_actual_source_success_time(
        string now, string scheduled, bool refreshes)
    {
        using var agenda = new AgendaHttpTests.AgendaHttp(now, Calendar("Scheduled synthetic commitment"));
        await agenda.Tick(scheduled);
        using var poll = await agenda.PollOnly();
        Assert.Equal(refreshes ? 1 : 0, agenda.SourceRequests);
        Assert.Equal(refreshes ? "current" : "error", poll.RootElement.GetProperty("state").GetString());
        if (refreshes)
            Assert.Equal(DateTimeOffset.Parse(now), poll.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
    }

    [Fact]
    public async Task Only_a_recent_latest_completed_success_is_current_and_HTTP_never_renews_its_time()
    {
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar("Cached commitment"));
        await agenda.Tick();
        foreach (var (at, state, code) in new[]
        {
            ("2026-10-19T18:00:00Z", "current", (string?)null),
            ("2026-10-19T18:14:59.9999999Z", "current", null),
            ("2026-10-19T18:15:00Z", "stale", "refresh_delayed"),
            ("2026-10-19T18:59:59.9999999Z", "stale", "refresh_delayed"),
            ("2026-10-19T19:00:00Z", "error", "refresh_delayed"),
            ("2026-10-19T19:00:00.0000001Z", "error", "refresh_delayed")
        })
        {
            agenda.Clock.SetUtcNow(DateTimeOffset.Parse(at));
            using var poll = await agenda.PollOnly();
            var body = poll.RootElement;
            Assert.Equal(state, body.GetProperty("state").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                body.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Equal(DateTimeOffset.Parse(at), body.GetProperty("generated_at").GetDateTimeOffset());
            Assert.Equal(code, body.GetProperty("error").ValueKind == JsonValueKind.Null
                ? null : body.GetProperty("error").GetProperty("code").GetString());
            if (state == "error")
                Assert.Equal(JsonValueKind.Null, body.GetProperty("primary").GetProperty("eligible_total").ValueKind);
        }
        Assert.Equal(1, agenda.SourceRequests);
    }

    [Fact]
    public async Task A_failed_latest_refresh_is_immediately_stale_even_when_source_success_is_under_fifteen_minutes()
    {
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar("Cached commitment"));
        await agenda.Tick();
        agenda.Clock.Advance(TimeSpan.FromMinutes(5));
        agenda.SetSource("CONFIDENTIAL_REJECTED_SOURCE", HttpStatusCode.ServiceUnavailable);

        await agenda.Tick();
        using var poll = await agenda.PollOnly();

        Assert.Equal("stale", poll.RootElement.GetProperty("state").GetString());
        Assert.Equal("source_unavailable", poll.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            poll.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Contains("Cached commitment", poll.RootElement.GetRawText());
        Assert.Equal(2, agenda.SourceRequests);
    }

    [Fact]
    public async Task Current_rule_edits_and_ended_filtering_reuse_raw_source_without_renewing_success()
    {
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics")));
        await agenda.Tick();
        agenda.Clock.Advance(TimeSpan.FromMinutes(5));
        using var edited = await agenda.PollOnly(JsonSerializer.Serialize(new
        {
            rules_json = """[{"field":"title","mode":"contains","value":"planning"}]"""
        }));
        Assert.Equal("current", edited.RootElement.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(edited.RootElement.GetProperty("primary")
            .GetProperty("occurrences").EnumerateArray()).GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            edited.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        using var cleared = await agenda.PollOnly();
        Assert.Equal(2, cleared.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        agenda.Clock.Advance(TimeSpan.FromMinutes(25));
        using var ended = await agenda.PollOnly();
        Assert.Equal("stale", ended.RootElement.GetProperty("state").GetString());
        Assert.Equal("Design review", Assert.Single(ended.RootElement.GetProperty("primary")
            .GetProperty("occurrences").EnumerateArray()).GetProperty("title").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            ended.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(1, agenda.SourceRequests);
    }

    [Fact]
    public async Task A_newer_completed_failure_also_fences_an_older_supported_source_check()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var seed = new AgendaHttpTests.AgendaHttp("2026-10-19T17:55:00Z", Calendar("Original supported commitment"),
            cacheDirectory: directory);
        using var old = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "", cacheDirectory: directory,
            sourceClient: new HttpClient(new HeldSource(entered, released, failure: false)));
        using var newer = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", "CONFIDENTIAL_REJECTED",
            status: HttpStatusCode.ServiceUnavailable, cacheDirectory: directory);
        try
        {
            await seed.Tick();
            var pending = old.Tick();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await newer.Tick();
            released.SetResult();
            await pending;
            using var poll = await newer.PollOnly();
            Assert.Equal("stale", poll.RootElement.GetProperty("state").GetString());
            Assert.Equal("source_unavailable", poll.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T17:55:00Z"),
                poll.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Contains("Original supported commitment", poll.RootElement.GetRawText());
            Assert.DoesNotContain("Older", poll.RootElement.GetRawText());
        }
        finally
        {
            released.TrySetResult();
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task An_older_dated_refresh_cannot_allocate_over_a_newer_completed_check()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        using var newer = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", Calendar("Newer supported commitment"),
            cacheDirectory: directory);
        using var older = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar("Older supported commitment"),
            cacheDirectory: directory);
        try
        {
            await newer.Tick();
            await older.Tick();
            using var result = await newer.PollOnly();
            Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:05:00Z"),
                result.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Contains("Newer supported commitment", result.RootElement.GetRawText());
            Assert.Equal(0, older.SourceRequests);
        }
        finally
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task In_flight_work_keeps_only_the_previous_completed_outcome_and_original_source_age()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var seed = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar("Last completed source"),
            cacheDirectory: directory);
        using var worker = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", "", cacheDirectory: directory,
            sourceClient: new HttpClient(new HeldSource(entered, released, failure: true)));
        try
        {
            await seed.Tick();
            var pending = worker.Tick();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var recent = await worker.PollOnly();
            Assert.Equal("current", recent.RootElement.GetProperty("state").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                recent.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            worker.Clock.Advance(TimeSpan.FromMinutes(10));
            using var delayed = await worker.PollOnly();
            Assert.Equal("stale", delayed.RootElement.GetProperty("state").GetString());
            Assert.Equal("refresh_delayed", delayed.RootElement.GetProperty("error").GetProperty("code").GetString());
            released.SetResult();
            await pending;
            using var failed = await worker.PollOnly();
            Assert.Equal("stale", failed.RootElement.GetProperty("state").GetString());
            Assert.Equal("source_unavailable", failed.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                failed.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        }
        finally
        {
            released.TrySetResult();
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task An_uncompleted_refresh_at_thirty_five_seconds_is_delayed_even_with_younger_good_source()
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var seed = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar("Last completed source"),
            cacheDirectory: directory);
        using var worker = new AgendaHttpTests.AgendaHttp("2026-10-19T18:05:00Z", "", cacheDirectory: directory,
            sourceClient: new HttpClient(new HeldSource(entered, released, failure: true)));
        Task? pending = null;
        try
        {
            await seed.Tick();
            pending = worker.Tick();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            worker.Clock.Advance(TimeSpan.FromSeconds(35) - TimeSpan.FromTicks(1));
            using var beforeDeadline = await worker.PollOnly();
            Assert.Equal("current", beforeDeadline.RootElement.GetProperty("state").GetString());
            worker.Clock.Advance(TimeSpan.FromTicks(1));
            using var delayed = await worker.PollOnly();
            Assert.Equal("stale", delayed.RootElement.GetProperty("state").GetString());
            Assert.Equal("refresh_delayed", delayed.RootElement.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
                delayed.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Contains("Last completed source", delayed.RootElement.GetRawText());
        }
        finally
        {
            released.TrySetResult();
            if (pending is not null)
                await pending.WaitAsync(TimeSpan.FromSeconds(5));
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task A_successful_scheduled_source_check_establishes_current_without_a_poll_fetch()
    {
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "basic.ics")));

        await agenda.Tick();
        using var result = await agenda.PollOnly();

        Assert.Equal("current", result.RootElement.GetProperty("state").GetString());
        Assert.Equal(DateTimeOffset.Parse("2026-10-19T18:00:00Z"),
            result.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
        Assert.Equal(2, result.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
    }

    [Fact]
    public async Task An_HTTP_poll_without_a_completed_refresh_never_contacts_the_source()
    {
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z",
            "CONFIDENTIAL_SOURCE_MUST_NOT_BE_REQUESTED");
        var elapsed = Stopwatch.StartNew();

        using var result = await agenda.PollOnly();

        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("refresh_missing", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(JsonValueKind.Null, result.RootElement.GetProperty("source_succeeded_at").ValueKind);
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 0, 9.999);
        Assert.Equal(0, agenda.SourceRequests);
        Assert.DoesNotContain("CONFIDENTIAL", result.RootElement.GetRawText());
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(false, false, true)]
    public async Task An_older_overlapping_refresh_cannot_replace_a_newer_source_or_completed_outcome(
        bool oldFailure, bool changedFeed, bool sameStart)
    {
        var directory = Path.Combine(DisplayTests.Root, "artifacts", "source-cache", Guid.NewGuid().ToString("N"));
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var old = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "", cacheDirectory: directory,
            sourceClient: new HttpClient(new HeldSource(entered, released, oldFailure)));
        var newerTime = sameStart ? "2026-10-19T18:00:00Z" : "2026-10-19T18:05:00Z";
        using var newer = new AgendaHttpTests.AgendaHttp(newerTime,
            Calendar("Newer supported commitment"), cacheDirectory: directory,
            sourceUrl: changedFeed ? "https://synthetic.invalid/other-feed" : "https://synthetic.invalid/calendar.ics");
        try
        {
            var pending = old.Tick();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await newer.Tick();
            released.SetResult();
            await pending;
            using var poll = await newer.PollOnly();

            Assert.Equal("current", poll.RootElement.GetProperty("state").GetString());
            Assert.Equal(DateTimeOffset.Parse(newerTime),
                poll.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Equal("Newer supported commitment", Assert.Single(poll.RootElement.GetProperty("primary")
                .GetProperty("occurrences").EnumerateArray()).GetProperty("title").GetString());
            Assert.DoesNotContain("Older", poll.RootElement.GetRawText());
        }
        finally
        {
            released.TrySetResult();
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
    }

    private static string Calendar(string title) => "BEGIN:VCALENDAR\nVERSION:2.0\n"
        + "PRODID:-//TRMNL Calendar//Synthetic refresh tests//EN\nBEGIN:VEVENT\nUID:test@synthetic.invalid\n"
        + "DTSTAMP:20261018T120000Z\nDTSTART:20261019T190000Z\nDTEND:20261019T200000Z\n"
        + $"SUMMARY:{title}\nEND:VEVENT\nEND:VCALENDAR\n";

    private sealed class HeldSource(TaskCompletionSource entered, TaskCompletionSource released, bool failure)
        : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            entered.SetResult();
            await released.Task.WaitAsync(cancellationToken);
            return new HttpResponseMessage(failure ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
            {
                Content = new StringContent(Calendar("Older supported commitment"), Encoding.UTF8, "text/calendar")
            };
        }
    }
}
