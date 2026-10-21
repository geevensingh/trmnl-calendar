namespace CalendarAgenda;

internal sealed record SourceAcquisitionReport(bool Performed, string Code, int? HttpStatus = null,
    bool? CalendarMediaType = null, bool? HtmlMediaType = null, int? Utf8Bytes = null,
    long? HeadersMs = null, long? BodyMs = null, long? ElapsedMs = null);

internal sealed record SourcePhaseReport(bool Performed, string Code, long? ElapsedMs = null);

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
            try
            {
                var result = await Task.Run(() => Interpret(calendar, [], clock.GetUtcNow(), budget.Token))
                    .WaitAsync(budget.Token);
                budget.Token.ThrowIfCancellationRequested();
                interpretation = new SourcePhaseReport(true, result.Error?.Code ?? "supported",
                    ElapsedMilliseconds(interpretationStarted, ioClock.GetTimestamp()));
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
}
