using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace CalendarAgenda;

internal static class SourcePreflightCommand
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    internal static async Task<int> Run(string[] arguments)
    {
        var report = new PreflightReport();
        CommandOptions? options = null;
        ProtectedInput? input = null;
        try
        {
            if (!arguments.Contains("--authorize-source-access", StringComparer.Ordinal))
                throw new PreflightFailure("source_access_not_authorized");
            options = ParseOptions(arguments);
            var synthetic = options.Synthetic;
            var compare = options.Compare;
            report.EvidenceScope = synthetic ? "local_synthetic" : "operator_machine";
            input = await ReadInput(synthetic, compare, options.AgendaEndpoint is not null);
            report.SourceInput = Describe(input.Source, synthetic);
            if (compare)
            {
                report.ReferenceInput = Describe(input.Reference!, synthetic);
                report.Comparison = new ComparisonReport(true,
                    string.Equals(input.Source, input.Reference, StringComparison.Ordinal),
                    string.Equals(input.Source.Trim(), input.Reference!.Trim(), StringComparison.Ordinal),
                    Uri.TryCreate(input.Source, UriKind.Absolute, out var sourceUri)
                        && Uri.TryCreate(input.Reference, UriKind.Absolute, out var referenceUri)
                        ? string.Equals(sourceUri.AbsoluteUri, referenceUri.AbsoluteUri, StringComparison.Ordinal)
                        : null);
                if (report.Comparison.ExactEqual != true)
                    throw new PreflightFailure("reference_mismatch");
            }
            if (!report.SourceInput.Valid)
                throw new PreflightFailure("invalid_input");
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Agenda:SourceUrl"] = input.Source,
                ["Agenda:OwnerAddress"] = Environment.GetEnvironmentVariable("Agenda__OwnerAddress"),
                ["AZURE_FUNCTIONS_ENVIRONMENT"] = synthetic ? "Development" : "Production"
            }).Build();
            var services = new ServiceCollection();
            AgendaHosting.AddSourceClient(services);
            await using var provider = services.BuildServiceProvider();
            using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient();
            var agenda = new AgendaFunction(client, configuration, TimeProvider.System,
                NullLogger<AgendaFunction>.Instance);
            for (var number = 1; number <= options.Attempts; number++)
                report.Attempts.Add(await agenda.InspectSource(number));
            report.SynchronousPolling = Assess(report.Attempts[0],
                AgendaFunction.HttpPollTimeout, AgendaFunction.HttpPollTimeout);
            report.ScheduledRefresh = Assess(report.Attempts[0],
                AgendaFunction.SourceAcquisitionTimeout, AgendaFunction.RefreshTimeout);
            var failure = report.Attempts.FirstOrDefault(attempt => attempt.Acquisition.Code != "received"
                || attempt.Interpretation.Code != "supported"
                || Assess(attempt, AgendaFunction.SourceAcquisitionTimeout, AgendaFunction.RefreshTimeout)
                    .FitsObservedBudget != true);
            report.ChecksPassed = failure is null;
            report.Error = failure is null ? null
                : failure.Acquisition.Code != "received" ? failure.Acquisition.Code
                : failure.Interpretation.Code != "supported" ? failure.Interpretation.Code
                : "scheduled_refresh_budget_exceeded";
        }
        catch (PreflightFailure failure)
        {
            report.Error = failure.Code;
        }
        if (options?.AgendaEndpoint is { } endpoint && input?.FunctionKey is { } key)
        {
            report.CacheOnlyPoll = await SourcePreflightPolling.Run(endpoint, key, options.Synthetic);
            if (report.CacheOnlyPoll.ChecksPassed != true)
            {
                report.ChecksPassed = false;
                report.Error ??= "cache_only_poll_failed";
            }
        }
        var json = JsonSerializer.Serialize(report, JsonOptions) + Environment.NewLine;
        if (options?.ReportFile is { } path)
        {
            try
            {
                await using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                await file.WriteAsync(Encoding.UTF8.GetBytes(json));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException
                or ArgumentException or NotSupportedException)
            {
                report.ChecksPassed = false;
                report.Error = "report_write_failed";
                json = JsonSerializer.Serialize(report, JsonOptions) + Environment.NewLine;
            }
        }
        Console.Write(json);
        return report.ChecksPassed ? 0 : 1;
    }

    private static CommandOptions ParseOptions(string[] arguments)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var options = new CommandOptions();
        for (var index = 0; index < arguments.Length; index++)
        {
            var argument = arguments[index];
            if (!seen.Add(argument))
                throw new PreflightFailure("invalid_options");
            switch (argument)
            {
                case "--authorize-source-access":
                    break;
                case "--synthetic-local":
                    options.Synthetic = true;
                    break;
                case "--compare-reference":
                    options.Compare = true;
                    break;
                case "--report-file":
                case "--agenda-endpoint":
                    if (++index == arguments.Length || arguments[index].StartsWith("--", StringComparison.Ordinal))
                        throw new PreflightFailure("invalid_options");
                    if (argument == "--report-file")
                        options.ReportFile = arguments[index];
                    else
                        options.AgendaEndpoint = arguments[index];
                    break;
                case "--attempts":
                    if (++index == arguments.Length || arguments[index] is not ("1" or "2"))
                        throw new PreflightFailure("invalid_options");
                    options.Attempts = arguments[index] == "1" ? 1 : 2;
                    break;
                default:
                    throw new PreflightFailure("invalid_options");
            }
        }
        return options;
    }

    private static async Task<ProtectedInput> ReadInput(bool synthetic, bool compare, bool poll)
    {
        if (!synthetic)
        {
            if (Console.IsInputRedirected)
                throw new PreflightFailure("protected_terminal_required");
            return new ProtectedInput(ReadHidden("source_input_required"),
                compare ? ReadHidden("reference_input_required") : null,
                poll ? ReadHidden("function_key_input_required") : null);
        }
        var buffer = new char[64 * 1024 + 1];
        var length = await Console.In.ReadBlockAsync(buffer, 0, buffer.Length);
        if (length == buffer.Length)
            throw new PreflightFailure("invalid_protected_input");
        try
        {
            using var document = JsonDocument.Parse(new string(buffer, 0, length),
                new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                throw new PreflightFailure("invalid_protected_input");
            var fields = root.EnumerateObject().ToArray();
            if (fields.Select(field => field.Name).Distinct(StringComparer.Ordinal).Count() != fields.Length
                || fields.Any(field => field.Name is not ("source" or "reference" or "function_key"))
                || !root.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.String
                || compare && (!root.TryGetProperty("reference", out var reference)
                    || reference.ValueKind != JsonValueKind.String)
                || poll && (!root.TryGetProperty("function_key", out var key) || key.ValueKind != JsonValueKind.String))
                throw new PreflightFailure("invalid_protected_input");
            return new ProtectedInput(source.GetString()!,
                compare ? root.GetProperty("reference").GetString() : null,
                poll ? root.GetProperty("function_key").GetString() : null);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException)
        {
            throw new PreflightFailure("invalid_protected_input");
        }
    }

    private static string ReadHidden(string prompt)
    {
        Console.Error.WriteLine(prompt);
        var text = new StringBuilder();
        while (true)
        {
            var key = Console.ReadKey(intercept: true);
            if (key.Key == ConsoleKey.Enter)
                return text.ToString();
            if (key.Key == ConsoleKey.Escape)
                throw new PreflightFailure("input_cancelled");
            if (key.Key == ConsoleKey.Backspace)
            {
                if (text.Length > 0)
                    text.Length--;
            }
            else
            {
                if (text.Length == 16 * 1024)
                    throw new PreflightFailure("invalid_protected_input");
                text.Append(key.KeyChar);
            }
        }
    }

    private static InputReport Describe(string value, bool synthetic)
    {
        var absolute = Uri.TryCreate(value, UriKind.Absolute, out var uri);
        var whitespace = value.Any(char.IsWhiteSpace);
        var controls = value.Any(char.IsControl);
        return new InputReport(absolute && value.Length <= 16 * 1024 && !whitespace && !controls
            && uri!.UserInfo.Length == 0 && uri.Fragment.Length == 0
            && (synthetic ? uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback
                : uri.Scheme == Uri.UriSchemeHttps),
            absolute, whitespace, controls,
            !string.Equals(value, value.Trim(), StringComparison.Ordinal),
            value.Length >= 2 && (value[0] == '"' && value[^1] == '"' || value[0] == '\'' && value[^1] == '\''),
            absolute ? uri!.Scheme == Uri.UriSchemeHttps : null,
            absolute ? uri!.IsLoopback : null,
            absolute ? uri!.UserInfo.Length > 0 : null,
            absolute ? uri!.Fragment.Length > 0 : null,
            absolute ? string.Equals(value, uri!.AbsoluteUri, StringComparison.Ordinal) : null);
    }

    private static BudgetAssessment Assess(SourcePreflightAttempt attempt, TimeSpan acquisition, TimeSpan overall)
    {
        var assessable = attempt.Acquisition.Code == "received" && attempt.Interpretation.Code == "supported";
        bool? fits = assessable ? attempt.Acquisition.ElapsedMs < acquisition.TotalMilliseconds
            && attempt.ElapsedMs < overall.TotalMilliseconds : null;
        return new BudgetAssessment(!assessable ? "not_assessable"
            : fits == true ? "within_observed_budget" : "exceeds_observed_budget",
            (long)acquisition.TotalMilliseconds, (long)overall.TotalMilliseconds, fits, attempt.Number);
    }

    private sealed class PreflightFailure(string code) : Exception
    {
        internal string Code { get; } = code;
    }

    private sealed record ProtectedInput(string Source, string? Reference, string? FunctionKey);
    private sealed record InputReport(bool Valid, bool AbsoluteUri, bool ContainsWhitespace,
        bool ContainsControlCharacters, bool LeadingOrTrailingWhitespace, bool SurroundingQuotes,
        bool? Https, bool? Loopback, bool? HasCredentials, bool? HasFragment, bool? UriRepresentationUnchanged);
    private sealed record ComparisonReport(bool Performed, bool? ExactEqual = null,
        bool? SameAfterTrimming = null, bool? SameUriRepresentation = null);
    private sealed record BudgetAssessment(string Code, long AcquisitionBudgetMs, long OverallBudgetMs,
        bool? FitsObservedBudget = null, int? AttemptNumber = null);

    private sealed record MeasurementScope(
        string ProcessInitialization = "not_measured",
        string AzureColdStart = "not_performed",
        string HostAuthentication = "not_performed",
        string ManagedIdentityAccess = "not_performed",
        string RefreshPersistence = "not_performed",
        string NativeTrmnlPolling = "not_performed",
        string PhysicalDeviceDelivery = "not_performed");

    private sealed class CommandOptions
    {
        internal bool Synthetic { get; set; }
        internal bool Compare { get; set; }
        internal int Attempts { get; set; } = 1;
        internal string? ReportFile { get; set; }
        internal string? AgendaEndpoint { get; set; }
    }

    private sealed class PreflightReport
    {
        public int SchemaVersion => 1;
        public bool ChecksPassed { get; set; }
        public bool ActivationComplete => false;
        public bool DeliveryDesignApproved => false;
        public string? Error { get; set; }
        public string EvidenceScope { get; set; } = "not_performed";
        public InputReport? SourceInput { get; set; }
        public InputReport? ReferenceInput { get; set; }
        public ComparisonReport Comparison { get; set; } = new(false);
        public List<SourcePreflightAttempt> Attempts { get; } = [];
        public BudgetAssessment SynchronousPolling { get; set; } = new("not_performed",
            (long)AgendaFunction.HttpPollTimeout.TotalMilliseconds, (long)AgendaFunction.HttpPollTimeout.TotalMilliseconds);
        public BudgetAssessment ScheduledRefresh { get; set; } = new("not_performed",
            (long)AgendaFunction.SourceAcquisitionTimeout.TotalMilliseconds,
            (long)AgendaFunction.RefreshTimeout.TotalMilliseconds);
        public MeasurementScope MeasurementScope { get; } = new();
        public SourcePollReport CacheOnlyPoll { get; set; } = new(false, "not_performed");
    }
}
