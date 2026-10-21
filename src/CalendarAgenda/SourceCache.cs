using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Blobs.Specialized;
using Microsoft.Extensions.Configuration;

namespace CalendarAgenda;

internal sealed record SourceSnapshot(int Version, string SourceKey, DateTimeOffset SucceededAt, string Calendar,
    DateTimeOffset RefreshStartedAt = default, string? RefreshId = null, long Generation = 0);

internal sealed class SourceCacheException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal abstract class SourceCache
{
    private const int SnapshotLimit = 13 * 1024 * 1024;
    private static readonly JsonSerializerOptions EnvelopeOptions = new()
    {
        MaxDepth = 4,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    internal static SourceCache Create(IConfiguration configuration) =>
        configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development"
            && configuration["Agenda:DevelopmentCacheDirectory"] is { Length: > 0 } directory
                ? new FileSourceCache(directory)
                : new BlobSourceCache(configuration);

    internal abstract Task<SourceSnapshot?> Read(CancellationToken cancellationToken);
    internal abstract Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken);
    internal virtual Task<RefreshStatus?> ReadStatus(CancellationToken cancellationToken) =>
        Task.FromResult<RefreshStatus?>(null);
    protected virtual Task WriteStatus(RefreshStatus status, CancellationToken cancellationToken, string? leaseId = null) =>
        throw Unavailable();

    internal virtual Task<RefreshAttempt> Begin(RefreshAttempt attempt, CancellationToken cancellationToken) =>
        BeginLocked(attempt, cancellationToken);

    internal virtual Task Complete(RefreshStatus status, SourceSnapshot? snapshot, CancellationToken cancellationToken) =>
        CompleteLocked(status, snapshot, cancellationToken);

    protected static RefreshStatus MissingStatus(RefreshAttempt attempt) =>
        new(1, attempt.SourceKey, attempt.RefreshId, attempt.StartedAt, attempt.StartedAt, null, "refresh_missing");

    protected async Task<RefreshAttempt> BeginLocked(RefreshAttempt attempt,
        CancellationToken cancellationToken, string? leaseId = null)
    {
        RefreshStatus? previous;
        try
        {
            previous = await ReadStatus(cancellationToken);
        }
        catch (SourceCacheException error) when (error.Code == "cache_invalid")
        {
            previous = null;
        }
        if (previous?.StartedAt > attempt.StartedAt || previous?.Pending?.StartedAt > attempt.StartedAt)
            return attempt;
        var generation = previous?.Generation ?? 0;
        if (previous is null)
        {
            try
            {
                generation = (await Read(cancellationToken))?.Generation ?? 0;
            }
            catch (SourceCacheException error) when (error.Code == "cache_invalid") { }
        }
        if (generation == long.MaxValue)
            throw InvalidSnapshot();
        var pending = attempt with { Generation = generation + 1 };
        await WriteStatus((previous ?? MissingStatus(attempt)) with
        {
            Generation = pending.Generation,
            Pending = pending
        }, cancellationToken, leaseId);
        return pending;
    }

    protected async Task CompleteLocked(RefreshStatus status, SourceSnapshot? snapshot,
        CancellationToken cancellationToken, string? leaseId = null)
    {
        var previous = await ReadStatus(cancellationToken);
        if (previous?.Pending is not { } pending || pending.RefreshId != status.RefreshId
            || pending.SourceKey != status.SourceKey || pending.Generation != status.Generation)
            return;
        cancellationToken.ThrowIfCancellationRequested();
        // Fence the two-blob commit: a partial write can never certify current source.
        await WriteStatus(previous with { Pending = pending with { Committing = true } }, cancellationToken, leaseId);
        if (snapshot is not null)
            await Write(snapshot, cancellationToken);
        await WriteStatus(status, cancellationToken, leaseId);
    }

