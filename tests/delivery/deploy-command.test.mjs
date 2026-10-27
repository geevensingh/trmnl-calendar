import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("deployment defaults to an offline build and requires explicit approval before cloud mutation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-delivery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const stub = `
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      $global:LASTEXITCODE = 0
    }
  `;
  const run = arguments_ => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command",
    `${stub}; & .\\scripts\\deploy-azure.ps1 ${arguments_}`
  ], { cwd: root, encoding: "utf8", env: { ...process.env, AZURE_TEST_CALLS: callsPath } });

  const build = run("");
  assert.equal(build.status, 0, build.stderr);
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(args => args[0] === "bicep" && args[1] === "build"));
  const apply = run("-Mode Apply");
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /ApprovedResourcePlan/);
  assert.equal((await readFile(callsPath, "utf8")).trim().split(/\r?\n/).length, calls.length);
});

test("Release package retains the .NET 10 worker-indexed root, hidden extensions and a source hash", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageResult = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-File", join(root, "scripts", "package-function.ps1"),
    "-OutputDirectory", directory
  ], { cwd: root, encoding: "utf8", timeout: 180_000 });
  assert.equal(packageResult.status, 0, packageResult.stderr);
  const artifact = JSON.parse(packageResult.stdout);
  const manifest = JSON.parse(await readFile(artifact.manifest, "utf8"));
  assert.equal(manifest.framework, "net10.0");
  assert.match(manifest.commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.archive_sha256, /^[a-f0-9]{64}$/);
  const inspect = spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command",
    `$zip = [IO.Compression.ZipFile]::OpenRead($env:AGENDA_PACKAGE); try {
      $entries = @($zip.Entries.FullName)
      $reader = [IO.StreamReader]::new($zip.GetEntry('worker.config.json').Open())
      try { $worker = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      $reader = [IO.StreamReader]::new($zip.GetEntry('CalendarAgenda.runtimeconfig.json').Open())
      try { $runtime = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
      @{ entries = $entries; worker = $worker; runtime = $runtime } | ConvertTo-Json -Depth 12
    } finally { $zip.Dispose() }`
  ], { cwd: root, encoding: "utf8", env: { ...process.env, AGENDA_PACKAGE: artifact.archive } });
  assert.equal(inspect.status, 0, inspect.stderr);
  const packaged = JSON.parse(inspect.stdout);
  assert.ok(packaged.entries.includes("host.json"));
  assert.ok(packaged.entries.includes("worker.config.json"));
  assert.ok(packaged.entries.some(entry => entry.startsWith(".azurefunctions/")));
  assert.ok(!packaged.entries.some(entry => /local\.settings\.json|(^|\/)\.env/.test(entry)));
  assert.equal(packaged.worker.description.language, "dotnet-isolated");
  assert.equal(packaged.worker.description.defaultWorkerPath, "CalendarAgenda.dll");
  assert.equal(packaged.worker.description.workerIndexing, "true");
  assert.equal(packaged.runtime.runtimeOptions.tfm, "net10.0");
});

test("package retention protects the active and previous success regardless of age, leaving host state untouched", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const blobs = [
    { name: "active.zip", properties: { etag: "active-etag", lastModified: "2000-01-01T00:00:00Z" } },
    { name: "previous.zip", properties: { etag: "previous-etag", lastModified: "1999-01-01T00:00:00Z" } },
    { name: "obsolete.zip", properties: { etag: "obsolete-etag", lastModified: "2026-10-19T00:00:00Z" } },
    { name: "host-state-not-a-package.json", properties: { etag: "host-etag" } }
  ];
  const stub = `
    $global:PackageDeleted = $false
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      if ($args[0] -eq 'rest') { $env:AZURE_TEST_SITE }
      elseif ($args[0] -eq 'storage' -and $args[2] -eq 'list') {
        if ($global:PackageDeleted) {
          @($env:AZURE_TEST_BLOBS | ConvertFrom-Json | Where-Object name -NE 'obsolete.zip') | ConvertTo-Json
        } else { $env:AZURE_TEST_BLOBS }
      }
      elseif ($args[0] -eq 'storage' -and $args[2] -eq 'delete') { $global:PackageDeleted = $true }
      $global:LASTEXITCODE = 0
    }
  `;
  const site = { properties: { functionAppConfig: { deployment: { storage: {
    type: "blobContainer", value: "https://syntheticstorage.blob.core.windows.net/app-packages"
  } } } } };
  const arguments_ = "-SubscriptionId 00000000-0000-0000-0000-000000000001 -ResourceGroupName synthetic-group"
    + " -FunctionAppName synthetic-function -StorageAccountName syntheticstorage -DeploymentContainerName app-packages"
    + " -ActivePackage active.zip -PreviousSuccessfulPackage previous.zip";
  const run = flags => spawnSync("pwsh", [
    "-NoProfile", "-NonInteractive", "-Command",
    `${stub}; & .\\scripts\\prune-deployment-packages.ps1 ${arguments_} ${flags}`
  ], { cwd: root, encoding: "utf8", env: {
    ...process.env, AZURE_TEST_CALLS: callsPath,
    AZURE_TEST_SITE: JSON.stringify(site), AZURE_TEST_BLOBS: JSON.stringify(blobs)
  } });

  const plan = run("");
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).delete_candidates, ["obsolete.zip"]);
  const before = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(before.every(args => !args.includes("delete")));
  const apply = run("-Apply -ConfirmedActiveAndPreviousFromAzure");
  assert.equal(apply.status, 0, apply.stderr);
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const deletes = calls.filter(args => args[0] === "storage" && args[2] === "delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0][deletes[0].indexOf("--name") + 1], "obsolete.zip");
  assert.equal(deletes[0][deletes[0].indexOf("--if-match") + 1], "obsolete-etag");
  assert.equal(deletes[0][deletes[0].indexOf("--container-name") + 1], "app-packages");
  assert.equal(deletes[0][deletes[0].indexOf("--auth-mode") + 1], "login");
});

test("what-if sends only a runtime parameter-file reference and emits no recipient or secret values", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-whatif-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const parameterPath = join(directory, "parameters.json");
  const document = JSON.parse(await readFile(join(root, "infra", "parameters.example.json"), "utf8"));
  for (const [name, parameter] of Object.entries(document.parameters)) {
    if (parameter.value === "") parameter.value = name === "budgetAlertEmail"
      ? "SYNTHETIC_PRIVATE_RECIPIENT@example.invalid"
      : name === "agendaOwnerAddress" ? "mailto:SYNTHETIC_OWNER@example.invalid"
        : name === "budgetStartDate" ? "2026-10-01T00:00:00Z"
          : name === "releaseControllerPrincipalId" ? "00000000-0000-0000-0000-000000000002"
            : "syntheticresource";
  }
  await writeFile(parameterPath, JSON.stringify(document));
  const stub = `
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      '{"status":"Succeeded","changes":[]}'
      $global:LASTEXITCODE = 0
    }
    & .\\scripts\\deploy-azure.ps1 -Mode WhatIf -SubscriptionId 00000000-0000-0000-0000-000000000001 -ParametersFile $env:AZURE_TEST_PARAMETERS
  `;
  const run = () => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stub], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, AZURE_TEST_CALLS: callsPath, AZURE_TEST_PARAMETERS: parameterPath
    }
  });
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).azure_resources_changed, false);
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["deployment", "sub", "what-if"]);
  assert.ok(calls[0].includes(`@${parameterPath}`));
  assert.doesNotMatch(preview.stdout + preview.stderr + JSON.stringify(calls),
    /SYNTHETIC_PRIVATE_RECIPIENT|SYNTHETIC_OWNER/);
  document.parameters.agendaOwnerAddress.value = "https://synthetic.invalid/owner";
  await writeFile(parameterPath, JSON.stringify(document));
  const invalidOwner = run();
  assert.notEqual(invalidOwner.status, 0);
  assert.match(invalidOwner.stderr, /one exact mailto: address/);
  assert.doesNotMatch(invalidOwner.stderr, /SYNTHETIC_OWNER/);
  assert.equal((await readFile(callsPath, "utf8")).trim().split(/\r?\n/).length, 1);
  document.parameters.sourceUrl = { value: "https://synthetic.invalid/CONFIDENTIAL_SOURCE_KEY" };
  await writeFile(parameterPath, JSON.stringify(document));
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unapproved parameter/);
  assert.doesNotMatch(refused.stderr, /CONFIDENTIAL/);
  assert.equal((await readFile(callsPath, "utf8")).trim().split(/\r?\n/).length, 1);
});

test("release reconciliation uses the supported resource-only deletion action on the approved group", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-release-stack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const parameterPath = join(directory, "parameters.json");
  const document = JSON.parse(await readFile(join(root, "infra", "parameters.example.json"), "utf8"));
  for (const [name, parameter] of Object.entries(document.parameters)) {
    if (parameter.value === "") parameter.value = name === "budgetAlertEmail"
      ? "synthetic@example.invalid"
      : name === "agendaOwnerAddress" ? "mailto:SYNTHETIC_OWNER@example.invalid"
        : name === "budgetStartDate" ? "2026-10-01T00:00:00Z"
          : name === "releaseControllerPrincipalId" ? "00000000-0000-0000-0000-000000000002"
            : "syntheticresource";
  }
  await writeFile(parameterPath, JSON.stringify(document));
  const stub = `
    function global:git {
      if ($args -contains 'rev-parse') { 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
      $global:LASTEXITCODE = 0
    }
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      if ($args[0] -eq 'group' -and $args[1] -eq 'show') { 'syntheticresource' }
      elseif ($args[0] -eq 'stack') {
        $action = $args[[Array]::IndexOf($args, '--action-on-unmanage') + 1]
        $parameterFile = $args[[Array]::IndexOf($args, '--parameters') + 1].Substring(1)
        $parameters = Get-Content -LiteralPath $parameterFile -Raw | ConvertFrom-Json
        if ($action -notin @('deleteAll', 'deleteResources', 'detachAll') -or
            $parameters.parameters.agendaOwnerAddress.value -cne 'mailto:SYNTHETIC_OWNER@example.invalid') {
          $global:LASTEXITCODE = 2
          return
        }
        '{"outputs":{"reviewedCapacity":{"value":{"maximumInstanceCount":3,"instanceMemoryMB":4096,"alwaysReady":[{"name":"http","instanceCount":1}]}}}}'
      }
      $global:LASTEXITCODE = 0
    }
    & .\\scripts\\deploy-release-infrastructure.ps1 `
    + "-SubscriptionId 00000000-0000-0000-0000-000000000001 "
    + "-ApprovedResourceGroupName syntheticresource -ParametersFile $env:AZURE_TEST_PARAMETERS "
    + "-ReviewedMainCommit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const run = () => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stub], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, AZURE_TEST_CALLS: callsPath, AZURE_TEST_PARAMETERS: parameterPath
    }
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "reconciled", commit: "a".repeat(40),
    scaleAndConcurrency: {
      maximumInstanceCount: 3, instanceMemoryMB: 4096,
      alwaysReady: [{ name: "http", instanceCount: 1 }]
    }
  });
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_OWNER/);
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["group", "show"]);
  const reconciliation = calls[1];
  assert.deepEqual(reconciliation.slice(0, 3), ["stack", "group", "create"]);
  assert.equal(reconciliation[reconciliation.indexOf("--action-on-unmanage") + 1], "deleteResources");
  assert.equal(reconciliation[reconciliation.indexOf("--resource-group") + 1], "syntheticresource");
  assert.equal(reconciliation[reconciliation.indexOf("--deny-settings-mode") + 1], "denyDelete");
  assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC_OWNER/);

  for (const owner of [undefined, true, "https://SYNTHETIC_OWNER@example.invalid"]) {
    if (owner === undefined) delete document.parameters.agendaOwnerAddress;
    else document.parameters.agendaOwnerAddress = { value: owner };
    await writeFile(parameterPath, JSON.stringify(document));
    const refused = run();
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /runtime parameter|one exact mailto: address/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /SYNTHETIC_OWNER/);
    assert.deepEqual((await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse), calls);
  }
});

test("owner identity validation rejects missing and unsafe values before Azure without disclosing them", async t => {
  await mkdir(join(root, "artifacts"), { recursive: true });
  const directory = await mkdtemp(join(root, "artifacts", "agenda-owner-validation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const parameterPath = join(directory, "parameters.json");
  const document = JSON.parse(await readFile(join(root, "infra", "parameters.example.json"), "utf8"));
  for (const [name, parameter] of Object.entries(document.parameters)) {
    if (parameter.value === "") parameter.value = name === "budgetAlertEmail"
      ? "SYNTHETIC_PRIVATE_RECIPIENT@example.invalid"
      : name === "budgetStartDate" ? "2026-10-01T00:00:00Z"
        : name === "releaseControllerPrincipalId" ? "00000000-0000-0000-0000-000000000002"
          : "syntheticresource";
  }
  const stub = `
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      '{"status":"Succeeded","changes":[]}'
      $global:LASTEXITCODE = 0
    }
    & .\\scripts\\deploy-azure.ps1 -Mode WhatIf -SubscriptionId 00000000-0000-0000-0000-000000000001 -ParametersFile $env:AZURE_TEST_PARAMETERS
  `;
  const run = () => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stub], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, AZURE_TEST_CALLS: callsPath, AZURE_TEST_PARAMETERS: parameterPath
    }
  });
  const privateAddress = "SYNTHETIC_OWNER@example.invalid";
  const invalid = [
    undefined, "", " ", 42, null,
    `https://${privateAddress}`, `mailto:${privateAddress}?subject=private`,
    `mailto:${privateAddress}#private`, `mailto:${privateAddress},other@example.invalid`,
    `mailto:${privateAddress};other@example.invalid`, `mailto:Display Name <${privateAddress}>`,
    ` mailto:${privateAddress}`, `mailto:${privateAddress} `, `mailto:${privateAddress}\r\n`,
    `mailto:${privateAddress}%0A`, `mailto:%20${privateAddress}`,
    `mailto:Display%20Name%20%3C${privateAddress}%3E`, "mailto:SYNTHETIC_OWNER"
  ];
  for (const [index, owner] of invalid.entries()) {
    if (owner === undefined) delete document.parameters.agendaOwnerAddress;
    else document.parameters.agendaOwnerAddress = { value: owner };
    await writeFile(parameterPath, JSON.stringify(document));
    const refused = run();
    assert.equal(refused.status, 1, `owner input case ${index}`);
    assert.match(refused.stderr, /runtime parameter|Runtime parameter|one exact mailto: address/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /SYNTHETIC_OWNER|SYNTHETIC_PRIVATE_RECIPIENT/);
  }
  await assert.rejects(readFile(callsPath), { code: "ENOENT" });

  for (const owner of [`mailto:${privateAddress}`, `MAILTO:${privateAddress}`, "mailto:SYNTHETIC_OWNER%2Bcalendar@example.invalid"]) {
    document.parameters.agendaOwnerAddress = { value: owner };
    await writeFile(parameterPath, JSON.stringify(document));
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).azure_resources_changed, false);
    assert.doesNotMatch(accepted.stdout + accepted.stderr, /SYNTHETIC_OWNER|SYNTHETIC_PRIVATE_RECIPIENT/);
  }
  const calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args.includes(`@${parameterPath}`)));
  assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC_OWNER|SYNTHETIC_PRIVATE_RECIPIENT/);
});

