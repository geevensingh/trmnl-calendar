using System.Globalization;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Ical.Net;
using Ical.Net.CalendarComponents;
using Ical.Net.DataTypes;
using Ical.Net.Evaluation;
using Ical.Net.Serialization;
using Calendar = Ical.Net.Calendar;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TimeZoneConverter;

namespace CalendarAgenda;

public sealed partial class AgendaFunction
{
    internal static readonly TimeSpan SourceAcquisitionTimeout = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan RefreshTimeout = TimeSpan.FromSeconds(35);
    internal static readonly TimeSpan HttpPollTimeout = TimeSpan.FromSeconds(9);

    private readonly HttpClient source;
    private readonly IConfiguration configuration;
    private readonly TimeProvider clock;
    private readonly ILogger<AgendaFunction> logger;
    private readonly SourceCache cache;
    private readonly TimeProvider ioClock;

    static AgendaFunction()
    {
        TimeZoneResolvers.TimeZoneResolver = tzId => DefaultTimeZoneResolver.GetZone(tzId)
            ?? (TZConvert.TryWindowsToIana(tzId, "001", out var iana)
                ? NodaTime.DateTimeZoneProviders.Tzdb.GetZoneOrNull(iana) : null)
            ?? throw new ArgumentException("Unsupported calendar time zone.", nameof(tzId));
    }

    public AgendaFunction(HttpClient source, IConfiguration configuration, TimeProvider clock,
        ILogger<AgendaFunction> logger)
        : this(source, configuration, clock, logger, SourceCache.Create(configuration))
    {
    }

    internal AgendaFunction(HttpClient source, IConfiguration configuration, TimeProvider clock,
        ILogger<AgendaFunction> logger, SourceCache cache, TimeProvider? ioClock = null)
    {
        this.source = source;
        this.configuration = configuration;
        this.clock = clock;
        this.logger = logger;
        this.cache = cache;
        this.ioClock = ioClock ?? TimeProvider.System;
    }