    protected static async Task<RefreshStatus> ReadRefreshStatus(Stream stream, CancellationToken cancellationToken)
    {
        var bytes = new byte[4097];
        var length = await stream.ReadAtLeastAsync(bytes, bytes.Length, false, cancellationToken);
        if (length > 4096)
            throw InvalidSnapshot();
        try
        {
            var status = DeserializeEnvelope<RefreshStatus>(bytes.AsMemory(0, length));
            if (status.Version != 1 || !ValidSourceKey(status.SourceKey)
                || !Guid.TryParseExact(status.RefreshId, "N", out _) || status.StartedAt == default
                || status.CompletedAt < status.StartedAt
                || status.Generation < 0 || status.Generation == 0 && status.ErrorCode != "refresh_missing"
                || status.CompletedGeneration < 0 || status.CompletedGeneration > status.Generation
                || status.CompletedGeneration == 0 && status.ErrorCode != "refresh_missing"
                || status.Pending is null && status.CompletedGeneration != status.Generation
                || status.Pending is { } pending && (!ValidSourceKey(pending.SourceKey)
                    || !Guid.TryParseExact(pending.RefreshId, "N", out _) || pending.StartedAt == default
                    || pending.StartedAt < status.CompletedAt
                    || pending.Generation <= status.CompletedGeneration || pending.Generation != status.Generation
                    || status.CompletedGeneration > 0 && pending.RefreshId == status.RefreshId)
                || !RefreshErrors.ValidDetail(status.ErrorCode, status.FailureDetail)
                || (status.ErrorCode is null ? status.SourceSucceededAt is null
                    || status.SourceSucceededAt < status.StartedAt || status.SourceSucceededAt > status.CompletedAt
                    : status.SourceSucceededAt is not null || !RefreshErrors.IsKnown(status.ErrorCode)))
                throw InvalidSnapshot();
            return status;
        }
        catch (JsonException)
        {
            throw InvalidSnapshot();
        }
    }

