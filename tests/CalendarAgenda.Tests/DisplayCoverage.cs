using System.Security.Cryptography;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Xunit;
using NativeView = CalendarAgenda.Tests.AdaptiveDisplayTests.NativeView;

namespace CalendarAgenda.Tests;

internal static class DisplayCoverage
{
    internal sealed record Case(string Policy, string Method, string? Scenario, string View, string Variant);

    internal const string ScenarioMethod = "Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views";
    internal static readonly string[] ScenarioWrappers =
    [
        nameof(AdaptiveDisplayTests.Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views_d1),
        nameof(AdaptiveDisplayTests.Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views_d2),
        nameof(AdaptiveDisplayTests.Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views_d3),
        nameof(AdaptiveDisplayTests.Shared_workbench_scenarios_obey_display_invariants_in_all_six_native_views_d4)
    ];
    private const string TitleMethod = "Timed_and_all_day_titles_preserve_text_and_typography_with_visible_end_ellipsis";
    private sealed record Policy(int Version, string Id, string[] Scenarios, string[] SecondaryScenarios,
        Dictionary<string, string> AdaptiveFamilies, string[] TitleVariants, string[] SecondaryTitleVariants);

    private static readonly byte[] PolicyBytes = File.ReadAllBytes(Path.Combine(DisplayTests.Root, "tests", "display-coverage.json"));
    private static readonly Policy Definition = ReadPolicy();

    internal static readonly string Profile = ReadProfile();
    internal static string PolicyId => Definition.Id;
    internal static string PolicySha256 => Convert.ToHexStringLower(SHA256.HashData(PolicyBytes));
    internal static object Inventory => new
    {
        profile = Profile,
        policy_id = PolicyId,
        policy_sha256 = PolicySha256,
        expected = Cases(selected: true).ToArray(),
        omitted = Cases(selected: false).ToArray()
    };
    internal static IEnumerable<NativeView> AllViews =>
        AdaptiveDisplayTests.Views.Cast<object[]>().Select(row => (NativeView)row[0]);

    internal static string Key(NativeView view) => $"{view.Device}/{view.Placement}";
    internal static NativeView View(string key) => AllViews.Single(view => Key(view) == key);

    internal static IEnumerable<object[]> FamilyCases(string family)
    {
        if (!Definition.AdaptiveFamilies.TryGetValue(family, out var scope))
            throw new InvalidOperationException($"Unclassified display test family: {family}");
        return AllViews.Where(view => Profile == "Exhaustive" || scope == "all" || Key(view) == "og/full")
            .Select(view => new object[] { Key(view) });
    }

    internal static IEnumerable<NativeView> ScenarioViews(string scenario)
    {
        if (!Definition.Scenarios.Contains(scenario, StringComparer.Ordinal))
            throw new InvalidOperationException($"Unclassified display scenario: {scenario}");
        return AllViews.Where(view => Profile == "Exhaustive" || Key(view) == "og/full"
            || Definition.SecondaryScenarios.Contains(scenario, StringComparer.Ordinal));
    }

    internal static bool TitleVariant(NativeView view, string variant)
    {
        if (!Definition.TitleVariants.Contains(variant, StringComparer.Ordinal))
            throw new InvalidOperationException($"Unclassified display title variant: {variant}");
        return Profile == "Exhaustive" || Key(view) == "og/full"
            || Definition.SecondaryTitleVariants.Contains(variant, StringComparer.Ordinal);
    }

    internal static void Complete(NativeView view, string variant = "default", [CallerMemberName] string family = "")
        => ValidationTiming.CompleteCoverage(Identity(family, null, view, variant));

    internal static void CompleteScenario(string scenario, NativeView view)
        => ValidationTiming.CompleteCoverage(Identity(ScenarioMethod, scenario, view, "default"));

    internal static bool IsExpected(Case identity) => Cases(selected: true).Contains(identity);

    private static Case Identity(string family, string? scenario, NativeView view, string variant)
        => new($"{PolicyId}/{Profile}", $"CalendarAgenda.Tests.AdaptiveDisplayTests.{family}",
            scenario, Key(view), variant);

    private static IEnumerable<Case> Cases(bool selected)
    {
        foreach (var scenario in Definition.Scenarios)
            foreach (var view in AllViews)
                if (ScenarioViews(scenario).Contains(view) == selected)
                    yield return Identity(ScenarioMethod, scenario, view, "default");
        foreach (var family in Definition.AdaptiveFamilies.Keys)
            foreach (var view in AllViews)
            {
                var included = FamilyCases(family).Any(row => (string)row[0] == Key(view));
                foreach (var variant in family == TitleMethod ? Definition.TitleVariants : new[] { "default" })
                    if ((included && (family != TitleMethod || TitleVariant(view, variant))) == selected)
                        yield return Identity(family, null, view, variant);
            }
    }

    private static string ReadProfile()
    {
        var profile = Environment.GetEnvironmentVariable("TRMNL_DISPLAY_COVERAGE");
        if (string.IsNullOrEmpty(profile)) return "OgFirst";
        if (profile is "OgFirst" or "Exhaustive") return profile;
        throw new InvalidOperationException($"Unknown display coverage profile: {profile}");
    }

    private static Policy ReadPolicy()
    {
        var policy = JsonSerializer.Deserialize<Policy>(PolicyBytes, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
        }) ?? throw new InvalidOperationException("Missing display coverage policy.");
        if (policy.Version != 1 || policy.Id != "og-first-v1"
            || policy.AdaptiveFamilies.Count == 0
            || policy.AdaptiveFamilies.Values.Any(scope => scope is not ("all" or "og-full")))
            throw new InvalidOperationException("Invalid display coverage policy.");
        ValidateSet(policy.Scenarios, AgendaScenarios.Ids, "scenario catalogue");
        var families = typeof(AdaptiveDisplayTests).GetMethods()
            .Where(method => method.IsDefined(typeof(TheoryAttribute), inherit: false)
                && method.Name != ScenarioMethod && !ScenarioWrappers.Contains(method.Name, StringComparer.Ordinal))
            .Select(method => method.Name);
        ValidateSet(policy.AdaptiveFamilies.Keys.ToArray(), families, "adaptive test families");
        ValidateSubset(policy.SecondaryScenarios, policy.Scenarios, "secondary scenarios");
        ValidateSubset(policy.SecondaryTitleVariants, policy.TitleVariants, "secondary title variants");
        return policy;
    }

    private static void ValidateSet(string[] actual, IEnumerable<string> expected, string label)
    {
        if (actual.Distinct(StringComparer.Ordinal).Count() != actual.Length
            || !actual.Order(StringComparer.Ordinal).SequenceEqual(expected.Order(StringComparer.Ordinal)))
            throw new InvalidOperationException($"Display coverage policy does not classify the complete {label}.");
    }

    private static void ValidateSubset(string[] subset, string[] complete, string label)
    {
        if (subset.Length == 0 || subset.Distinct(StringComparer.Ordinal).Count() != subset.Length
            || subset.Any(value => !complete.Contains(value, StringComparer.Ordinal)))
            throw new InvalidOperationException($"Invalid display coverage {label}.");
    }
}
