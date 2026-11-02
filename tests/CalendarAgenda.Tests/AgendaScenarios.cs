using System.Text.Json.Nodes;

namespace CalendarAgenda.Tests;

internal static class AgendaScenarios
{
    internal static string DirectoryPath => Path.Combine(DisplayTests.Root, "display", "scenarios");

    internal static JsonObject Load(string id) => ValidationTiming.Run("scenario.load",
        () => JsonNode.Parse(File.ReadAllText(Path.Combine(DirectoryPath, $"{id}.json")))!
            ["agenda"]!.AsObject(), id);

    internal static IEnumerable<string> Ids =>
        Directory.GetFiles(DirectoryPath, "*.json").Order(StringComparer.Ordinal)
            .Select(Path.GetFileNameWithoutExtension).OfType<string>();
}