    protected static async Task<SourceSnapshot> ReadSnapshot(Stream stream, CancellationToken cancellationToken)
    {
        var buffer = new byte[SnapshotLimit + 1];
        var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, cancellationToken);
        if (length > SnapshotLimit)
            throw InvalidSnapshot();
        try
        {
            var snapshot = DeserializeEnvelope<SourceSnapshot>(buffer.AsMemory(0, length));
            if (snapshot.Version is not (1 or 2) || !ValidSourceKey(snapshot.SourceKey)
                || snapshot.SucceededAt == default || string.IsNullOrEmpty(snapshot.Calendar)
                || snapshot.Version == 2 && (snapshot.RefreshStartedAt == default
                    || snapshot.Generation <= 0
                    || snapshot.RefreshStartedAt > snapshot.SucceededAt
                    || !Guid.TryParseExact(snapshot.RefreshId, "N", out _))
                || Encoding.UTF8.GetByteCount(snapshot.Calendar) > 2 * 1024 * 1024)
                throw InvalidSnapshot();
            return snapshot;
        }
        catch (JsonException)
        {
            throw InvalidSnapshot();
        }
    }

    private static bool ValidSourceKey(string key) =>
        key is { Length: 64 } && key.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static T DeserializeEnvelope<T>(ReadOnlyMemory<byte> bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw InvalidSnapshot();
        RejectDuplicateMembers(document.RootElement);
        if (typeof(T) == typeof(SourceSnapshot)
            && document.RootElement.TryGetProperty("Version", out var version)
            && version.ValueKind == JsonValueKind.Number && version.TryGetInt32(out var number) && number == 1
            && document.RootElement.EnumerateObject().Count() != 4)
            throw InvalidSnapshot();
        return JsonSerializer.Deserialize<T>(bytes.Span, EnvelopeOptions) ?? throw InvalidSnapshot();
    }

    private static void RejectDuplicateMembers(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw InvalidSnapshot();
                RejectDuplicateMembers(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
                RejectDuplicateMembers(item);
        }
    }

    protected static SourceCacheException InvalidSnapshot() =>
        new("cache_invalid", "The retained calendar source is not usable.");

    protected static SourceCacheException Unavailable() =>
        new("cache_unavailable", "The retained calendar source could not be accessed.");

    private sealed class FileSourceCache(string directory) : SourceCache
    {
        private readonly string path = Path.Combine(directory, "last-good-source.json");
        private readonly string statusPath = Path.Combine(directory, "source-refresh-status.json");

        internal override Task<RefreshAttempt> Begin(RefreshAttempt attempt, CancellationToken cancellationToken) =>
            Locked(() => BeginLocked(attempt, cancellationToken), cancellationToken);

        internal override Task Complete(RefreshStatus status, SourceSnapshot? snapshot, CancellationToken cancellationToken) =>
            Locked(async () =>
            {
                await CompleteLocked(status, snapshot, cancellationToken);
                return true;
            }, cancellationToken);

        private async Task<T> Locked<T>(Func<Task<T>> action, CancellationToken cancellationToken)
        {
            try
            {
                Directory.CreateDirectory(directory);
                FileStream? guard = null;
                while (guard is null)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        guard = new FileStream(Path.Combine(directory, "source-refresh.lock"),
                            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    }
                    catch (IOException)
                    {
                        await Task.Delay(20, cancellationToken);
                    }
                }
                await using (guard)
                    return await action();
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw Unavailable();
            }
        }

        internal override async Task<RefreshStatus?> ReadStatus(CancellationToken cancellationToken)
        {
            try
            {
                await using var stream = new FileStream(statusPath, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
                return await ReadRefreshStatus(stream, cancellationToken);
            }
            catch (Exception error) when (error is FileNotFoundException
                || error is DirectoryNotFoundException && !File.Exists(directory))
            {
                return null;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw Unavailable();
            }
        }

        protected override async Task WriteStatus(RefreshStatus status, CancellationToken cancellationToken,
            string? leaseId = null)
        {
            var temporary = Path.Combine(directory, $"{Guid.NewGuid():N}.tmp");
            try
            {
                Directory.CreateDirectory(directory);
                await File.WriteAllBytesAsync(temporary, JsonSerializer.SerializeToUtf8Bytes(status), cancellationToken);
                File.Move(temporary, statusPath, overwrite: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw Unavailable();
            }
            finally
            {
                if (File.Exists(temporary))
                    File.Delete(temporary);
            }
        }

        internal override async Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            try
            {
                await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
                return await ReadSnapshot(stream, cancellationToken);
            }
            catch (Exception error) when (error is FileNotFoundException
                || error is DirectoryNotFoundException && !File.Exists(directory))
            {
                return null;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw Unavailable();
            }
        }

        internal override async Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken)
        {
            var temporary = Path.Combine(directory, $"{Guid.NewGuid():N}.tmp");
            try
            {
                Directory.CreateDirectory(directory);
                await File.WriteAllBytesAsync(temporary, JsonSerializer.SerializeToUtf8Bytes(snapshot), cancellationToken);
                File.Move(temporary, path, overwrite: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw Unavailable();
            }
            finally
            {
                try
                {
                    File.Delete(temporary);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    throw Unavailable();
                }
            }
        }
    }

    private sealed class BlobSourceCache(IConfiguration configuration) : SourceCache
    {
        private static readonly ManagedIdentityCredential Identity = new(ManagedIdentityId.SystemAssigned);

        internal override Task<RefreshAttempt> Begin(RefreshAttempt attempt, CancellationToken cancellationToken) =>
            Locked(MissingStatus(attempt), lease => BeginLocked(attempt, cancellationToken, lease), cancellationToken);

        internal override Task Complete(RefreshStatus status, SourceSnapshot? snapshot, CancellationToken cancellationToken) =>
            Locked(status, async lease =>
            {
                await CompleteLocked(status, snapshot, cancellationToken, lease);
                return true;
            }, cancellationToken);

        private async Task<T> Locked<T>(RefreshStatus seed, Func<string, Task<T>> action, CancellationToken cancellationToken)
        {
            try
            {
                var client = Client("source-refresh-status.json");
                try
                {
                    await client.UploadAsync(BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(
                        seed)),
                        new BlobUploadOptions
                        {
                            Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
                            HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" }
                        },
                        cancellationToken);
                }
                catch (RequestFailedException error) when (error.Status is 409 or 412) { }
                var lease = client.GetBlobLeaseClient();
                while (true)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        await lease.AcquireAsync(TimeSpan.FromSeconds(60), cancellationToken: cancellationToken);
                        break;
                    }
                    catch (RequestFailedException error) when (error.ErrorCode == "LeaseAlreadyPresent")
                    {
                        await Task.Delay(50, cancellationToken);
                    }
                }
                try
                {
                    return await action(lease.LeaseId);
                }
                finally
                {
                    if (!cancellationToken.IsCancellationRequested)
                        await lease.ReleaseAsync(cancellationToken: cancellationToken);
                }
            }
            catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
            {
                throw Unavailable();
            }
        }

        private BlobClient Client(string name = "last-good-source.json")
        {
            var endpoint = configuration["Agenda:CacheServiceUri"];
            var container = configuration["Agenda:CacheContainer"];
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
                || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
                || uri.AbsolutePath != "/" || string.IsNullOrWhiteSpace(container)
                || container.Length is < 3 or > 63
                || container.Any(character => !(character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
                || container[0] == '-' || container[^1] == '-' || container.Contains("--", StringComparison.Ordinal))
                throw new SourceCacheException("cache_configuration", "Persistent calendar storage is not configured correctly.");
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
                .GetBlobContainerClient(container).GetBlobClient(name);
        }

        internal override async Task<RefreshStatus?> ReadStatus(CancellationToken cancellationToken)
        {
            try
            {
                var response = await Client("source-refresh-status.json")
                    .DownloadStreamingAsync(cancellationToken: cancellationToken);
                await using var stream = response.Value.Content;
                return await ReadRefreshStatus(stream, cancellationToken);
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

        protected override async Task WriteStatus(RefreshStatus status, CancellationToken cancellationToken,
            string? leaseId = null)
        {
            try
            {
                await Client("source-refresh-status.json").UploadAsync(
                    BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(status)),
                    new BlobUploadOptions
                    {
                        Conditions = new BlobRequestConditions { LeaseId = leaseId },
                        HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" }
                    },
                    cancellationToken);
            }
            catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
            {
                throw Unavailable();
            }
        }

        internal override async Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            try
            {
                var response = await Client().DownloadStreamingAsync(cancellationToken: cancellationToken);
                await using var stream = response.Value.Content;
                return await ReadSnapshot(stream, cancellationToken);
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

        internal override async Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken)
        {
            try
            {
                var client = Client();
                for (var attempt = 0; attempt < 3; attempt++)
                {
                    ETag? previous = null;
                    try
                    {
                        var properties = await client.GetPropertiesAsync(cancellationToken: cancellationToken);
                        previous = properties.Value.ETag;
                        if (properties.Value.Metadata.TryGetValue("refresh_generation", out var value)
                            && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var generation)
                            && generation > snapshot.Generation)
                            throw InvalidSnapshot();
                    }
                    catch (RequestFailedException error) when (error.Status == 404 && error.ErrorCode == "BlobNotFound") { }
                    try
                    {
                        await client.UploadAsync(BinaryData.FromBytes(JsonSerializer.SerializeToUtf8Bytes(snapshot)),
                            new BlobUploadOptions
                            {
                                Conditions = previous is { } etag
                                    ? new BlobRequestConditions { IfMatch = etag }
                                    : new BlobRequestConditions { IfNoneMatch = ETag.All },
                                HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" },
                                Metadata = new Dictionary<string, string>
                                {
                                    ["source_key"] = snapshot.SourceKey,
                                    ["source_succeeded_at"] = snapshot.SucceededAt.ToString("O", CultureInfo.InvariantCulture),
                                    ["refresh_generation"] = snapshot.Generation.ToString(CultureInfo.InvariantCulture)
                                }
                            }, cancellationToken);
                        return;
                    }
                    catch (RequestFailedException error) when (error.Status == 412) { }
                }
                throw Unavailable();
            }
            catch (Exception error) when (error is RequestFailedException or AuthenticationFailedException or IOException)
            {
                throw Unavailable();
            }
        }
    }
}
