using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace CalendarAgenda;

public sealed class TemporarySmokeSource(IConfiguration configuration, TimeProvider clock,
    ILogger<TemporarySmokeSource> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };
    private readonly ModeStore store = ModeStore.Create(configuration);

    [Function("SmokeSource")]
    public async Task<IActionResult> Get(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "smoke-source")] HttpRequest request)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        if (request.QueryString.HasValue)
            return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(request.HttpContext.RequestAborted);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            var retained = await store.Read(deadline.Token);
            if (retained is null)
                return Error(StatusCodes.Status503ServiceUnavailable, "smoke_disabled");
            var now = clock.GetUtcNow();
            if (now < retained.State.OpenedAt)
                return Error(StatusCodes.Status503ServiceUnavailable, "smoke_state_invalid");
            if (now >= retained.State.ExpiresAt)
                return Error(StatusCodes.Status503ServiceUnavailable, "smoke_expired");
            if (retained.State.Mode == "delay")
            {
                await Task.Delay(TimeSpan.FromSeconds(7), request.HttpContext.RequestAborted);
                return Error(StatusCodes.Status503ServiceUnavailable, "smoke_delayed");
            }
            return retained.State.Mode switch
            {
                "valid" => CalendarResponse(Calendar(now)),
                "unavailable" => Error(StatusCodes.Status503ServiceUnavailable, "smoke_source_unavailable"),
                "malformed" => CalendarResponse("Fixed synthetic smoke data is not an iCalendar document.\r\n"),
                "unsupported_range" => CalendarResponse(Calendar(now, unsupportedRange: true)),
                _ => Error(StatusCodes.Status503ServiceUnavailable, "smoke_state_invalid")
            };
        }
        catch (ModeStoreException error)
        {
            return Error(StatusCodes.Status503ServiceUnavailable, error.Code);
        }
        catch (OperationCanceledException)
        {
            return Error(StatusCodes.Status503ServiceUnavailable, "smoke_storage_unavailable");
        }
    }

    [Function("SmokeSourceControl")]
    public async Task<IActionResult> Control(
        [HttpTrigger(AuthorizationLevel.Function, "post", Route = "smoke-source-control")] HttpRequest request)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        if (request.QueryString.HasValue || !request.HasJsonContentType() || request.ContentLength > 1024)
            return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(request.HttpContext.RequestAborted);
        deadline.CancelAfter(TimeSpan.FromSeconds(3));
        try
        {
            var buffer = new byte[1025];
            var length = await request.Body.ReadAtLeastAsync(buffer, buffer.Length, false, deadline.Token);
            if (length > 1024)
                return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
            using var body = JsonDocument.Parse(buffer.AsMemory(0, length), new JsonDocumentOptions { MaxDepth = 4 });
            var now = clock.GetUtcNow();
            if (body.RootElement.ValueKind != JsonValueKind.Object
                || !body.RootElement.TryGetProperty("mode", out var mode)
                || mode.ValueKind != JsonValueKind.String)
                return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
            if (mode.GetString() == "disabled")
            {
                if (body.RootElement.EnumerateObject().Count() != 1)
                    return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
                for (var attempt = 0; attempt < 3; attempt++)
                    if (await store.TryDelete(deadline.Token))
                        return new ContentResult
                        {
                            StatusCode = StatusCodes.Status200OK,
                            ContentType = "application/json",
                            Content = """{"code":"smoke_disabled"}"""
                        };
                return Error(StatusCodes.Status409Conflict, "smoke_conflict");
            }
            if (body.RootElement.EnumerateObject().Count() != 2 || !IsActiveMode(mode.GetString())
                || !body.RootElement.TryGetProperty("expires_at", out var expires)
                || expires.ValueKind != JsonValueKind.String || !expires.TryGetDateTimeOffset(out var expiresAt)
                || expiresAt.Offset != TimeSpan.Zero || expiresAt <= now || expiresAt > now.AddMinutes(90))
                return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var previous = await store.Read(deadline.Token);
                if (previous is not null)
                {
                    if (clock.GetUtcNow() < previous.State.OpenedAt || clock.GetUtcNow() >= previous.State.ExpiresAt)
                        return Error(StatusCodes.Status409Conflict, "smoke_window_expired");
                    if (expiresAt > previous.State.ExpiresAt)
                        return Error(StatusCodes.Status409Conflict, "smoke_window_extension");
                }
                var state = new ModeState(1, mode.GetString()!, previous?.State.OpenedAt ?? now, expiresAt);
                if (await store.TryWrite(state, previous?.Version, deadline.Token))
                    return new ContentResult
                    {
                        StatusCode = StatusCodes.Status200OK,
                        ContentType = "application/json",
                        Content = JsonSerializer.Serialize(state, JsonOptions)
                    };
            }
            return Error(StatusCodes.Status409Conflict, "smoke_conflict");
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            return Error(StatusCodes.Status400BadRequest, "smoke_configuration_invalid");
        }
        catch (ModeStoreException error)
        {
            return Error(StatusCodes.Status503ServiceUnavailable, error.Code);
        }
        catch (OperationCanceledException)
        {
            return Error(StatusCodes.Status503ServiceUnavailable, "smoke_storage_unavailable");
        }
    }

    private ContentResult Error(int status, string code)
    {
        logger.LogWarning("Temporary smoke source failed with code {ErrorCode}.", code);
        return new ContentResult
        {
            StatusCode = status,
            ContentType = "application/json",
            Content = JsonSerializer.Serialize(new { code })
        };
    }

    private static bool IsActiveMode(string? mode) =>
        mode is "valid" or "unavailable" or "delay" or "malformed" or "unsupported_range";

    private static ContentResult CalendarResponse(string calendar) => new()
    {
        StatusCode = StatusCodes.Status200OK,
        ContentType = "text/calendar; charset=utf-8",
        Content = calendar
    };

    private static string Calendar(DateTimeOffset now, bool unsupportedRange = false)
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById("America/Los_Angeles");
        var primary = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        while (primary.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            primary = primary.AddDays(1);
        var secondary = primary.AddDays(1);
        while (secondary.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday)
            secondary = secondary.AddDays(1);
        string Date(DateOnly value) => value.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var lines = new List<string>
        {
            "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TRMNL Calendar//Temporary synthetic smoke//EN",
            "BEGIN:VEVENT", "UID:smoke-primary-all-day@synthetic.invalid", "DTSTAMP:20260101T000000Z",
            $"DTSTART;VALUE=DATE:{Date(primary)}", $"DTEND;VALUE=DATE:{Date(primary.AddDays(1))}",
            "SUMMARY:Synthetic smoke primary all-day", "END:VEVENT",
            "BEGIN:VEVENT", "UID:smoke-primary-planning@synthetic.invalid", "DTSTAMP:20260101T000000Z",
            $"DTSTART;TZID=America/Los_Angeles:{Date(primary)}T230000",
            $"DTEND;TZID=America/Los_Angeles:{Date(primary)}T233000"
        };
        if (unsupportedRange)
            lines.Add("RRULE:FREQ=DAILY;COUNT=8");
        lines.AddRange([
            "SUMMARY:Synthetic smoke primary planning", "END:VEVENT",
            "BEGIN:VEVENT", "UID:smoke-secondary-planning@synthetic.invalid", "DTSTAMP:20260101T000000Z",
            $"DTSTART;TZID=America/Los_Angeles:{Date(secondary)}T090000",
            $"DTEND;TZID=America/Los_Angeles:{Date(secondary)}T093000",
            "SUMMARY:Synthetic smoke secondary planning", "END:VEVENT"
        ]);
        if (unsupportedRange)
            lines.AddRange([
                "BEGIN:VEVENT", "UID:smoke-primary-planning@synthetic.invalid", "DTSTAMP:20260101T000000Z",
                $"RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/Los_Angeles:{Date(secondary)}T230000",
                $"DTSTART;TZID=America/Los_Angeles:{Date(secondary)}T220000",
                $"DTEND;TZID=America/Los_Angeles:{Date(secondary)}T223000",
                "SUMMARY:Synthetic smoke unsupported range", "END:VEVENT"
            ]);
        lines.AddRange(["END:VCALENDAR", ""]);
        return string.Join("\r\n", lines);
    }

    private sealed record ModeState(int Version, string Mode, DateTimeOffset OpenedAt, DateTimeOffset ExpiresAt);
    private sealed record StoredMode(ModeState State, string Version);
    private sealed class ModeStoreException(string code) : Exception
    {
        public string Code { get; } = code;
    }

    private abstract class ModeStore
    {
        protected const string BlobName = "temporary-smoke-source-mode.json";

        internal static ModeStore Create(IConfiguration configuration) =>
            configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development"
                && configuration["Agenda:DevelopmentCacheDirectory"] is { Length: > 0 } directory
                    ? new FileModeStore(directory)
                    : new BlobModeStore(configuration);

        internal abstract Task<StoredMode?> Read(CancellationToken cancellationToken);
        internal abstract Task<bool> TryWrite(ModeState state, string? version, CancellationToken cancellationToken);
        internal abstract Task<bool> TryDelete(CancellationToken cancellationToken);

        protected static async Task<StoredMode> ReadState(Stream stream, string? version,
            CancellationToken cancellationToken)
        {
            var buffer = new byte[1025];
            var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, cancellationToken);
            if (length > 1024)
                throw new ModeStoreException("smoke_state_invalid");
            try
            {
                using var document = JsonDocument.Parse(buffer.AsMemory(0, length),
                    new JsonDocumentOptions { MaxDepth = 4 });
                if (document.RootElement.ValueKind != JsonValueKind.Object
                    || document.RootElement.EnumerateObject().Count() != 4)
                    throw new ModeStoreException("smoke_state_invalid");
                var state = JsonSerializer.Deserialize<ModeState>(buffer.AsSpan(0, length), JsonOptions);
                if (state is null || state.Version != 1 || !IsActiveMode(state.Mode)
                    || state.OpenedAt == default || state.ExpiresAt <= state.OpenedAt
                    || state.OpenedAt.Offset != TimeSpan.Zero || state.ExpiresAt.Offset != TimeSpan.Zero
                    || state.ExpiresAt - state.OpenedAt > TimeSpan.FromMinutes(90))
                    throw new ModeStoreException("smoke_state_invalid");
                return new StoredMode(state, version ?? Convert.ToHexString(SHA256.HashData(buffer.AsSpan(0, length))));
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException)
            {
                throw new ModeStoreException("smoke_state_invalid");
            }
        }

        protected static ModeStoreException Unavailable() => new("smoke_storage_unavailable");

        private sealed class FileModeStore(string directory) : ModeStore
        {
            private readonly string path = Path.Combine(directory, BlobName);

            internal override async Task<StoredMode?> Read(CancellationToken cancellationToken)
            {
                try
                {
                    await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
                    return await ReadState(stream, null, cancellationToken);
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    return null;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    throw Unavailable();
                }
            }

            internal override async Task<bool> TryWrite(ModeState state, string? version,
                CancellationToken cancellationToken)
            {
                try
                {
                    Directory.CreateDirectory(directory);
                    await using var stream = new FileStream(path, version is null ? FileMode.CreateNew : FileMode.Open,
                        FileAccess.ReadWrite,
                        FileShare.Delete, 4096, FileOptions.Asynchronous);
                    var previous = stream.Length == 0 ? null : await ReadState(stream, null, cancellationToken);
                    if (previous?.Version != version)
                        return false;
                    var bytes = JsonSerializer.SerializeToUtf8Bytes(state, JsonOptions);
                    stream.Position = 0;
                    stream.SetLength(0);
                    await stream.WriteAsync(bytes, cancellationToken);
                    await stream.FlushAsync(cancellationToken);
                    return true;
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    return false;
                }
                catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33 or 11 or 80 or 183)
                {
                    return false;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    throw Unavailable();
                }
            }

            internal override async Task<bool> TryDelete(CancellationToken cancellationToken)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    await using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite,
                        FileShare.Delete, 4096, FileOptions.Asynchronous);
                    File.Delete(path);
                    return true;
                }
                catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    return true;
                }
                catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33 or 11)
                {
                    return false;
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    throw Unavailable();
                }
            }
        }

        private sealed class BlobModeStore(IConfiguration configuration) : ModeStore
        {
            private static readonly ManagedIdentityCredential Identity = new(ManagedIdentityId.SystemAssigned);

            private BlobClient Client()
            {
                var endpoint = configuration["Agenda:CacheServiceUri"];
                var container = configuration["Agenda:CacheContainer"];
                if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                    || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
                    || uri.AbsolutePath != "/" || string.IsNullOrWhiteSpace(container)
                    || container.Length is < 3 or > 63
                    || container.Any(character => !(character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
                    || container[0] == '-' || container[^1] == '-' || container.Contains("--", StringComparison.Ordinal))
                    throw new ModeStoreException("smoke_storage_configuration");
                var options = new BlobClientOptions
                {
                    Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(2) },
                    Diagnostics =
                    {
                        IsLoggingEnabled = false,
                        IsLoggingContentEnabled = false,
                        IsDistributedTracingEnabled = false
                    }
                };
                return new BlobServiceClient(uri, Identity, options)
                    .GetBlobContainerClient(container).GetBlobClient(BlobName);
            }

            internal override async Task<StoredMode?> Read(CancellationToken cancellationToken)
            {
                try
                {
                    var response = await Client().DownloadStreamingAsync(cancellationToken: cancellationToken);
                    await using var stream = response.Value.Content;
                    return await ReadState(stream, response.Value.Details.ETag.ToString(), cancellationToken);
                }
                catch (RequestFailedException error) when (error.Status == 404 && error.ErrorCode == "BlobNotFound")
                {
                    return null;
                }
                catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
                {
                    throw Unavailable();
                }
            }

            internal override async Task<bool> TryWrite(ModeState state, string? version,
                CancellationToken cancellationToken)
            {
                try
                {
                    await Client().UploadAsync(BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(state, JsonOptions)),
                        new BlobUploadOptions
                        {
                            Conditions = version is null
                                ? new BlobRequestConditions { IfNoneMatch = ETag.All }
                                : new BlobRequestConditions { IfMatch = new ETag(version) },
                            HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" }
                        }, cancellationToken);
                    return true;
                }
                catch (RequestFailedException error) when (error.Status == 412)
                {
                    return false;
                }
                catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
                {
                    throw Unavailable();
                }
            }

            internal override async Task<bool> TryDelete(CancellationToken cancellationToken)
            {
                try
                {
                    var client = Client();
                    var properties = await client.GetPropertiesAsync(cancellationToken: cancellationToken);
                    await client.DeleteAsync(conditions: new BlobRequestConditions { IfMatch = properties.Value.ETag },
                        cancellationToken: cancellationToken);
                    return true;
                }
                catch (RequestFailedException error) when (error.Status == 404 && error.ErrorCode == "BlobNotFound")
                {
                    return true;
                }
                catch (RequestFailedException error) when (error.Status == 412)
                {
                    return false;
                }
                catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
                {
                    throw Unavailable();
                }
            }
        }
    }
}
