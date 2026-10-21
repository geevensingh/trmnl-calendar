using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using Xunit.Abstractions;

namespace CalendarAgenda.Tests;

public sealed class AgendaSourceDeadlineTests(ITestOutputHelper output)
{
    private const string Calendar = """
        BEGIN:VCALENDAR
        VERSION:2.0
        PRODID:-//TRMNL Calendar//Synthetic deadline tests//EN
        BEGIN:VEVENT
        UID:delayed@synthetic.invalid
        DTSTAMP:20260101T120000Z
        DTSTART;VALUE=DATE:20260101
        DTEND;VALUE=DATE:20260102
        RRULE:FREQ=DAILY;UNTIL=20301231
        SUMMARY:Synthetic delayed commitment
        END:VEVENT
        END:VCALENDAR
        """;

    [Theory]
    [InlineData(7, 0)]
    [InlineData(0, 7)]
    [InlineData(4, 3)]
    public async Task Slow_scheduled_source_acquisition_does_not_consume_the_HTTP_poll_budget(
        int headerSeconds, int bodySeconds)
    {
        await using var source = await SyntheticSource.Start();
        source.HeaderDelay = TimeSpan.FromSeconds(headerSeconds);
        source.BodyDelay = TimeSpan.FromSeconds(bodySeconds);
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient());
        var refresh = Stopwatch.StartNew();
        await agenda.Tick();
        var elapsed = Stopwatch.StartNew();
        using var result = await agenda.PollOnly();
        output.WriteLine($"Refresh headers {headerSeconds}s, body {bodySeconds}s: "
            + $"{refresh.Elapsed.TotalMilliseconds:F0} ms; HTTP: {elapsed.Elapsed.TotalMilliseconds:F0} ms.");
        var body = result.RootElement;
        Assert.Equal("current", body.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, body.GetProperty("error").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, body.GetProperty("source_succeeded_at").ValueKind);
        foreach (var day in new[] { "primary", "secondary" })
        {
            Assert.Equal(1, body.GetProperty(day).GetProperty("eligible_total").GetInt32());
            var occurrence = Assert.Single(body.GetProperty(day).GetProperty("occurrences").EnumerateArray());
            Assert.Equal("all_day", occurrence.GetProperty("time_kind").GetString());
            Assert.Equal("Synthetic delayed commitment", occurrence.GetProperty("title").GetString());
        }
        Assert.InRange(refresh.Elapsed.TotalSeconds, 6.8, 34.999);
        Assert.InRange(elapsed.Elapsed.TotalSeconds, 0, 9.999);
        Assert.Equal(1, source.Requests);
    }

    [Fact]
    public async Task The_actual_timer_with_the_production_registered_client_acquires_a_source_taking_more_than_ten_seconds()
    {
        await using var source = await SyntheticSource.Start();
        source.HeaderDelay = TimeSpan.FromSeconds(11);
        var services = new ServiceCollection();
        AgendaHosting.AddSourceClient(services);
        await using var provider = services.BuildServiceProvider();
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: provider.GetRequiredService<IHttpClientFactory>().CreateClient());
        var elapsed = Stopwatch.StartNew();

        var refresh = agenda.Tick();
        await source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var firstPoll = Stopwatch.StartNew();
        using var inFlight = await agenda.PollOnly();
        Assert.Equal("error", inFlight.RootElement.GetProperty("state").GetString());
        Assert.Equal("refresh_missing", inFlight.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.InRange(firstPoll.Elapsed.TotalSeconds, 0, 9.999);
        var firstPollMs = firstPoll.Elapsed.TotalMilliseconds;
        await refresh.WaitAsync(TimeSpan.FromSeconds(35));
        var refreshMs = elapsed.Elapsed.TotalMilliseconds;
        var pollElapsed = Stopwatch.StartNew();
        using var current = await agenda.PollOnly();

        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        Assert.Equal(1, current.RootElement.GetProperty("primary").GetProperty("eligible_total").GetInt32());
        Assert.InRange(refreshMs, 10_900, 34_999);
        Assert.InRange(pollElapsed.Elapsed.TotalSeconds, 0, 9.999);
        Assert.Equal(1, source.Requests);
        output.WriteLine($"Real registered refresh: {refreshMs:F0} ms; first in-flight HTTP: "
            + $"{firstPollMs:F0} ms (error, not rescued); current HTTP: "
            + $"{pollElapsed.Elapsed.TotalMilliseconds:F0} ms.");
    }

    [Theory]
    [InlineData(60, 0)]
    [InlineData(0, 60)]
    [InlineData(20, 20)]
    public async Task The_thirty_second_headers_and_body_deadline_preserves_stale_source_and_exact_expiry(
        int headerSeconds, int bodySeconds)
    {
        var ioClock = new FakeTimeProvider();
        await using var source = await SyntheticSource.Start(ioClock);
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient(), ioClock: ioClock);
        using var current = await agenda.Poll();
        Assert.Equal("current", current.RootElement.GetProperty("state").GetString());
        var succeededAt = current.RootElement.GetProperty("source_succeeded_at").GetDateTimeOffset();
        source.HeaderDelay = TimeSpan.FromSeconds(headerSeconds);
        source.BodyDelay = TimeSpan.FromSeconds(bodySeconds);
        source.ResetSignals();
        agenda.Clock.Advance(TimeSpan.FromHours(1) - TimeSpan.FromTicks(1));
        var pending = agenda.Refresh();
        await source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (headerSeconds == 20)
        {
            ioClock.Advance(TimeSpan.FromSeconds(20));
            await source.HeadersSent.Task.WaitAsync(TimeSpan.FromSeconds(5));
            ioClock.Advance(TimeSpan.FromSeconds(10));
        }
        else
        {
            if (headerSeconds == 0)
                await source.HeadersSent.Task.WaitAsync(TimeSpan.FromSeconds(5));
            ioClock.Advance(TimeSpan.FromSeconds(30));
        }
        await pending.WaitAsync(TimeSpan.FromSeconds(5));

        foreach (var expectedState in new[] { "stale", "error" })
        {
            var elapsed = Stopwatch.StartNew();
            using var result = await agenda.PollOnly().WaitAsync(TimeSpan.FromSeconds(10));
            output.WriteLine($"{expectedState}, headers {headerSeconds}s, body {bodySeconds}s: "
                + $"{elapsed.Elapsed.TotalMilliseconds:F0} ms.");
            var body = result.RootElement;
            Assert.InRange(elapsed.Elapsed.TotalSeconds, 0, 9.999);
            Assert.Equal(expectedState, body.GetProperty("state").GetString());
            Assert.Equal("source_unavailable", body.GetProperty("error").GetProperty("code").GetString());
            Assert.Equal(succeededAt, body.GetProperty("source_succeeded_at").GetDateTimeOffset());
            Assert.Equal(agenda.Clock.GetUtcNow(), body.GetProperty("generated_at").GetDateTimeOffset());
            foreach (var day in new[] { "primary", "secondary" })
            {
                var selected = body.GetProperty(day);
                if (expectedState == "stale")
                {
                    Assert.Equal(1, selected.GetProperty("eligible_total").GetInt32());
                    Assert.Equal("Synthetic delayed commitment", Assert.Single(
                        selected.GetProperty("occurrences").EnumerateArray()).GetProperty("title").GetString());
                }
                else
                {
                    Assert.Equal(JsonValueKind.Null, selected.GetProperty("eligible_total").ValueKind);
                    Assert.Empty(selected.GetProperty("occurrences").EnumerateArray());
                }
            }
            agenda.Clock.Advance(TimeSpan.FromTicks(1));
        }
    }

    [Fact]
    public async Task Cache_persistence_cannot_reset_the_thirty_five_second_overall_refresh_budget()
    {
        var ioClock = new FakeTimeProvider();
        await using var source = await SyntheticSource.Start(ioClock);
        source.HeaderDelay = TimeSpan.FromSeconds(25);
        var cache = new StalledCache();
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", "",
            sourceUrl: source.Url, sourceClient: new HttpClient(), sourceCache: cache, ioClock: ioClock);
        var pending = agenda.Tick();
        await source.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ioClock.Advance(TimeSpan.FromSeconds(25));
        await cache.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ioClock.Advance(TimeSpan.FromSeconds(9));
        Assert.False(pending.IsCompleted);
        ioClock.Advance(TimeSpan.FromSeconds(1));
        await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(cache.Cancelled);
        Assert.Equal(1, source.Requests);
    }

    [Fact]
    public async Task Cache_only_HTTP_keeps_the_nine_second_IO_deadline_without_fetching_source()
    {
        var ioClock = new FakeTimeProvider();
        var cache = new StalledCache();
        using var agenda = new AgendaHttpTests.AgendaHttp("2026-10-19T18:00:00Z", Calendar,
            sourceCache: cache, ioClock: ioClock);
        var pending = agenda.PollOnly();
        await cache.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        ioClock.Advance(TimeSpan.FromSeconds(8));
        Assert.False(pending.IsCompleted);
        ioClock.Advance(TimeSpan.FromSeconds(1));
        using var result = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("error", result.RootElement.GetProperty("state").GetString());
        Assert.Equal("cache_unavailable", result.RootElement.GetProperty("error").GetProperty("code").GetString());
        Assert.Equal(0, agenda.SourceRequests);
    }

    private sealed class StalledCache : SourceCache
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Cancelled { get; private set; }

        internal override Task<RefreshAttempt> Begin(RefreshAttempt attempt, CancellationToken cancellationToken) =>
            Task.FromResult(attempt with { Generation = 1 });

        internal override async Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            await Stall(cancellationToken);
            return null;
        }

        internal override Task Complete(RefreshStatus status, SourceSnapshot? snapshot,
            CancellationToken cancellationToken) => Stall(cancellationToken);

        internal override Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken) =>
            Stall(cancellationToken);

        private async Task Stall(CancellationToken cancellationToken)
        {
            Entered.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            finally
            {
                Cancelled = cancellationToken.IsCancellationRequested;
            }
        }
    }

    private sealed class SyntheticSource(WebApplication app) : IAsyncDisposable
    {
        public TimeSpan HeaderDelay { get; set; }
        public TimeSpan BodyDelay { get; set; }
        public int Requests { get; private set; }
        public TaskCompletionSource Entered { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource HeadersSent { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Url => app.Urls.Single() + "/calendar.ics?key=CONFIDENTIAL_SYNTHETIC_SOURCE";

        public void ResetSignals()
        {
            Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            HeadersSent = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        public static async Task<SyntheticSource> Start(TimeProvider? clock = null)
        {
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Logging.ClearProviders();
            var app = builder.Build();
            var source = new SyntheticSource(app);
            app.MapGet("/calendar.ics", async context =>
            {
                source.Requests++;
                var headers = Task.Delay(source.HeaderDelay, clock ?? TimeProvider.System, context.RequestAborted);
                source.Entered.TrySetResult();
                await headers;
                context.Response.ContentType = "text/calendar";
                await context.Response.StartAsync(context.RequestAborted);
                var body = Task.Delay(source.BodyDelay, clock ?? TimeProvider.System, context.RequestAborted);
                source.HeadersSent.TrySetResult();
                await body;
                await context.Response.WriteAsync(Calendar, context.RequestAborted);
            });
            await app.StartAsync();
            return source;
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

}
