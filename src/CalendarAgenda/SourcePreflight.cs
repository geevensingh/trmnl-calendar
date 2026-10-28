using System.Net.Mail;
using Calendar = Ical.Net.Calendar;

namespace CalendarAgenda;

internal sealed record SourceAcquisitionReport(bool Performed, string Code, int? HttpStatus = null,
    bool? CalendarMediaType = null, bool? HtmlMediaType = null, int? Utf8Bytes = null,
    long? HeadersMs = null, long? BodyMs = null, long? ElapsedMs = null);

internal sealed record ParticipationCapabilityReport(bool OwnerAddressConfigured,
    bool OwnerOrganizerObserved, bool OwnerAttendeeObserved, bool OwnerParticipationStatusObserved,
    bool FreeAvailabilityObserved, bool FollowedTitleMarkerObserved,
    bool OwnerResponseUsableObserved, bool OwnerResponseMissingObserved, bool OwnerResponseUnsupportedObserved,
    bool OwnerAttendeeAmbiguousObserved);

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
                    ElapsedMilliseconds(interpretationStarted, ioClock.GetTimestamp()),
                    result.Error is null ? participationCapabilities : null);
            }
            catch (OperationCanceledException) when (budget.IsCancellationRequested)
            {
                interpretation = new SourcePhaseReport(true, "interpretation_timeout",
                    ElapsedMilliseconds(interpretationStarted, ioClock.GetTimestamp()));
            }
        }
        return new SourcePreflightAttempt(number, acquired.Report, interpretation,
            ElapsedMilliseconds(started, ioClock.GetTimestamp()));
    }

    private long ElapsedMilliseconds(long start, long end) =>
        Math.Max(0, (long)Math.Ceiling(ioClock.GetElapsedTime(start, end).TotalMilliseconds));

    private ParticipationCapabilityReport InspectParticipationCapabilities(Calendar calendar)
    {
        var configuredOwner = configuration["Agenda:OwnerAddress"];
        var ownerAddress = configuredOwner is not null
            && !configuredOwner.Any(character => char.IsWhiteSpace(character) || char.IsControl(character))
            ? ConfiguredOwnerAddress(configuredOwner) : null;
        if (!MailAddress.TryCreate(ownerAddress, out var mailbox)
            || !string.Equals(mailbox.Address, ownerAddress, StringComparison.Ordinal))
            ownerAddress = null;
        var ownerOrganizerObserved = false;
        var ownerAttendeeObserved = false;
        var ownerParticipationStatusObserved = false;
        var ownerResponseUsableObserved = false;
        var ownerResponseMissingObserved = false;
        var ownerResponseUnsupportedObserved = false;
        var ownerAttendeeAmbiguousObserved = false;
        var freeAvailabilityObserved = false;
        var followedTitleMarkerObserved = false;
        foreach (var item in calendar.Events)
        {
            if (ownerAddress is not null)
            {
                ownerOrganizerObserved |= IsOwnerAddress(item.Organizer?.Value, ownerAddress);
                var ownerAttendees = item.Attendees.Where(attendee => IsOwnerAddress(attendee.Value, ownerAddress))
                    .ToArray();
                ownerAttendeeAmbiguousObserved |= ownerAttendees.Length > 1;
                foreach (var attendee in ownerAttendees)
                {
                    ownerAttendeeObserved = true;
                    // A convenience getter may synthesize NEEDS-ACTION when PARTSTAT was not supplied.
                    var responses = attendee.Parameters.GetMany("PARTSTAT");
                    var supplied = responses is { Count: > 0 };
                    ownerParticipationStatusObserved |= supplied;
                    var usable = responses is { Count: 1 } && new[]
                    {
                        "ACCEPTED", "DECLINED", "TENTATIVE", "NEEDS-ACTION"
                    }.Contains(responses[0], StringComparer.OrdinalIgnoreCase);
                    ownerResponseUsableObserved |= ownerAttendees.Length == 1 && usable;
                    ownerResponseMissingObserved |= !supplied;
                    ownerResponseUnsupportedObserved |= supplied && !usable;
                }
            }
            freeAvailabilityObserved |= string.Equals(item.Transparency,
                "TRANSPARENT", StringComparison.OrdinalIgnoreCase);
            followedTitleMarkerObserved |= item.Summary?.StartsWith(
                "Following: ", StringComparison.OrdinalIgnoreCase) == true;
        }
        return new ParticipationCapabilityReport(ownerAddress is not null, ownerOrganizerObserved,
            ownerAttendeeObserved, ownerParticipationStatusObserved, freeAvailabilityObserved,
            followedTitleMarkerObserved, ownerResponseUsableObserved, ownerResponseMissingObserved,
            ownerResponseUnsupportedObserved, ownerAttendeeAmbiguousObserved);
    }
}
