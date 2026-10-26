using System.Text.Json.Serialization;

namespace CalendarAgenda;

public enum AgendaState { Current, Stale, Error }
public enum AgendaEmphasis { InProgress, Upcoming }

public sealed record AgendaResult(
    int SchemaVersion,
    AgendaState State,
    string TimeZone,
    DateTimeOffset GeneratedAt,
    DateTimeOffset? SourceSucceededAt,
    AgendaDay Primary,
    AgendaDay Secondary,
    AgendaError? Error);

public sealed record AgendaDay(
    DateOnly Date,
    string Label,
    int? EligibleTotal,
    IReadOnlyList<AgendaOccurrence> Occurrences);

[JsonPolymorphic(TypeDiscriminatorPropertyName = "time_kind")]
[JsonDerivedType(typeof(TimedOccurrence), "timed")]
[JsonDerivedType(typeof(AllDayOccurrence), "all_day")]
public abstract record AgendaOccurrence(string Id, string Title, string? Location);

public sealed record TimedOccurrence(
    string Id,
    string Title,
    string? Location,
    DateTimeOffset StartAt,
    DateTimeOffset EndAt,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    AgendaEmphasis? Emphasis = null) : AgendaOccurrence(Id, Title, Location);

public sealed record AllDayOccurrence(
    string Id,
    string Title,
    string? Location,
    DateOnly StartDate,
    DateOnly EndDateExclusive) : AgendaOccurrence(Id, Title, Location);

public sealed record AgendaError(string Code, string Message);
