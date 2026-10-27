using System.Text.Json.Serialization;

namespace CalendarAgenda;

public enum AgendaState { Current, Stale, Error }

public enum ParticipationExpectation { Definite, Likely, Maybe, Unlikely, Unknown }

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
public abstract record AgendaOccurrence(
    string Id, string Title, string? Location, ParticipationExpectation ParticipationExpectation);

public sealed record TimedOccurrence(
    string Id,
    string Title,
    string? Location,
    DateTimeOffset StartAt,
    DateTimeOffset EndAt,
    ParticipationExpectation ParticipationExpectation)
    : AgendaOccurrence(Id, Title, Location, ParticipationExpectation);

public sealed record AllDayOccurrence(
    string Id,
    string Title,
    string? Location,
    DateOnly StartDate,
    DateOnly EndDateExclusive,
    ParticipationExpectation ParticipationExpectation)
    : AgendaOccurrence(Id, Title, Location, ParticipationExpectation);

public sealed record AgendaError(string Code, string Message);
