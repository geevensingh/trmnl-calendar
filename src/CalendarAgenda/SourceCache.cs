using System.Globalization;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Microsoft.Extensions.Configuration;

namespace CalendarAgenda;

internal sealed record SourceSnapshot(int Version, string SourceKey, DateTimeOffset SucceededAt, string Calendar);

internal sealed class SourceCacheException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal abstract class SourceCache
{
    private const int SnapshotLimit = 13 * 1024 * 1024;

    internal static SourceCache Create(IConfiguration configuration) =>
        configuration["AZURE_FUNCTIONS_ENVIRONMENT"] == "Development"
            && configuration["Agenda:DevelopmentCacheDirectory"] is { Length: > 0 } directory
                ? new FileSourceCache(directory)
                : new BlobSourceCache(configuration);

    internal abstract Task<SourceSnapshot?> Read(CancellationToken cancellationToken);
    internal abstract Task Write(SourceSnapshot snapshot, CancellationToken cancellationToken);

    protected static async Task<SourceSnapshot> ReadSnapshot(Stream stream, CancellationToken cancellationToken)
    {
        var buffer = new byte[SnapshotLimit + 1];
        var length = await stream.ReadAtLeastAsync(buffer, buffer.Length, false, cancellationToken);
        if (length > SnapshotLimit)
            throw InvalidSnapshot();
        try
        {
            var snapshot = JsonSerializer.Deserialize<SourceSnapshot>(buffer.AsSpan(0, length),
                new JsonSerializerOptions { MaxDepth = 4 });
            if (snapshot is null || snapshot.Version != 1 || snapshot.SourceKey is not { Length: 64 }
                || snapshot.SucceededAt == default || string.IsNullOrEmpty(snapshot.Calendar)
                || Encoding.UTF8.GetByteCount(snapshot.Calendar) > 2 * 1024 * 1024)
                throw InvalidSnapshot();
            return snapshot;
        }
        catch (JsonException)
        {
            throw InvalidSnapshot();
        }
    }

    protected static SourceCacheException InvalidSnapshot() =>
        new("cache_invalid", "The retained calendar source is not usable.");

    protected static SourceCacheException Unavailable() =>
        new("cache_unavailable", "The retained calendar source could not be accessed.");

    private sealed class FileSourceCache(string directory) : SourceCache
    {
        private readonly string path = Path.Combine(directory, "last-good-source.json");

        internal override async Task<SourceSnapshot?> Read(CancellationToken cancellationToken)
        {
            try
            {
                await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.Asynchronous);
                return await ReadSnapshot(stream, cancellationToken);
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
                .GetBlobContainerClient(container).GetBlobClient("last-good-source.json");
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
                        if (properties.Value.Metadata.TryGetValue("source_key", out var key) && key == snapshot.SourceKey
                            && properties.Value.Metadata.TryGetValue("source_succeeded_at", out var value)
                            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                                DateTimeStyles.None, out var succeededAt) && succeededAt > snapshot.SucceededAt)
                            return;
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
                                    ["source_succeeded_at"] = snapshot.SucceededAt.ToString("O", CultureInfo.InvariantCulture)
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
