using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace CalendarAgenda;

internal sealed record SourcePollAttempt(int? HttpStatus, string? Error, long? ElapsedMs);

internal sealed record SourcePollReport(bool Performed, string Code, bool? ChecksPassed = null,
    string? FailureCode = null, string? EvidenceScope = null, bool? AuthenticationEnforced = null,
    bool? MeasuredBeforeProbes = null, bool? ColdStartConfirmed = null, bool? RetryUsed = null,
    int? HttpStatus = null, string? State = null, string? ErrorCode = null,
    long? RawResponseUtf8Bytes = null, long? CombinedPollingUtf8Bytes = null,
    SourcePollAttempt[]? Attempts = null);

internal static class SourcePreflightPolling
{
    internal static async Task<SourcePollReport> Run(string endpoint, string key, bool synthetic)
    {
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        start.ArgumentList.Add(Path.Combine("scripts", "smoke-delivery.mjs"));
        start.ArgumentList.Add("--endpoint");
        start.ArgumentList.Add(endpoint);
        if (synthetic)
            start.ArgumentList.Add("--synthetic-local");
        start.Environment["TRMNL_FUNCTION_KEY"] = key;
        using var process = new Process { StartInfo = start };
        var started = false;
        try
        {
            started = process.Start();
            if (!started)
                return new(true, "polling_smoke_unavailable", false);
            var output = ReadBounded(process.StandardOutput);
            var errors = ReadBounded(process.StandardError);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(45));
            var text = process.ExitCode == 0 ? await output : await errors;
            await Task.WhenAll(output, errors);
            if (text is null)
                return new(true, "polling_smoke_invalid", false);
            return ReadReport(text, process.ExitCode == 0);
        }
        catch (TimeoutException)
        {
            return new(true, "polling_smoke_timeout", false);
        }
        catch (Exception error) when (error is Win32Exception or IOException or InvalidOperationException)
        {
            return new(true, "polling_smoke_unavailable", false);
        }
        finally
        {
            start.Environment.Remove("TRMNL_FUNCTION_KEY");
            if (started && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
    }

    private static async Task<string?> ReadBounded(StreamReader stream)
    {
        var text = new StringBuilder();
        var buffer = new char[4096];
        var oversized = false;
        int length;
        while ((length = await stream.ReadAsync(buffer)) > 0)
        {
            if (text.Length + length > 16 * 1024)
                oversized = true;
            if (!oversized)
                text.Append(buffer, 0, length);
        }
        return oversized ? null : text.ToString();
    }

    private static SourcePollReport ReadReport(string text, bool succeeded)
    {
        try
        {
            using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (root.GetProperty("checks_passed").GetBoolean() != succeeded)
                return new(true, "polling_smoke_invalid", false);
            var evidence = root.GetProperty(succeeded ? "poll" : "evidence");
            var attempts = evidence.TryGetProperty("attempts", out var array) ? array.EnumerateArray().Select(attempt =>
                new SourcePollAttempt((int?)Number(attempt, "http_status", 100, 599),
                    Text(attempt, "error") is "transport_failed" or "attempt_over_budget" ? Text(attempt, "error") : null,
                    Number(attempt, "elapsed_ms", 0, 45_000))).ToArray() : [];
            if (attempts.Length > 2)
                return new(true, "polling_smoke_invalid", false);
            bool? authenticated = null;
            if (succeeded)
            {
                var auth = root.GetProperty("authentication");
                authenticated = Number(auth, "missing_key_status", 100, 599) is 401 or 403
                    && Number(auth, "wrong_key_status", 100, 599) is 401 or 403;
                if (authenticated != true || attempts.Length == 0)
                    return new(true, "polling_smoke_invalid", false);
            }
            var state = Text(evidence, "state");
            var code = Text(evidence, "error_code");
            return new SourcePollReport(true, succeeded ? "passed" : "polling_smoke_failed", succeeded,
                succeeded ? null : SafeFailure(Text(root, "error")),
                succeeded ? Text(root, "evidence_scope") is "local_synthetic" ? "local_synthetic" : "deployed_http_only" : null,
                authenticated, Boolean(evidence, "measured_before_probes"), Boolean(evidence, "cold_start_confirmed"),
                Boolean(evidence, "retry_used"), (int?)Number(evidence, "http_status", 100, 599),
                state is "current" or "stale" or "error" ? state : "unknown",
                code is null ? null : RefreshErrors.IsKnown(code) || code is "configuration_invalid" or "agenda_too_large"
                    ? code : "unknown",
                Number(evidence, "raw_response_utf8_bytes", 0, 200_001),
                Number(evidence, "combined_polling_utf8_bytes", 0, 200_001), attempts);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException)
        {
            return new(true, "polling_smoke_invalid", false);
        }
    }

    private static string? Text(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString() : null;

    private static long? Number(JsonElement value, string name, long minimum, long maximum) =>
        value.TryGetProperty(name, out var property) && property.TryGetInt64(out var number)
            && number >= minimum && number <= maximum ? number : null;

    private static bool? Boolean(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? property.GetBoolean() : null;

    private static string SafeFailure(string? code) => code switch
    {
        "polling_budget_exceeded" or "authorized_poll_rejected" or "unexpected_calendar_state"
        or "unexpected_calendar_error" or "authentication_not_enforced" or "invalid_polling_contract"
        or "combined_polling_too_large" or "invalid_endpoint" or "invalid_source_success_time"
        or "transport_failed" or "attempt_over_budget" or "invalid_polling_json"
        or "invalid_polling_content_type" or "invalid_polling_utf8" or "response_too_large"
        or "function_key_required" or "invalid_expectation" or "invalid_rule_text_input"
        or "smoke_tool_failed" => code,
        _ => "unknown"
    };
}
