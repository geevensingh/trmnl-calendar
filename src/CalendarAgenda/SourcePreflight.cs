using Calendar = Ical.Net.Calendar;

namespace CalendarAgenda;

internal sealed record SourceAcquisitionReport(bool Performed, string Code, int? HttpStatus = null,
    bool? CalendarMediaType = null, bool? HtmlMediaType = null, int? Utf8Bytes = null,
    long? HeadersMs = null, long? BodyMs = null, long? ElapsedMs = null);

internal sealed record ParticipationCapabilityReport(bool OwnerAddressConfigured,
    bool OwnerOrganizerObserved, bool OwnerAttendeeObserved, bool OwnerParticipationStatusObserved,
    bool FreeAvailabilityObserved, bool FollowedTitleMarkerObserved);

internal sealed record SourcePhaseReport(bool Performed, string Code, long? ElapsedMs = null,
    ParticipationCapabilityReport? ParticipationCapabilities = null);

internal sealed record SourcePreflightAttempt(int Number, SourceAcquisitionReport Acquisition,
    SourcePhaseReport Interpretation, long ElapsedMs);

public sealed partial class AgendaFunction
{
    private sealed record SourceAcquisition(string? Calendar, AgendaError? Error,
        SourceAcquisitionReport Report);

    internal async Task<SourcePreflightAttempt> InspectSource(int number)
    {
        var started = ioClock.GetTimestamp();
        if (!TrySource(out var uri))
            return new SourcePreflightAttempt(number, new(false, "invalid_input"),
                new(false, "not_performed"), 0);
        using var budget = new CancellationTokenSource(RefreshTimeout, ioClock);
        var acquired = await FetchSource(uri!, budget.Token, CancellationToken.None);
        var interpretation = new SourcePhaseReport(false, "not_performed");
        if (acquired.Calendar is { } calendar)
        {
            var interpretationStarted = ioClock.GetTimestamp();
            ParticipationCapabilityReport? participationCapabilities = null;
            try
            {
                var result = await Task.Run(() => Interpret(calendar, [], clock.GetUtcNow(), budget.Token,
                        parsed => participationCapabilities = InspectParticipationCapabilities(parsed)))
                    .WaitAsync(budget.Token);
                budget.Token.ThrowIfCancellationRequested();
                interpretation = new SourcePhaseReport(true, result.Error?.Code ?? "supported",
                    ElapsedMilliseconds(interpretationStarted, ioClock.GetTimestamp()), participationCapabilities);
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested)
            {
                interpretation = new SourcePhaseReport(true, "interpretation_timeout",
                    ElapsedMilliseconds(interpretationStarted, ioClock.GetTimestamp()), participationCapabilities);
            }
        }
        return new SourcePreflightAttempt(number, acquired.Report, interpretation,
            ElapsedMilliseconds(started, ioClock.GetTimestamp()));
    }

    private long ElapsedMilliseconds(long start, long end) =>
        Math.Max(0, (long)Math.Ceiling(ioClock.GetElapsedTime(start, end).TotalMilliseconds));

    private ParticipationCapabilityReport InspectParticipationCapabilities(Calendar calendar)
    {
        var ownerAddress = ConfiguredOwnerAddress(configuration["Agenda:OwnerAddress"]);
        var ownerOrganizerObserved = false;
        var ownerAttendeeObserved = false;
        var ownerParticipationStatusObserved = false;
        var freeAvailabilityObserved = false;
        var followedTitleMarkerObserved = false;
        foreach (var item in calendar.Events)
        {
            if (ownerAddress is not null)
            {
                ownerOrganizerObserved |= IsOwnerAddress(item.Organizer?.Value, ownerAddress);
                foreach (var attendee in item.Attendees.Where(attendee => IsOwnerAddress(attendee.Value, ownerAddress)))
                {
                    ownerAttendeeObserved = true;
                    ownerParticipationStatusObserved |= attendee.ParticipationStatus is not null;
                }
            }
            freeAvailabilityObserved |= string.Equals(item.Transparency,
                "TRANSPARENT", StringComparison.OrdinalIgnoreCase);
            followedTitleMarkerObserved |= item.Summary?.StartsWith(
                "Following: ", StringComparison.OrdinalIgnoreCase) == true;
        }
        return new ParticipationCapabilityReport(ownerAddress is not null, ownerOrganizerObserved,
            ownerAttendeeObserved, ownerParticipationStatusObserved, freeAvailabilityObserved,
            followedTitleMarkerObserved);
    }
}