test("code deployment requires a clean reviewed package and the approved on-demand .NET 10 Flex target", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agenda-code-deploy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const callsPath = join(directory, "azure-calls.jsonl");
  const parameterPath = join(directory, "parameters.json");
  const archivePath = join(directory, "calendar.zip");
  const manifestPath = join(directory, "manifest.json");
  const commit = "a".repeat(40);
  const bytes = Buffer.from("Synthetic package; archive structure is checked by the real publisher test.");
  await writeFile(archivePath, bytes);
  const manifest = {
    commit, framework: "net10.0", working_tree_clean: true,
    archive_sha256: createHash("sha256").update(bytes).digest("hex")
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const document = JSON.parse(await readFile(join(root, "infra", "parameters.example.json"), "utf8"));
  for (const [name, parameter] of Object.entries(document.parameters))
    if (parameter.value === "") parameter.value = name === "budgetAlertEmail"
      ? "synthetic@example.invalid"
      : name === "agendaOwnerAddress" ? "mailto:synthetic-owner@example.invalid"
        : name === "budgetStartDate" ? "2026-10-01T00:00:00Z"
          : name === "releaseControllerPrincipalId" ? "00000000-0000-0000-0000-000000000002"
            : "syntheticresource";
  await writeFile(parameterPath, JSON.stringify(document));
  const site = {
    kind: "functionapp,linux",
    properties: { httpsOnly: true, defaultHostName: "synthetic.azurewebsites.net",
      serverFarmId: "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/syntheticresource/providers/Microsoft.Web/serverfarms/syntheticresource",
      functionAppConfig: { runtime: { name: "dotnet-isolated", version: "10.0" },
        scaleAndConcurrency: { maximumInstanceCount: 1, instanceMemoryMB: 2048, alwaysReady: [] } } }
  };
  const functions = [
    { name: "Agenda", config: { bindings: [
      { type: "httpTrigger", authLevel: "function", route: "agenda", methods: ["post"] },
      { type: "http", direction: "out" }
    ] } },
    { name: "RefreshSource", config: { bindings: [
      { type: "timerTrigger", schedule: "0 */5 * * * *", useMonitor: true, runOnStartup: false }
    ] } }
  ];
  const smoke = {
    checks_passed: true, activation_complete: false, evidence_scope: "deployed_http_only",
    poll: { state: "current", error_code: null }
  };
  const stub = `
    function global:git {
      if ($args -contains 'rev-parse') { $env:AZURE_TEST_COMMIT }
      $global:LASTEXITCODE = 0
    }
    function global:node {
      if ($args[0] -like '*smoke-delivery.mjs') { $env:AZURE_TEST_SMOKE }
      $global:LASTEXITCODE = 0
    }
    function global:az {
      ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:AZURE_TEST_CALLS
      if ($args[0] -eq 'rest') {
        if (($args -join ' ') -match '/serverfarms/') { '{"sku":{"name":"FC1"},"properties":{"reserved":true}}' }
        else { $env:AZURE_TEST_SITE }
      }
      elseif ($args[0] -eq 'functionapp' -and $args[1] -eq 'function') { $env:AZURE_TEST_FUNCTIONS }
      $global:LASTEXITCODE = 0
    }
    & .\\scripts\\deploy-azure.ps1 -Mode DeployCode -ApprovedResourcePlan -SubscriptionId 00000000-0000-0000-0000-000000000001 -ParametersFile $env:AZURE_TEST_PARAMETERS -PackageFile $env:AZURE_TEST_PACKAGE -ReviewedIntegrationCommit $env:AZURE_TEST_COMMIT -ReviewedCapacityJson $env:AZURE_TEST_CAPACITY
  `;
  const run = (capacity = "") => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", stub], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, AZURE_TEST_CALLS: callsPath, AZURE_TEST_PARAMETERS: parameterPath,
      AZURE_TEST_PACKAGE: archivePath, AZURE_TEST_COMMIT: commit, AZURE_TEST_SITE: JSON.stringify(site),
      AZURE_TEST_FUNCTIONS: JSON.stringify(functions), AZURE_TEST_SMOKE: JSON.stringify(smoke),
      AZURE_TEST_CAPACITY: capacity,
      TRMNL_FUNCTION_KEY: "synthetic-function-key"
    }
  });

  const deployed = run();
  assert.equal(deployed.status, 0, deployed.stderr);
  let calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const deployment = calls.find(args => args[0] === "functionapp");
  assert.deepEqual(deployment.slice(0, 4), ["functionapp", "deployment", "source", "config-zip"]);
  assert.equal(deployment[deployment.indexOf("--build-remote") + 1], "false");
  assert.equal(deployment[deployment.indexOf("--src") + 1], archivePath);
  assert.equal(calls.filter(args => args[0] === "functionapp" && args[1] === "deployment").length, 1);
  assert.equal(calls.filter(args => args[0] === "functionapp" && args[1] === "function").length, 1);
  const verifiedCalls = calls;
  manifest.working_tree_clean = false;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const dirty = run();
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /clean.*reviewed|reviewed.*clean/);
  calls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(calls, verifiedCalls);

  manifest.working_tree_clean = true;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const revisedScale = { maximumInstanceCount: 3, instanceMemoryMB: 4096, alwaysReady: [{ name: "http", instanceCount: 1 }] };
  site.properties.functionAppConfig.scaleAndConcurrency = revisedScale;
  const missingPlan = run();
  assert.notEqual(missingPlan.status, 0);
  assert.match(missingPlan.stderr, /live target differs/);
  const reviewedPlan = JSON.stringify({ commit, scaleAndConcurrency: revisedScale });
  const revised = run(reviewedPlan);
  assert.equal(revised.status, 0, revised.stderr);
  const previousCalls = (await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const stalePlan = run(JSON.stringify({ commit: "b".repeat(40), scaleAndConcurrency: revisedScale }));
  assert.notEqual(stalePlan.status, 0);
  assert.match(stalePlan.stderr, /capacity plan must come/);
  assert.deepEqual((await readFile(callsPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse), previousCalls);
  site.properties.functionAppConfig.scaleAndConcurrency = { ...revisedScale, alwaysReady: [] };
  const mismatch = run(reviewedPlan);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /live target differs/);
});
