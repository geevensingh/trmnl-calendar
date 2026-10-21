using System.Text.Json.Serialization;

namespace CalendarAgenda;

internal sealed record RefreshAttempt(string SourceKey, string RefreshId, DateTimeOffset StartedAt,
    [property: JsonRequired] long Generation = 0, [property: JsonRequired] bool Committing = false);

internal sealed record RefreshStatus(int Version, string SourceKey, string RefreshId,
    DateTimeOffset StartedAt, DateTimeOffset CompletedAt, DateTimeOffset? SourceSucceededAt, string? ErrorCode,
    int? FailureDetail = null, [property: JsonRequired] long Generation = 0,
    [property: JsonRequired] RefreshAttempt? Pending = null);

internal static class RefreshErrors
{
    // Persisted detail IDs are append-only and map exclusively to fixed application messages.
    private static readonly string[] SourceMessages =
    [
        "The calendar source exceeds the supported size.",
        "The calendar source is not valid UTF-8.",
        "The source must contain exactly one calendar.",
        "The calendar source is not an iCalendar 2.0 calendar.",
        "The source contains an event without an identifier.",
        "The source contains conflicting event properties.",
        "The source contains an invalid event date or duration.",
        "The source contains an invalid recurrence date.",
        "The source contains an event without a valid start.",
        "The source contains conflicting event date types.",
        "The source contains duplicate event series identifiers.",
        "The source contains an invalid event interval.",
        "The source contains duplicate event occurrence identifiers."
    ];
    private static readonly string[] CompatibilityMessages =
    [
        "The source uses an unsupported calendar method or scale.",
        "Recurring changes with RANGE=THISANDFUTURE are not supported.",
        "The source contains an unsupported recurrence range.",
        "Deprecated recurrence exclusion rules are not supported.",
        "The source contains calendar semantics not supported by this slice.",
        "A timed event end or duration is required by this slice.",
        "A detached recurring change must specify a single complete occurrence.",
        "The source contains a floating event or recurrence time.",
        "A recurring change uses a different identifier date type.",
        "Detached occurrences with the same identifier and actual start are not supported.",
        "The source contains an unsupported time zone.",
        "The calendar recurrence could not be safely evaluated."
    ];

    internal static int? Detail(AgendaError error)
    {
        var messages = error.Code switch
        {
            "source_invalid" => SourceMessages,
            "compatibility_unsupported" => CompatibilityMessages,
            _ => []
        };
        var index = Array.IndexOf(messages, error.Message);
        return index < 0 ? null : index;
    }

    internal static bool ValidDetail(string? code, int? detail) => detail is null || code switch
    {
        "source_invalid" => detail >= 0 && detail < SourceMessages.Length,
        "compatibility_unsupported" => detail >= 0 && detail < CompatibilityMessages.Length,
        _ => false
    };

    internal static AgendaError For(string code, int? detail = null) => new(code, detail is { } index
        && ValidDetail(code, detail) ? (code == "source_invalid" ? SourceMessages : CompatibilityMessages)[index] : code switch
    {
        "source_configuration" => "The calendar source is not configured correctly.",
        "source_unavailable" => "The calendar source could not be checked.",
        "source_invalid" => "The calendar source could not be interpreted.",
        "compatibility_unsupported" => "The source contains unsupported calendar semantics.",
        "cache_configuration" => "Persistent calendar storage is not configured correctly.",
        "cache_unavailable" => "The retained calendar source could not be accessed.",
        "cache_invalid" => "The retained calendar source is not usable.",
        "refresh_missing" => "No completed source refresh is available.",
        "refresh_delayed" => "The scheduled source refresh is delayed.",
        "refresh_incomplete" => "The source refresh could not be committed completely.",
        _ => throw new ArgumentException("Unknown refresh failure category.", nameof(code))
    });

    internal static bool IsKnown(string code) => code is "source_configuration" or "source_unavailable"
        or "source_invalid" or "compatibility_unsupported" or "cache_configuration" or "cache_unavailable"
        or "cache_invalid" or "refresh_missing" or "refresh_delayed" or "refresh_incomplete";
}
