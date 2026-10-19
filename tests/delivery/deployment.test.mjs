import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("Functions diagnostics disable automatic URL capture and bound allowed telemetry", async () => {
  const host = JSON.parse(await readFile(join(root, "src", "CalendarAgenda", "host.json"), "utf8"));
  const insights = host.logging.applicationInsights;

  assert.equal(insights?.enableDependencyTracking, false);
  assert.equal(insights.httpAutoCollectionOptions.enableHttpTriggerExtendedInfoCollection, false);
  assert.equal(insights.enableLiveMetrics, false);
  assert.equal(insights.enablePerformanceCountersCollection, false);
  assert.equal(insights.snapshotConfiguration.isEnabled, false);
  assert.equal(insights.samplingSettings.isEnabled, true);
  assert.equal(insights.samplingSettings.maxTelemetryItemsPerSecond, 1);
  assert.deepEqual(host.logging.logLevel, {
    default: "None",
    "Function.Agenda.User": "Warning",
    "Function.SmokeSource.User": "Warning",
    "Function.SmokeSourceControl.User": "Warning",
    "Host.Aggregator": "Information",
    "System.Net.Http.HttpClient": "None",
    Azure: "None"
  });
});

test("compiled Azure plan is Linux .NET 10 Flex with one on-demand instance and separate identities", () => {
    const build = spawnSync("pwsh", [
      "-NoProfile", "-NonInteractive", "-Command",
      "az bicep build --file .\\infra\\main.bicep --stdout --only-show-errors"
    ], { cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(build.status, 0, build.stderr);
    const main = JSON.parse(build.stdout);
    const template = main.resources.find(resource => resource.type === "Microsoft.Resources/deployments")
      .properties.template;
    const resource = type => template.resources.filter(item => item.type === type);
    const [plan] = resource("Microsoft.Web/serverfarms");
    assert.deepEqual(plan.sku, { name: "FC1", tier: "FlexConsumption" });
    assert.equal(plan.properties.reserved, true);
    const [app] = resource("Microsoft.Web/sites");
    assert.equal(app.kind, "functionapp,linux");
    assert.equal(app.properties.httpsOnly, true);
    assert.deepEqual(app.properties.functionAppConfig.runtime, { name: "dotnet-isolated", version: "10.0" });
    assert.deepEqual(app.properties.functionAppConfig.scaleAndConcurrency, {
      maximumInstanceCount: 1, instanceMemoryMB: 2048, alwaysReady: []
    });
    assert.equal(app.identity.type, "SystemAssigned, UserAssigned");
    assert.equal(app.properties.functionAppConfig.deployment.storage.authentication.type, "UserAssignedIdentity");
    assert.equal(resource("Microsoft.ManagedIdentity/userAssignedIdentities").length, 1);
    const [storage] = resource("Microsoft.Storage/storageAccounts");
    assert.equal(resource("Microsoft.Storage/storageAccounts").length, 1);
    assert.equal(storage.kind, "StorageV2");
    assert.equal(storage.sku.name, "Standard_LRS");
    assert.equal(storage.properties.allowSharedKeyAccess, false);
    assert.equal(storage.properties.allowBlobPublicAccess, false);
    const settings = resource("Microsoft.Web/sites/config")[0].properties;
    assert.equal(settings.AZURE_FUNCTIONS_ENVIRONMENT, "Production");
    assert.equal(settings.AzureWebJobsStorage__credential, "managedidentity");
    assert.ok(settings.AzureWebJobsStorage__clientId);
    assert.ok(settings.Agenda__CacheServiceUri);
    assert.ok(settings.Agenda__CacheContainer);
    assert.match(settings.Agenda__SourceUrl, /@Microsoft\.KeyVault\(SecretUri=/);
    assert.doesNotMatch(settings.Agenda__SourceUrl, /\/\)/,
      "Use the documented versionless secret URI, without an empty trailing version segment.");
    assert.equal(settings.APPLICATIONINSIGHTS_AUTHENTICATION_STRING, "Authorization=AAD");
    assert.equal(settings.Agenda__DevelopmentCacheDirectory, undefined);
    assert.equal(settings.AzureWebJobsStorage, undefined);
    assert.equal(settings.WEBSITE_RUN_FROM_PACKAGE, undefined);
    assert.equal(template.parameters.budgetAlertEmail.type.toLowerCase(), "securestring");
    assert.equal(template.parameters.budgetAlertEmail.defaultValue, undefined);
    assert.equal(main.parameters.functionAppName.defaultValue, undefined);
    assert.equal(main.parameters.budgetStartDate.defaultValue, undefined,
      "The original budget start date must be a persistent runtime input, not drift on every month's redeploy.");
    const roles = resource("Microsoft.Authorization/roleAssignments");
    const roleIds = roles.map(role => role.properties.roleDefinitionId.match(/'[a-f0-9-]{36}'/)[0]);
    assert.deepEqual(roleIds.sort(), [
      "'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'",
      "'0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'",
      "'ba92f5b4-2d11-453d-a403-e96b0029c9fe'",
      "'4633458b-17de-408a-b874-0445c86b69e6'",
      "'3913510d-42f4-4e42-8a64-420c390055eb'"
    ].sort());
    const cacheRole = roles.find(role => role.properties.roleDefinitionId.includes("ba92f5b4"));
    assert.match(cacheRole.scope, /cacheContainerName/);
    assert.match(cacheRole.properties.principalId, /Microsoft\.Web\/sites.*identity\.principalId/);
    assert.match(roles.find(role => role.properties.roleDefinitionId.includes("0a9a7e1f")).condition,
      /retainHostDiagnostics/);
    const [blobService] = resource("Microsoft.Storage/storageAccounts/blobServices");
    assert.equal(blobService.properties.isVersioningEnabled, false);
    assert.equal(blobService.properties.deleteRetentionPolicy.enabled, false);
    assert.equal(blobService.properties.containerDeleteRetentionPolicy.enabled, false);
    const policy = resource("Microsoft.Storage/storageAccounts/managementPolicies")[0].properties.policy;
    assert.equal(policy.rules.length, 1);
    assert.match(policy.rules[0].definition.filters.prefixMatch[0], /cacheContainerName/);
    assert.match(policy.rules[0].definition.filters.prefixMatch[0], /last-good-source\.json/);
    assert.equal(policy.rules[0].definition.actions.baseBlob.delete.daysAfterModificationGreaterThan, 1);
    const [workspace] = resource("Microsoft.OperationalInsights/workspaces");
    assert.equal(workspace.properties.retentionInDays, 30);
    assert.ok([0.1, "[json('0.1')]"].includes(workspace.properties.workspaceCapping.dailyQuotaGb));
    assert.equal(resource("Microsoft.Insights/components")[0].properties.DisableLocalAuth, true);
    const [budget] = resource("Microsoft.Consumption/budgets");
    assert.equal(budget.properties.amount, 20);
    assert.equal(budget.properties.timeGrain, "Monthly");
    assert.deepEqual(Object.values(budget.properties.notifications).map(item =>
      [item.thresholdType, item.threshold]), [["Actual", 50], ["Actual", 80], ["Actual", 100], ["Forecasted", 100]]);
    assert.ok(Object.values(budget.properties.notifications).every(item =>
      item.enabled && item.contactEmails[0].includes("parameters('budgetAlertEmail')")));
});
