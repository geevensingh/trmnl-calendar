using System.Globalization;
using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Ical.Net.Serialization;
using Calendar = Ical.Net.Calendar;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace CalendarAgenda;

public sealed class AgendaFunction(
    HttpClient source,
    IConfiguration configuration,
    TimeProvider clock,
    ILogger<AgendaFunction> logger)
{
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
        var configurationError = await ValidateRequest(request);
        if (configurationError is not null)
            return Fail(configurationError.Code, configurationError.Message);

        if (!Uri.TryCreate(configuration["Agenda:SourceUrl"], UriKind.Absolute, out var sourceUri)
            || sourceUri.UserInfo.Length != 0 || sourceUri.Fragment.Length != 0
            || (sourceUri.Scheme != Uri.UriSchemeHttps
                && !(sourceUri.Scheme == Uri.UriSchemeHttp && sourceUri.IsLoopback
                    && configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development")))
            return Fail("source_configuration", "The calendar source is not configured correctly.");

        string ics;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(request.HttpContext.RequestAborted);
        deadline.CancelAfter(TimeSpan.FromSeconds(6));
        try
        {
            using var response = await source.GetAsync(sourceUri, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode)
                return Fail("source_unavailable", "The calendar source could not be checked.");
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            const int sourceLimit = 2 * 1024 * 1024;
            var buffer = new byte[sourceLimit + 1];
            var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, deadline.Token);
            if (length > sourceLimit)
                return Fail("source_invalid", "The calendar source exceeds the supported size.");
            ics = new UTF8Encoding(false, true).GetString(buffer, 0, length);
        }
        catch (OperationCanceledException) when (!request.HttpContext.RequestAborted.IsCancellationRequested)
        {
            return Fail("source_unavailable", "The calendar source could not be checked.");
        }
        catch (Exception error) when (error is HttpRequestException or IOException)
        {
            return Fail("source_unavailable", "The calendar source could not be checked.");
        }
        catch (DecoderFallbackException)
        {
            return Fail("source_invalid", "The calendar source is not valid UTF-8.");
        }

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
            if (new[] { "UID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "STATUS" }
                    .Any(name => item.Properties.Count(property => property.Name == name) > 1)
                || item.DtEnd is not null && item.Duration is not null)
                return Fail("source_invalid", "The source contains conflicting event properties.");
            if (new[] { "RRULE", "RDATE", "EXRULE", "EXDATE", "RECURRENCE-ID" }.Any(item.Properties.ContainsKey)
                || item.DtStart is { HasTime: false } or { IsFloating: true }
                || item.DtEnd is { HasTime: false } or { IsFloating: true })
                return Fail("compatibility_unsupported", "The source contains calendar semantics not supported by this slice.");
            if (item.DtStart is null)
                return Fail("source_invalid", "The source contains an event without a valid start.");
            if (item.DtEnd is null && item.Duration is null)
                return Fail("compatibility_unsupported", "A timed event end or duration is required by this slice.");
        }
        if (calendar.Events.Select(item => item.Uid).Distinct(StringComparer.Ordinal).Count() != calendar.Events.Count)
            return Fail("source_invalid", "The source contains duplicate nonrecurring event identifiers.");
        var now = clock.GetUtcNow();
        var primary = NextWorkingDay(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, AgendaTimeZone).DateTime));
        var secondary = NextWorkingDay(primary.AddDays(1));
        TimedOccurrence[] occurrences;
        try
        {
            var interpreted = calendar.Events.Select(item =>
            {
                var start = new DateTimeOffset(item.DtStart!.AsUtc);
                var end = new DateTimeOffset((item.DtEnd ?? item.DtStart!.Add(item.Duration!.Value)).AsUtc);
                var id = Convert.ToHexStringLower(SHA256.HashData(
                    Encoding.UTF8.GetBytes($"{item.Uid}\n{start:O}")));
                return (Occurrence: new TimedOccurrence(id, item.Summary ?? "(Untitled)", item.Location, start, end),
                    item.IsActive);
            }).ToArray();
            if (interpreted.Any(item => item.Occurrence.EndAt <= item.Occurrence.StartAt))
                return Fail("source_invalid", "The source contains an invalid event interval.");
            occurrences = interpreted.Where(item => item.IsActive).Select(item => item.Occurrence)
                .Where(item => item.EndAt > now).OrderBy(item => item.StartAt)
                .ThenBy(item => item.EndAt).ThenBy(item => item.Id, StringComparer.Ordinal).ToArray();
        }
        catch (ArgumentException)
        {
            return Fail("compatibility_unsupported", "The source contains an unsupported time zone.");
        }
        var result = new AgendaResult(1, AgendaState.Current, TimeZoneId, now, now,
            SelectDay(primary, occurrences), SelectDay(secondary, occurrences), null);
        return Respond(result);
    }

    private static async Task<AgendaError?> ValidateRequest(HttpRequest request)
    {
        const int limit = 16 * 1024;
        var invalid = new AgendaError("configuration_invalid", "Rule configuration is missing or malformed.");
        var buffer = new byte[limit + 1];
        var length = await request.Body.ReadAtLeastAsync(buffer, buffer.Length,
            throwOnEndOfStream: false, request.HttpContext.RequestAborted);
        if (length > limit)
            return invalid;

        try
        {
            using var body = JsonDocument.Parse(buffer.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 16 });
            if (body.RootElement.ValueKind != JsonValueKind.Object)
                return invalid;
            var fields = body.RootElement.EnumerateObject().ToArray();
            if (fields.Length != 1 || fields[0].Name != "rules_json"
                || fields[0].Value.ValueKind != JsonValueKind.String)
                return invalid;
            using var rules = JsonDocument.Parse(fields[0].Value.GetString()!,
                new JsonDocumentOptions { MaxDepth = 16 });
            if (rules.RootElement.ValueKind != JsonValueKind.Array)
                return invalid;
            return rules.RootElement.GetArrayLength() == 0 ? null
                : new AgendaError("configuration_unsupported", "Nonempty exclusion rules are not supported by this slice.");
        }
        catch (JsonException)
        {
            return invalid;
        }
    }

    private ContentResult Fail(string code, string message, DateTimeOffset? sourceSucceededAt = null)
    {
        logger.LogWarning("Agenda failed with code {ErrorCode}.", code);
        var now = clock.GetUtcNow();
        var primary = NextWorkingDay(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, AgendaTimeZone).DateTime));
        var secondary = NextWorkingDay(primary.AddDays(1));
        return Respond(new AgendaResult(1, AgendaState.Error, TimeZoneId, now, sourceSucceededAt,
            SelectDay(primary, []) with { EligibleTotal = null },
            SelectDay(secondary, []) with { EligibleTotal = null }, new AgendaError(code, message)));
    }

    private ContentResult Respond(AgendaResult result)
    {
        var json = JsonSerializer.Serialize(result, JsonOptions);
        if (result.State != AgendaState.Error && Encoding.UTF8.GetByteCount(json) > 95_000)
            return Fail("agenda_too_large", "The complete agenda exceeds the polling response budget.",
                result.SourceSucceededAt);
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

    private static AgendaDay SelectDay(DateOnly date, IEnumerable<TimedOccurrence> occurrences)
    {
        var start = TimeZoneInfo.ConvertTimeToUtc(date.ToDateTime(TimeOnly.MinValue), AgendaTimeZone);
        var end = TimeZoneInfo.ConvertTimeToUtc(date.AddDays(1).ToDateTime(TimeOnly.MinValue), AgendaTimeZone);
        var eligible = occurrences.Where(item => item.StartAt < end && item.EndAt > start)
            .Cast<AgendaOccurrence>().ToArray();
        return new AgendaDay(date, date.ToString("dddd, MMM d", CultureInfo.InvariantCulture), eligible.Length, eligible);
    }
}
