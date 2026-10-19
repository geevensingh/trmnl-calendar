using System.Globalization;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
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

namespace CalendarAgenda;

public sealed class AgendaFunction
{
    private readonly HttpClient source;
    private readonly IConfiguration configuration;
    private readonly TimeProvider clock;
    private readonly ILogger<AgendaFunction> logger;
    private readonly SourceCache cache;

    public AgendaFunction(HttpClient source, IConfiguration configuration, TimeProvider clock,
        ILogger<AgendaFunction> logger)
    {
        this.source = source;
        this.configuration = configuration;
        this.clock = clock;
        this.logger = logger;
        cache = SourceCache.Create(configuration);
    }

    private const string TimeZoneId = "America/Los_Angeles";
    private static readonly TimeZoneInfo AgendaTimeZone = TimeZoneInfo.FindSystemTimeZoneById(TimeZoneId);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) }
    };

    [Function("Agenda")]
    public async Task<IActionResult> Run(
        [HttpTrigger(AuthorizationLevel.Function, "post", Route = "agenda")] HttpRequest request)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        var (rules, configurationError) = await ValidateRequest(request);
        if (configurationError is not null)
            return Respond(Fail(configurationError.Code, configurationError.Message));

        if (!Uri.TryCreate(configuration["Agenda:SourceUrl"], UriKind.Absolute, out var sourceUri)
            || sourceUri.UserInfo.Length != 0 || sourceUri.Fragment.Length != 0
            || (sourceUri.Scheme != Uri.UriSchemeHttps
                && !(sourceUri.Scheme == Uri.UriSchemeHttp && sourceUri.IsLoopback
                    && configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development")))
            return Respond(Fail("source_configuration", "The calendar source is not configured correctly."));

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(request.HttpContext.RequestAborted);
        deadline.CancelAfter(TimeSpan.FromSeconds(9));
        var (ics, sourceError) = await FetchSource(sourceUri, deadline.Token, request.HttpContext.RequestAborted);
        var attempted = ics is not null
            ? Interpret(ics, rules, clock.GetUtcNow())
            : Fail(sourceError!.Code, sourceError.Message);
        var sourceKey = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sourceUri.AbsoluteUri)));
        try
        {
            if (attempted.State == AgendaState.Current)
            {
                attempted = attempted with { SourceSucceededAt = clock.GetUtcNow() };
                await cache.Write(new SourceSnapshot(1, sourceKey, attempted.SourceSucceededAt!.Value, ics!),
                    deadline.Token);
                return Respond(attempted);
            }

            var retained = await cache.Read(deadline.Token);
            if (retained is null || retained.SourceKey != sourceKey)
                return Respond(attempted);
            var now = clock.GetUtcNow();
            var age = now - retained.SucceededAt;
            if (age < TimeSpan.Zero || age >= TimeSpan.FromHours(1))
                return Respond(Fail(attempted.Error!.Code, attempted.Error.Message, retained.SucceededAt));
            var reevaluated = Interpret(retained.Calendar, rules, now);
            return Respond(reevaluated with
            {
                State = reevaluated.State == AgendaState.Current ? AgendaState.Stale : AgendaState.Error,
                SourceSucceededAt = retained.SucceededAt,
                Error = reevaluated.Error ?? attempted.Error
            });
        }
        catch (SourceCacheException error)
        {
            return Respond(Fail(error.Code, error.Message, attempted.SourceSucceededAt));
        }
        catch (OperationCanceledException) when (!request.HttpContext.RequestAborted.IsCancellationRequested)
        {
            return Respond(Fail("cache_unavailable", "The retained calendar source could not be accessed.",
                attempted.SourceSucceededAt));
        }
    }

    private async Task<(string? Calendar, AgendaError? Error)> FetchSource(Uri sourceUri,
        CancellationToken cancellationToken, CancellationToken requestAborted)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            using var response = await source.GetAsync(sourceUri, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode)
                return (null, new AgendaError("source_unavailable", "The calendar source could not be checked."));
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            const int sourceLimit = 2 * 1024 * 1024;
            var buffer = new byte[sourceLimit + 1];
            var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, deadline.Token);
            if (length > sourceLimit)
                return (null, new AgendaError("source_invalid", "The calendar source exceeds the supported size."));
            return (new UTF8Encoding(false, true).GetString(buffer, 0, length), null);
        }
        catch (OperationCanceledException) when (!requestAborted.IsCancellationRequested)
        {
            return (null, new AgendaError("source_unavailable", "The calendar source could not be checked."));
        }
        catch (Exception error) when (error is HttpRequestException or IOException)
        {
            return (null, new AgendaError("source_unavailable", "The calendar source could not be checked."));
        }
        catch (DecoderFallbackException)
        {
            return (null, new AgendaError("source_invalid", "The calendar source is not valid UTF-8."));
        }
    }

    private AgendaResult Interpret(string ics, ExclusionRule[] rules, DateTimeOffset now)
    {
        Calendar calendar;
        try
        {
            var components = SimpleDeserializer.Default.Deserialize(new StringReader(ics)).ToArray();
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
        if (calendar.Events.Any(item => item.RecurrenceIdentifier is not null && !masters.ContainsKey(item.Uid!)))
            return Fail("compatibility_unsupported", "The source contains a recurring change without its series.");
        var primary = NextWorkingDay(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, AgendaTimeZone).DateTime));
        var secondary = NextWorkingDay(primary.AddDays(1));
        AgendaOccurrence[] occurrences;
        try
        {
            foreach (var item in calendar.Events)
            {
                foreach (var date in SourceDates(item).Where(date => date.HasTime))
                {
                    if (date.IsFloating)
                        return Fail("compatibility_unsupported", "The source contains a floating event or recurrence time.");
                    _ = date.AsUtc;
                }
                if (item.RecurrenceIdentifier is { } identifier)
                {
                    var masterStart = masters[item.Uid!].DtStart!;
                    if (identifier.StartTime.HasTime != masterStart.HasTime)
                        return Fail("compatibility_unsupported", "A recurring change uses a different identifier date type.");
                    // Stable 5.2.3 matches wall times, so equivalent identifiers must use the series' zone.
                    if (masterStart.HasTime)
                        identifier.StartTime = identifier.StartTime.ToTimeZone(masterStart.TzId!);
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
            var windowStart = new CalDateTime(primary.ToDateTime(TimeOnly.MinValue), TimeZoneId);
            var windowEnd = new CalDateTime(secondary.AddDays(1).ToDateTime(TimeOnly.MinValue), TimeZoneId);
            var interpreted = calendar.GetOccurrences<CalendarEvent>(windowStart,
                new EvaluationOptions { MaxUnmatchedIncrementsLimit = 1_000 })
                .TakeWhile(item => item.Period.StartTime < windowEnd)
                .Select(instance =>
                {
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
                    return (Occurrence: occurrence, IsActive: item.IsActive && masters[item.Uid!].IsActive,
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
        var result = new AgendaResult(1, AgendaState.Current, TimeZoneId, now, now,
            SelectDay(primary, occurrences), SelectDay(secondary, occurrences), null);
        return result;
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
        return new AgendaResult(1, AgendaState.Error, TimeZoneId, now, sourceSucceededAt,
            SelectDay(primary, []) with { EligibleTotal = null },
            SelectDay(secondary, []) with { EligibleTotal = null }, new AgendaError(code, message));
    }

    private ContentResult Respond(AgendaResult result)
    {
        var json = JsonSerializer.Serialize(result, JsonOptions);
        if (result.State != AgendaState.Error && Encoding.UTF8.GetByteCount(json) > 95_000)
            return Respond(Fail("agenda_too_large", "The complete agenda exceeds the polling response budget.",
                result.SourceSucceededAt));
        if (result.Error is not null)
            logger.LogWarning("Agenda failed with code {ErrorCode}.", result.Error.Code);
        return new ContentResult
        {
            StatusCode = StatusCodes.Status200OK,
            ContentType = "application/json",
            Content = json
        };
    }

    private static DateOnly NextWorkingDay(DateOnly date)
    {
        while (date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            date = date.AddDays(1);
        return date;
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
