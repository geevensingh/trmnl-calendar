using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml;
using Xunit;
using Xunit.Sdk;

namespace CalendarAgenda.Tests;

public sealed class ValidationPartitionTests
{
    internal sealed record Case(
        [property: JsonPropertyName("test_id")] string TestId,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("method")] string Method,
        [property: JsonPropertyName("scenario")] string? Scenario);

    [Fact]
    public void Test_case_discovery_materializes_complete_unfiltered_inventory()
    {
        var cases = Discover();
        Assert.NotEmpty(cases);
        Assert.Equal(cases.Length, cases.Select(item => (item.TestId, item.Name)).Distinct().Count());
        var path = Environment.GetEnvironmentVariable("TRMNL_DISCOVERY_PATH");
        if (path is not null)
        {
            File.WriteAllText(path, JsonSerializer.Serialize(new
            {
                schema_version = 2,
                methods = cases.Select(item => item.Method).Distinct().Order(StringComparer.Ordinal).ToArray(),
                scenarios = AgendaScenarios.Ids.ToArray(),
                tests = cases,
                scenario_bridges = ScenarioBridges(cases),
                xunit = typeof(FactAttribute).Assembly.GetName().Version?.ToString(),
                adapter = Assembly.Load("xunit.runner.visualstudio.testadapter").GetName().Version?.ToString()
            }));
        }
    }

    private static object[] ScenarioBridges(Case[] cases)
    {
        var type = typeof(AdaptiveDisplayTests);
        var assembly = type.Assembly;
        var testAssembly = new TestAssembly(new ReflectionAssemblyInfo(assembly), null, assembly.GetName().Version);
        var collection = new TestCollection(testAssembly, null, $"Test collection for {type.FullName}");
        var testClass = new TestClass(collection, new ReflectionTypeInfo(type));
        var canonical = type.GetMethod(DisplayCoverage.ScenarioMethod, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Missing canonical scenario implementation.");
        var testMethod = new TestMethod(testClass, new ReflectionMethodInfo(canonical));
        return cases.Where(item => DisplayCoverage.ScenarioWrappers.Any(wrapper =>
            item.Method == $"{type.FullName}.{wrapper}")).Select(item =>
        {
            object[] arguments = [item.Scenario!];
            using var testCase = new XunitTestCase(new NullMessageSink(), TestMethodDisplay.ClassAndMethod,
                TestMethodDisplayOptions.None, testMethod, arguments);
            return (object)new
            {
                actual = item,
                canonical = Identity(testCase.UniqueID, testCase.DisplayName, canonical, arguments)
            };
        }).ToArray();
    }

    internal static Case[] Discover()
    {
        var assembly = typeof(ValidationPartitionTests).Assembly;
        var testAssembly = new TestAssembly(new ReflectionAssemblyInfo(assembly), null, assembly.GetName().Version);
        var sink = new NullMessageSink();
        var cases = new List<Case>();
        foreach (var type in assembly.GetTypes().OrderBy(type => type.FullName, StringComparer.Ordinal))
        {
            var collection = new TestCollection(testAssembly, null, $"Test collection for {type.FullName}");
            var testClass = new TestClass(collection, new ReflectionTypeInfo(type));
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic |
                BindingFlags.Instance | BindingFlags.Static)
                .OrderBy(method => method.Name, StringComparer.Ordinal))
            {
                var fact = method.GetCustomAttribute<FactAttribute>();
                if (fact is null) continue;
                if (fact.Skip is not null)
                    throw new InvalidOperationException("Skipped tests cannot define complete Full coverage.");
                var testMethod = new TestMethod(testClass, new ReflectionMethodInfo(method));
                using var parent = new XunitTestCase(sink, TestMethodDisplay.ClassAndMethod,
                    TestMethodDisplayOptions.None, testMethod);
                var data = testMethod.Method.GetCustomAttributes(typeof(DataAttribute).AssemblyQualifiedName!).ToArray();
                if (fact is not TheoryAttribute)
                {
                    if (data.Length != 0)
                        throw new InvalidOperationException("Unexpected test data on a non-theory method.");
                    cases.Add(Identity(parent.UniqueID, parent.DisplayName, method, null));
                    continue;
                }
                var discoverers = data.Select(attribute => (
                    Attribute: attribute,
                    Discoverer: ExtensibilityPointFactory.GetDataDiscoverer(sink,
                        attribute.GetCustomAttributes(typeof(DataDiscovererAttribute).AssemblyQualifiedName!).Single())
                )).ToArray();
                if (discoverers.Any(item => item.Attribute.GetNamedArgument<string>("Skip") is not null))
                    throw new InvalidOperationException("Skipped theory data cannot define complete Full coverage.");
                var rows = discoverers.SelectMany(item =>
                    item.Discoverer.GetData(item.Attribute, testMethod.Method)).ToArray();
                if (rows.Length == 0)
                    throw new InvalidOperationException($"Theory has no selected cases: {type.FullName}.{method.Name}");
                var preEnumerated = discoverers.All(item =>
                    item.Discoverer.SupportsDiscoveryEnumeration(item.Attribute, testMethod.Method)) &&
                    rows.All(SerializationHelper.IsSerializable);
                foreach (var row in rows)
                {
                    using var testCase = new XunitTestCase(sink, TestMethodDisplay.ClassAndMethod,
                        TestMethodDisplayOptions.None, testMethod, row);
                    cases.Add(Identity(preEnumerated ? testCase.UniqueID : parent.UniqueID,
                        testCase.DisplayName, method, row));
                }
            }
        }
        return cases.ToArray();
    }

    private static Case Identity(string uniqueId, string name, MethodInfo method, object[]? arguments)
    {
        var hash = SHA1.HashData(Encoding.Unicode.GetBytes($"executor://xunit/VsTestRunner3/netcore/{uniqueId}"));
        var id = new Guid(hash.AsSpan(0, 16)).ToString();
        var scenarioIndex = Array.FindIndex(method.GetParameters(), parameter => parameter.Name == "scenario");
        var scenario = arguments is not null && scenarioIndex >= 0 ? arguments[scenarioIndex] as string : null;
        // VSTest 17.14.1 persists invalid XML UTF-16 code units as literal \uXXXX escapes.
        var trxName = string.Concat(name.Select(character => XmlConvert.IsXmlChar(character)
            ? character.ToString() : $"\\u{(ushort)character:x4}"));
        return new(id, trxName, $"{method.DeclaringType!.FullName}.{method.Name}", scenario);
    }
}