    private const string TimeZoneId = "America/Los_Angeles";
    private static readonly TimeSpan UpcomingWindow = TimeSpan.FromMinutes(15);
    private static readonly TimeZoneInfo AgendaTimeZone = TimeZoneInfo.FindSystemTimeZoneById(TimeZoneId);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) }
    };

    [Function("RefreshSource")]
    public async Task Refresh([TimerTrigger("0 */5 * * * *", RunOnStartup = false, UseMonitor = true)] TimerInfo timer,
        CancellationToken cancellationToken = default)
    {
        var scheduledAt = timer.ScheduleStatus is { Next: var next } && next != default
            ? new DateTimeOffset(DateTime.SpecifyKind(next, DateTimeKind.Utc)) : clock.GetUtcNow();
        var local = NodaTime.Instant.FromDateTimeOffset(scheduledAt)
            .InZone(NodaTime.DateTimeZoneProviders.Tzdb[TimeZoneId]);
        var businessHours = local.DayOfWeek is >= NodaTime.IsoDayOfWeek.Monday and <= NodaTime.IsoDayOfWeek.Friday
            && local.Hour is >= 9 and < 18;
        if (local.Minute % (businessHours ? 5 : 15) != 0)
            return;
        await RefreshSource(cancellationToken);
    }

    internal async Task RefreshSource(CancellationToken cancellationToken = default)
    {
        if (!TrySource(out var sourceUri))
        {
            logger.LogWarning("Agenda refresh failed with code {ErrorCode}.", "source_configuration");
            return;
        }
        var startedAt = clock.GetUtcNow();
        var refreshId = Guid.NewGuid().ToString("N");
        using var budget = new CancellationTokenSource(RefreshTimeout, ioClock);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, budget.Token);
        try
        {
            var attempt = await cache.Begin(new RefreshAttempt(SourceKey(sourceUri!), refreshId, startedAt), deadline.Token);
            if (attempt.Generation == 0)
            {
                logger.LogInformation("Agenda refresh finished with code {OutcomeCode}.", "refresh_superseded");
                return;
            }
            var (ics, error, _) = await FetchSource(sourceUri!, deadline.Token, cancellationToken);
            var interpreted = ics is not null ? Interpret(ics, [], clock.GetUtcNow(), deadline.Token) : null;
            error ??= interpreted?.Error;
            deadline.Token.ThrowIfCancellationRequested();
            var succeededAt = error is null ? clock.GetUtcNow() : (DateTimeOffset?)null;
            var status = new RefreshStatus(1, SourceKey(sourceUri!), refreshId, startedAt, clock.GetUtcNow(),
                succeededAt, error?.Code, error is null ? null : RefreshErrors.Detail(error), attempt.Generation,
                CompletedGeneration: attempt.Generation);
            await cache.Complete(status, succeededAt is { } success
                ? new SourceSnapshot(2, status.SourceKey, success, ics!, startedAt, refreshId, attempt.Generation) : null,
                deadline.Token);
            if (error is not null)
                logger.LogWarning("Agenda refresh failed with code {ErrorCode}.", error.Code);
            else
                logger.LogInformation("Agenda refresh finished with code {OutcomeCode}.", "source_checked");
        }
        catch (SourceCacheException error)
        {
            logger.LogWarning("Agenda refresh failed with code {ErrorCode}.", error.Code);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning("Agenda refresh failed with code {ErrorCode}.", "cache_unavailable");
        }
    }

    private bool TrySource(out Uri? sourceUri) =>
        Uri.TryCreate(configuration["Agenda:SourceUrl"], UriKind.Absolute, out sourceUri)
        && sourceUri.UserInfo.Length == 0 && sourceUri.Fragment.Length == 0
        && (sourceUri.Scheme == Uri.UriSchemeHttps
            || sourceUri.Scheme == Uri.UriSchemeHttp && sourceUri.IsLoopback
            && configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development");

    private static string SourceKey(Uri sourceUri) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sourceUri.AbsoluteUri)));

    [Function("Agenda")]
    public async Task<IActionResult> Run(
        [HttpTrigger(AuthorizationLevel.Function, "post", Route = "agenda")] HttpRequest request)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var (rules, configurationError) = await ValidateRequest(request);
        if (configurationError is not null)
            return Respond(Fail(configurationError.Code, configurationError.Message));

        if (!TrySource(out var sourceUri))
            return Respond(Fail("source_configuration", "The calendar source is not configured correctly."));

        using var budget = new CancellationTokenSource(HttpPollTimeout, ioClock);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(request.HttpContext.RequestAborted, budget.Token);
        var sourceKey = SourceKey(sourceUri!);
        try
        {
            var status = await cache.ReadStatus(deadline.Token);
            var retained = await cache.Read(deadline.Token);
            var after = await cache.ReadStatus(deadline.Token);
            var error = status != after ? RefreshErrors.For("refresh_incomplete")
                : status is null || status.SourceKey != sourceKey ? RefreshErrors.For("refresh_missing")
                : status.ErrorCode is { } code ? RefreshErrors.For(code, status.FailureDetail) : null;
            var pending = after?.Pending;
            if (pending is not null)
                error = pending.SourceKey != sourceKey ? RefreshErrors.For("refresh_missing")
                    : pending.Committing ? RefreshErrors.For("refresh_incomplete")
                    : clock.GetUtcNow() - pending.StartedAt >= RefreshTimeout
                        ? RefreshErrors.For("refresh_delayed") : error;
            if (retained is null || retained.SourceKey != sourceKey)
                return Respond(Fail((error ?? RefreshErrors.For("refresh_missing")).Code,
                    (error ?? RefreshErrors.For("refresh_missing")).Message));
            var now = clock.GetUtcNow();
            var age = now - retained.SucceededAt;
            if (status is not null && (status.StartedAt > now || status.CompletedAt > now || pending?.StartedAt > now))
                return Respond(Fail("cache_invalid", "The retained calendar source is not usable.", retained.SucceededAt));
            if (error is null && (retained.Version != 2
                || status!.RefreshId != retained.RefreshId
                || status.StartedAt != retained.RefreshStartedAt
                || status.SourceSucceededAt != retained.SucceededAt
                || status.CompletedGeneration != retained.Generation))
                error = RefreshErrors.For("refresh_incomplete");
            if (error is null && age >= TimeSpan.FromMinutes(15))
                error = RefreshErrors.For("refresh_delayed");
            if (age < TimeSpan.Zero || age >= TimeSpan.FromHours(1))
                return Respond(Fail((error ?? RefreshErrors.For("refresh_delayed")).Code,
                    (error ?? RefreshErrors.For("refresh_delayed")).Message, retained.SucceededAt));
            var reevaluated = Interpret(retained.Calendar, rules, now, deadline.Token);
            return Respond(reevaluated with
            {
                State = reevaluated.State == AgendaState.Current
                    ? error is null ? AgendaState.Current : AgendaState.Stale : AgendaState.Error,
                SourceSucceededAt = retained.SucceededAt,
                Error = reevaluated.Error ?? error
            });
        }
        catch (SourceCacheException error)
        {
            var failure = RefreshErrors.For(error.Code);
            return Respond(Fail(failure.Code, failure.Message));
        }
        catch (OperationCanceledException) when (!request.HttpContext.RequestAborted.IsCancellationRequested)
        {
            return Respond(Fail("cache_unavailable", "The retained calendar source could not be accessed."));
        }
    }

    private async Task<SourceAcquisition> FetchSource(Uri sourceUri,
        CancellationToken cancellationToken, CancellationToken requestAborted)
    {
        using var budget = new CancellationTokenSource(SourceAcquisitionTimeout, ioClock);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, budget.Token);
        var started = ioClock.GetTimestamp();
        long? headersReceived = null;
        long? bodyStarted = null;
        int? status = null;
        int? bytes = null;
        bool? calendarMediaType = null;
        bool? htmlMediaType = null;
        try
        {
            using var response = await source.GetAsync(sourceUri, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            headersReceived = ioClock.GetTimestamp();
            status = (int)response.StatusCode;
            var mediaType = response.Content.Headers.ContentType?.MediaType;
            calendarMediaType = string.Equals(mediaType, "text/calendar", StringComparison.OrdinalIgnoreCase);
            htmlMediaType = string.Equals(mediaType, "text/html", StringComparison.OrdinalIgnoreCase);
            if (!response.IsSuccessStatusCode)
                return Finish(null, new AgendaError("source_unavailable", "The calendar source could not be checked."),
                    status is >= 300 and < 400 ? "redirect_refused" : "http_rejected");
            bodyStarted = ioClock.GetTimestamp();
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            const int sourceLimit = 2 * 1024 * 1024;
            var buffer = new byte[sourceLimit + 1];
            var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, deadline.Token);
            bytes = length;
            if (length > sourceLimit)
                return Finish(null, new AgendaError("source_invalid", "The calendar source exceeds the supported size."),
                    "source_too_large");
            return Finish(new UTF8Encoding(false, true).GetString(buffer, 0, length), null, "received");
        }
        catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
        {
            return Finish(null, new AgendaError("source_unavailable", "The calendar source could not be checked."),
                headersReceived is null ? "headers_timeout" : "body_timeout");
        }
        catch (Exception error) when (error is HttpRequestException or IOException)
        {
            return Finish(null, new AgendaError("source_unavailable", "The calendar source could not be checked."),
                "transport_failed");
        }
        catch (DecoderFallbackException)
        {
            return Finish(null, new AgendaError("source_invalid", "The calendar source is not valid UTF-8."),
                "invalid_utf8");
        }

        SourceAcquisition Finish(string? calendar, AgendaError? error, string code)
        {
            var finished = ioClock.GetTimestamp();
            return new SourceAcquisition(calendar, error, new SourceAcquisitionReport(true, code, status,
                calendarMediaType, htmlMediaType, bytes,
                ElapsedMilliseconds(started, headersReceived ?? finished),
                bodyStarted is { } body ? ElapsedMilliseconds(body, finished) : null,
                ElapsedMilliseconds(started, finished)));
        }
    }

    private AgendaResult Interpret(string ics, ExclusionRule[] rules, DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Calendar calendar;
        try
        {
            var components = SimpleDeserializer.Default.Deserialize(new StringReader(ics)).ToArray();
            cancellationToken.ThrowIfCancellationRequested();
            if (components.Length != 1 || components[0] is not Calendar parsed)
                return Fail("source_invalid", "The source must contain exactly one calendar.");
            calendar = parsed;
        }
        catch (Exception error) when (error is SerializationException or FormatException or ArgumentException
            or InvalidOperationException or OverflowException or RegexMatchTimeoutException)
        {
            return Fail("source_invalid", "The calendar source could not be interpreted.");
        }
        if (calendar.Version != "2.0" || string.IsNullOrWhiteSpace(calendar.ProductId))
            return Fail("source_invalid", "The calendar source is not an iCalendar 2.0 calendar.");
        if (!string.IsNullOrEmpty(calendar.Method) && !calendar.Method.Equals("PUBLISH", StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(calendar.Scale) && !calendar.Scale.Equals("GREGORIAN", StringComparison.OrdinalIgnoreCase))
            return Fail("compatibility_unsupported", "The source uses an unsupported calendar method or scale.");
        foreach (var item in calendar.Events)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(item.Uid))
                return Fail("source_invalid", "The source contains an event without an identifier.");
            if (new[] { "UID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "STATUS", "RECURRENCE-ID" }
                    .Any(name => item.Properties.Count(property => property.Name == name) > 1)
                || item.DtEnd is not null && item.Duration is not null)
                return Fail("source_invalid", "The source contains conflicting event properties.");
            if (item.Properties.Any(property => (property.Name is "DTSTART" or "DTEND" or "DURATION")
                && property.Value is null))
                return Fail("source_invalid", "The source contains an invalid event date or duration.");
            if (item.Properties.ContainsKey("RECURRENCE-ID") && item.RecurrenceIdentifier is null
                || item.Properties.Any(property => (property.Name is "RDATE" or "EXDATE")
                    && (property.Value is not IEnumerable<Period> periods || !periods.Any())))
                return Fail("source_invalid", "The source contains an invalid recurrence date.");
            if (item.RecurrenceIdentifier is { Range: RecurrenceRange.ThisAndFuture })
                return Fail("compatibility_unsupported", "Recurring changes with RANGE=THISANDFUTURE are not supported.");
            if (item.Properties.Any(property => property.Name == "RECURRENCE-ID"
                && property.Parameters.Get("RANGE") is not null))
                return Fail("compatibility_unsupported", "The source contains an unsupported recurrence range.");
            if (item.Properties.ContainsKey("EXRULE"))
                return Fail("compatibility_unsupported", "Deprecated recurrence exclusion rules are not supported.");
            if (item.DtStart is { HasTime: true, IsFloating: true }
                || item.DtEnd is { HasTime: true, IsFloating: true })
                return Fail("compatibility_unsupported", "The source contains calendar semantics not supported by this slice.");
            if (item.DtStart is null)
            {
                if (!item.IsActive && item.RecurrenceIdentifier is not null)
                    continue; // Keep the cancellation in the library's original-occurrence replacement map.
                return Fail("source_invalid", "The source contains an event without a valid start.");
            }
            if (item.DtEnd is not null && item.DtStart.HasTime != item.DtEnd.HasTime)
                return Fail("source_invalid", "The source contains conflicting event date types.");
            if (item.DtStart.HasTime && item.DtEnd is null && item.Duration is null)
                return Fail("compatibility_unsupported", "A timed event end or duration is required by this slice.");
        }
        if (calendar.Events.Where(item => item.RecurrenceIdentifier is null)
            .GroupBy(item => item.Uid, StringComparer.Ordinal).Any(group => group.Count() > 1))
            return Fail("source_invalid", "The source contains duplicate event series identifiers.");
        var masters = calendar.Events.Where(item => item.RecurrenceIdentifier is null)
            .ToDictionary(item => item.Uid!, StringComparer.Ordinal);
        var detached = calendar.Events.Where(item => item.RecurrenceIdentifier is not null
            && !masters.ContainsKey(item.Uid!)).ToArray();
        if (detached.Any(item => item.Properties.Any(property => property.Name is "RRULE" or "RDATE" or "EXDATE")
            || item.DtStart is null || item.DtEnd is null && item.Duration is null))
            return Fail("compatibility_unsupported", "A detached recurring change must specify a single complete occurrence.");
        var primary = NextWorkingDay(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, AgendaTimeZone).DateTime));
        var secondary = NextWorkingDay(primary.AddDays(1));
        AgendaOccurrence[] occurrences;
        try
        {
            foreach (var item in calendar.Events)
            {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var date in SourceDates(item).Where(date => date.HasTime))
                {
                    if (date.IsFloating)
                        return Fail("compatibility_unsupported", "The source contains a floating event or recurrence time.");
                    _ = date.AsUtc;
                }
                if (item.RecurrenceIdentifier is { } identifier)
                {
                    var referenceStart = masters.TryGetValue(item.Uid!, out var master)
                        ? master.DtStart! : item.DtStart!;
                    if (identifier.StartTime.HasTime != referenceStart.HasTime)
                    {
                        var completeAllDayChange = item.DtStart is { HasTime: false }
                            && (item.DtEnd is not null || item.Duration is not null);
                        var startlessCancellation = !item.IsActive && item.DtStart is null
                            && item.DtEnd is null && item.Duration is null;
                        if (master is null || referenceStart.HasTime
                            || identifier.StartTime.Value.TimeOfDay != TimeSpan.Zero
                            || !completeAllDayChange && !startlessCancellation
                            || item.Properties.Any(property => property.Name is "RRULE" or "RDATE" or "EXDATE"))
                            return Fail("compatibility_unsupported", "A recurring change uses a different identifier date type.");
                    }
                    // Stable 5.2.3 matches wall times; detached identities use UTC without inventing a series.
                    // DATE masters retain literal midnight identifiers without timezone or date coercion.
                    if (referenceStart.HasTime)
                        identifier.StartTime = identifier.StartTime.ToTimeZone(master is null ? "UTC" : referenceStart.TzId!);
                }
                if (item.DtStart is null)
                    continue;
                var start = item.DtStart!;
                var end = item.DtEnd ?? start.Add(item.EffectiveDuration);
                if (start.HasTime ? end.AsUtc <= start.AsUtc : end.Date <= start.Date)
                    return Fail("source_invalid", "The source contains an invalid event interval.");
            }
            if (calendar.Events.GroupBy(item => (item.Uid, item.RecurrenceIdentifier?.StartTime.Value))
                .Any(group => group.Count() > 1))
                return Fail("source_invalid", "The source contains duplicate event occurrence identifiers.");
            if (detached.Where(item => item.IsActive).GroupBy(item =>
                {
                    var start = item.DtStart!;
                    return (item.Uid, start.HasTime, Start: start.HasTime ? start.AsUtc : start.Value);
                }).Any(group => group.Count() > 1))
                return Fail("compatibility_unsupported",
                    "Detached occurrences with the same identifier and actual start are not supported.");
            var windowStart = new CalDateTime(primary.ToDateTime(TimeOnly.MinValue), TimeZoneId);
            var windowEnd = new CalDateTime(secondary.AddDays(1).ToDateTime(TimeOnly.MinValue), TimeZoneId);
            var interpreted = new[] { false, true }.SelectMany(timed =>
                new OccurrenceCalendar(calendar, timed).GetOccurrences<CalendarEvent>(windowStart,
                    new EvaluationOptions { MaxUnmatchedIncrementsLimit = 1_000 })
                    .TakeWhileBefore(windowEnd))
                .Select(instance =>
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var item = (CalendarEvent)instance.Source;
                    var start = instance.Period.StartTime;
                    var end = instance.Period.EffectiveEndTime
                        ?? throw new InvalidOperationException("An evaluated occurrence has no end.");
                    var key = start.HasTime
                        ? new DateTimeOffset(start.AsUtc).ToString("O", CultureInfo.InvariantCulture)
                        : start.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    var id = Convert.ToHexStringLower(SHA256.HashData(
                        Encoding.UTF8.GetBytes($"{item.Uid}\n{key}")));
                    AgendaOccurrence occurrence = start.HasTime
                        ? new TimedOccurrence(id, item.Summary ?? "(Untitled)", item.Location,
                            new DateTimeOffset(start.AsUtc), new DateTimeOffset(end.AsUtc))
                        : new AllDayOccurrence(id, item.Summary ?? "(Untitled)", item.Location,
                            DateOnly.FromDateTime(start.Value), DateOnly.FromDateTime(end.Value));
                    return (Occurrence: occurrence,
                        IsActive: item.IsActive && (!masters.TryGetValue(item.Uid!, out var master) || master.IsActive),
                        SourceTitle: item.Summary);
                }).ToArray();
            if (interpreted.Any(item => item.Occurrence switch
                {
                    TimedOccurrence timed => timed.EndAt <= timed.StartAt,
                    AllDayOccurrence allDay => allDay.EndDateExclusive <= allDay.StartDate,
                    _ => throw new InvalidOperationException("Unknown occurrence kind.")
                }))
                return Fail("source_invalid", "The source contains an invalid event interval.");
            occurrences = interpreted.Where(item => item.IsActive
                    && (item.Occurrence is not TimedOccurrence timed || timed.EndAt > now)
                    && !rules.Any(rule => rule.Matches(item.SourceTitle)))
                .Select(item => item.Occurrence).ToArray();
        }
        catch (ArgumentException)
        {
            return Fail("compatibility_unsupported", "The source contains an unsupported time zone.");
        }
        catch (EvaluationException)
        {
            return Fail("compatibility_unsupported", "The calendar recurrence could not be safely evaluated.");
        }
        catch (Exception error) when (error is InvalidOperationException or FormatException or OverflowException)
        {
            return Fail("source_invalid", "The calendar source could not be interpreted.");
        }
        occurrences = ApplyEmphasis(occurrences, now);
        var result = new AgendaResult(2, AgendaState.Current, TimeZoneId, now, now,
            SelectDay(primary, occurrences), SelectDay(secondary, occurrences), null);
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }

    private sealed class OccurrenceCalendar(Calendar source, bool timed) : Calendar
    {
        // Keep every override in the library's replacement map without merging DATE and DATE-TIME streams.
        public override ICalendarObjectList<ICalendarObject> Children => source.Children;
        public override IEnumerable<IRecurrable> RecurringItems =>
            source.Events.Where(item => item.DtStart?.HasTime == timed);
    }

    private static async Task<(ExclusionRule[] Rules, AgendaError? Error)> ValidateRequest(HttpRequest request)
    {
        const int limit = 16 * 1024;
        var invalid = new AgendaError("configuration_invalid", "Rule configuration is missing or malformed.");
        var buffer = new byte[limit + 1];
        var length = await request.Body.ReadAtLeastAsync(buffer, buffer.Length,
            throwOnEndOfStream: false, request.HttpContext.RequestAborted);
        if (length > limit)
            return ([], invalid);

        try
        {
            using var body = JsonDocument.Parse(buffer.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 16 });
            if (body.RootElement.ValueKind != JsonValueKind.Object)
                return ([], invalid);
            var fields = body.RootElement.EnumerateObject().ToArray();
            if (fields.Length != 1 || fields[0].Name != "rules_json"
                || fields[0].Value.ValueKind != JsonValueKind.String)
                return ([], invalid);
            using var rules = JsonDocument.Parse(fields[0].Value.GetString()!,
                new JsonDocumentOptions { MaxDepth = 16 });
            if (rules.RootElement.ValueKind != JsonValueKind.Array)
                return ([], invalid);
            var validated = new List<ExclusionRule>();
            foreach (var rule in rules.RootElement.EnumerateArray())
            {
                if (rule.ValueKind != JsonValueKind.Object || rule.EnumerateObject().Count() != 3
                    || !rule.TryGetProperty("field", out var field) || field.ValueKind != JsonValueKind.String
                    || !rule.TryGetProperty("mode", out var mode) || mode.ValueKind != JsonValueKind.String
                    || !rule.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.String
                    || field.GetString() != "title"
                    || string.IsNullOrWhiteSpace(value.GetString()))
                    return ([], invalid);
                MatchingMode? matchingMode = mode.GetString() switch
                {
                    "contains" => MatchingMode.Contains,
                    "starts_with" => MatchingMode.StartsWith,
                    "whole_word" => MatchingMode.WholeWord,
                    _ => null
                };
                if (matchingMode is not { } supportedMode)
                    return ([], invalid);
                validated.Add(new ExclusionRule(ExclusionField.Title, supportedMode, value.GetString()!));
            }
            return (validated.ToArray(), null);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            // Invalid UTF-16 escapes can fail lazily when a JSON string is read.
            return ([], invalid);
        }
    }

    private enum ExclusionField { Title }
    private enum MatchingMode { Contains, StartsWith, WholeWord }

    private sealed record ExclusionRule(ExclusionField Field, MatchingMode Mode, string Value)
    {
        public bool Matches(string? sourceTitle) => sourceTitle is not null && (Field, Mode) switch
        {
            (ExclusionField.Title, MatchingMode.Contains) =>
                sourceTitle.Contains(Value, StringComparison.OrdinalIgnoreCase),
            (ExclusionField.Title, MatchingMode.StartsWith) =>
                sourceTitle.StartsWith(Value, StringComparison.OrdinalIgnoreCase),
            (ExclusionField.Title, MatchingMode.WholeWord) => MatchesWholeWord(sourceTitle),
            _ => throw new InvalidOperationException("Unsupported validated exclusion rule.")
        };

        private bool MatchesWholeWord(string title)
        {
            for (var index = title.IndexOf(Value, StringComparison.OrdinalIgnoreCase); index >= 0;
                index = title.IndexOf(Value, index + 1, StringComparison.OrdinalIgnoreCase))
            {
                if (!IsWordCharacter(title, index - 1) && !IsWordCharacter(title, index + Value.Length))
                    return true;
            }
            return false;
        }

        private static bool IsWordCharacter(string text, int index)
        {
            if (index < 0 || index >= text.Length)
                return false;
            if (index > 0 && char.IsLowSurrogate(text[index]) && char.IsHighSurrogate(text[index - 1]))
                index--;
            return Rune.TryGetRuneAt(text, index, out var rune)
                && (Rune.IsLetterOrDigit(rune) || Rune.GetUnicodeCategory(rune) is
                    UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark
                    or UnicodeCategory.EnclosingMark or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber);
        }
    }

    private AgendaResult Fail(string code, string message, DateTimeOffset? sourceSucceededAt = null)
    {
        var now = clock.GetUtcNow();
        var primary = NextWorkingDay(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, AgendaTimeZone).DateTime));
        var secondary = NextWorkingDay(primary.AddDays(1));
        return new AgendaResult(2, AgendaState.Error, TimeZoneId, now, sourceSucceededAt,
            SelectDay(primary, []) with { EligibleTotal = null },
            SelectDay(secondary, []) with { EligibleTotal = null }, new AgendaError(code, message));
    }

    private ContentResult Respond(AgendaResult result)
    {
        result = BoundResult(result);
        var json = JsonSerializer.Serialize(result, JsonOptions);
        if (result.Error is not null)
            logger.LogWarning("Agenda failed with code {ErrorCode}.", result.Error.Code);
        if (result.State != AgendaState.Error && logger.IsEnabled(LogLevel.Information))
            LogAgenda(result);
        return new ContentResult
        {
            StatusCode = StatusCodes.Status200OK,
            ContentType = "application/json",
            Content = json
        };
    }

    private AgendaResult BoundResult(AgendaResult result)
    {
        const int limit = 95_000;
        var envelope = result with
        {
            Primary = result.Primary with { Occurrences = [] },
            Secondary = result.Secondary with { Occurrences = [] }
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(envelope, JsonOptions).Length;
        if (bytes > limit)
            return Fail("agenda_too_large", "The agenda metadata exceeds the polling response budget.",
                result.SourceSucceededAt);
        var days = new[] { result.Primary, result.Secondary };
        var admitted = new[] { new HashSet<string>(StringComparer.Ordinal), new HashSet<string>(StringComparer.Ordinal) };
        var candidates = days.SelectMany((day, index) =>
                day.Occurrences.Select(occurrence => (Occurrence: occurrence, Day: index)))
            .OrderByDescending(item => item.Occurrence is TimedOccurrence { Emphasis: not null });
        foreach (var (occurrence, day) in candidates)
        {
            var size = JsonSerializer.SerializeToUtf8Bytes(occurrence, JsonOptions).Length
                + (admitted[day].Count > 0 ? 1 : 0);
            if (size > limit - bytes)
                break;
            bytes += size;
            admitted[day].Add(occurrence.Id);
        }
        return result with
        {
            Primary = result.Primary with
            {
                Occurrences = result.Primary.Occurrences.Where(item => admitted[0].Contains(item.Id)).ToArray()
            },
            Secondary = result.Secondary with
            {
                Occurrences = result.Secondary.Occurrences.Where(item => admitted[1].Contains(item.Id)).ToArray()
            }
        };
    }

    private void LogAgenda(AgendaResult result)
    {
        var pollId = Guid.NewGuid().ToString("N");
        // The isolated host forwards formatted messages, not all structured logger properties.
        logger.LogInformation("Agenda poll {DiagnosticJson}", JsonSerializer.Serialize(new
        {
            PollId = pollId,
            result.State,
            GeneratedAt = result.GeneratedAt.ToString("O", CultureInfo.InvariantCulture),
            SourceSucceededAt = result.SourceSucceededAt?.ToString("O", CultureInfo.InvariantCulture),
            PrimaryDate = result.Primary.Date,
            PrimaryEligibleTotal = result.Primary.EligibleTotal,
            SecondaryDate = result.Secondary.Date,
            SecondaryEligibleTotal = result.Secondary.EligibleTotal
        }, JsonOptions));
        foreach (var day in new[] { result.Primary, result.Secondary })
            foreach (var occurrence in day.Occurrences)
            {
                var (kind, start, end) = occurrence switch
                {
                    TimedOccurrence timed => ("timed",
                        timed.StartAt.ToString("O", CultureInfo.InvariantCulture),
                        timed.EndAt.ToString("O", CultureInfo.InvariantCulture)),
                    AllDayOccurrence allDay => ("all_day",
                        allDay.StartDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        allDay.EndDateExclusive.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
                    _ => throw new InvalidOperationException("Unknown occurrence kind.")
                };
                var title = LimitDiagnosticText(occurrence.Title);
                var location = LimitDiagnosticText(occurrence.Location);
                logger.LogInformation("Agenda occurrence {DiagnosticJson}", JsonSerializer.Serialize(new
                {
                    PollId = pollId,
                    OccurrenceId = occurrence.Id,
                    day.Date,
                    TimeKind = kind,
                    Start = start,
                    EndExclusive = end,
                    Title = title,
                    Location = location,
                    TitleTruncated = title != occurrence.Title,
                    LocationTruncated = location != occurrence.Location
                }, JsonOptions));
            }
    }

    private static string? LimitDiagnosticText(string? value)
    {
        const int limit = 1024;
        if (value is null || value.Length <= limit)
            return value;
        return value[..(char.IsHighSurrogate(value[limit - 1]) ? limit - 1 : limit)];
    }

    private static DateOnly NextWorkingDay(DateOnly date)
    {
        while (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            date = date.AddDays(1);
        return date;
    }

    private static AgendaOccurrence[] ApplyEmphasis(AgendaOccurrence[] occurrences, DateTimeOffset now)
    {
        var timed = occurrences.OfType<TimedOccurrence>().ToArray();
        var inProgress = timed.Where(item => item.StartAt <= now && now < item.EndAt)
            .Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        var upcoming = new HashSet<string>(StringComparer.Ordinal);
        if (inProgress.Count == 0)
        {
            var future = timed.Where(item => item.StartAt > now).ToArray();
            if (future.Length > 0)
            {
                var nextStart = future.Min(item => item.StartAt);
                if (nextStart - now <= UpcomingWindow)
                    upcoming.UnionWith(future.Where(item => item.StartAt == nextStart).Select(item => item.Id));
            }
        }

        return occurrences.Select(item => item is TimedOccurrence timedItem
            ? timedItem with
            {
                Emphasis = inProgress.Contains(timedItem.Id) ? AgendaEmphasis.InProgress
                    : upcoming.Contains(timedItem.Id) ? AgendaEmphasis.Upcoming : null
            }
            : item).ToArray();
    }

    private static IEnumerable<CalDateTime> SourceDates(CalendarEvent item) =>
        new[] { item.DtStart, item.DtEnd, item.RecurrenceIdentifier?.StartTime }.OfType<CalDateTime>()
            .Concat(item.RecurrenceDates.GetAllDates())
            .Concat(item.ExceptionDates.GetAllDates())
            .Concat(item.RecurrenceDates.GetAllPeriods()
                .SelectMany(period => new[] { period.StartTime, period.EndTime }).OfType<CalDateTime>());

    private static AgendaDay SelectDay(DateOnly date, IReadOnlyList<AgendaOccurrence> occurrences)
    {
        var start = TimeZoneInfo.ConvertTimeToUtc(date.ToDateTime(TimeOnly.MinValue), AgendaTimeZone);
        var end = TimeZoneInfo.ConvertTimeToUtc(date.AddDays(1).ToDateTime(TimeOnly.MinValue), AgendaTimeZone);
        var eligible = occurrences.OfType<AllDayOccurrence>()
            .Where(item => item.StartDate <= date && item.EndDateExclusive > date)
            .OrderBy(item => item.StartDate).ThenBy(item => item.EndDateExclusive)
            .ThenBy(item => item.Id, StringComparer.Ordinal).Cast<AgendaOccurrence>()
            .Concat(occurrences.OfType<TimedOccurrence>()
                .Where(item => item.StartAt < end && item.EndAt > start)
                .OrderBy(item => item.StartAt).ThenBy(item => item.EndAt)
                .ThenBy(item => item.Id, StringComparer.Ordinal)).ToArray();
        return new AgendaDay(date, date.ToString("dddd, MMM d", CultureInfo.InvariantCulture), eligible.Length, eligible);
    }
}
