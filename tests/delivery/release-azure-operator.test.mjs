import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { operateReleaseAzure } from "../../scripts/release-azure-operator.mjs";

const subscription = "00000000-0000-0000-0000-000000000001";
const principal = "00000000-0000-0000-0000-000000000002";
const role = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const groupScope = `/subscriptions/${subscription}/resourceGroups/synthetic-group`;
const storageScope = `${groupScope}/providers/Microsoft.Storage/storageAccounts/syntheticrelease`;
const oldIds = [
  "00000000-0000-0000-0000-000000000003",
  "00000000-0000-0000-0000-000000000004"
];
const newIds = [
  "00000000-0000-0000-0000-000000000005",
  "00000000-0000-0000-0000-000000000006"
];
const containers = ["release-control", "release-artifacts"];
const scopes = containers.map(name => `${storageScope}/blobServices/default/containers/${name}`);

function assignment(name, scope) {
  return {
    name, scope, id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
    properties: {
      principalId: principal, principalType: "ServicePrincipal", condition: null,
      roleDefinitionId: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${role}`
    }
  };
}

function fixture() {
  const parameters = {
    resourceGroupName: { value: "synthetic-group" },
    storageAccountName: { value: "syntheticruntime" },
    releaseStorageAccountName: { value: "syntheticrelease" },
    releaseControlContainerName: { value: containers[0] },
    releaseArtifactContainerName: { value: containers[1] },
    releaseControllerPrincipalId: { value: principal },
    budgetAlertEmail: { value: "private-recipient@example.invalid" },
    agendaOwnerAddress: { value: "mailto:private-owner@example.invalid" }
  };
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AZURE_CONFIG_DIR: "/synthetic-azure-config",
    GITHUB_REF: "refs/heads/main",
    GITHUB_ACTOR: "owner",
    AZURE_SUBSCRIPTION_ID: subscription,
    AZURE_RESOURCE_GROUP_NAME: "synthetic-group",
    AZURE_STORAGE_ACCOUNT: "syntheticrelease",
    AZURE_RELEASE_CONTAINER: containers[0],
    AZURE_ARTIFACT_CONTAINER: containers[1],
    AZURE_PARAMETERS_JSON: JSON.stringify({ parameters }),
    OPERATOR_OPERATION: "inspect",
    OPERATOR_REASON: "Align only the approved bootstrap assignments",
    PREVIOUS_MUTATION_STOPPED: "true",
    OPERATOR_OLD_CONTROL_ASSIGNMENT_ID: oldIds[0],
    OPERATOR_NEW_CONTROL_ASSIGNMENT_ID: newIds[0],
    OPERATOR_OLD_ARTIFACT_ASSIGNMENT_ID: oldIds[1],
    OPERATOR_NEW_ARTIFACT_ASSIGNMENT_ID: newIds[1],
    TRMNL_API_KEY: "private-trmnl-key",
    TRMNL_FUNCTION_KEY: "private-function-key",
    GITHUB_TOKEN: "private-github-token"
  };
  const grants = new Map(oldIds.map((id, index) => [id, assignment(id, scopes[index])]));
  const calls = [];
  const state = {
    stackState: "Failed", deploymentState: "Failed", stacks: true,
    mutationFailure: null, rollbackFailure: false, appliedButFailed: false,
    wrongAccount: false, grantReadFailure: false, paginated: false,
    postMutationReadFailures: 0, persistentPostMutationReadFailure: false,
    controlOperationState: "Failed"
  };
  const runCommand = async (command, args, options) => {
    assert.equal(command, "az");
    calls.push([...args]);
    assert.equal(options.env.AZURE_CONFIG_DIR, env.AZURE_CONFIG_DIR);
    for (const name of ["AZURE_PARAMETERS_JSON", "TRMNL_API_KEY", "TRMNL_FUNCTION_KEY", "GITHUB_TOKEN"]) {
      assert.equal(options.env[name], undefined, `${name} reached Azure CLI`);
    }
    let result;
    if (args[0] === "account") result = state.wrongAccount ? "wrong-subscription" : subscription;
    else if (args[0] === "storage") result = { id: storageScope };
    else if (args[0] === "stack") {
      result = state.stacks ? [{ name: "trmnl-calendar-managed", provisioningState: state.stackState }] : [];
    } else if (args[0] === "deployment" && args[1] === "group") {
      result = [{ name: "synthetic-failed-deployment", properties: {
        provisioningState: state.deploymentState, timestamp: "2026-10-29T00:10:00Z"
      } }];
    } else if (args[0] === "deployment" && args[1] === "operation") {
      result = newIds.map((id, index) => ({
        state: index === 0 ? state.controlOperationState : "Failed", type: "Microsoft.Authorization/roleAssignments",
        id: `${scopes[index]}/providers/Microsoft.Authorization/roleAssignments/${id}`,
        code: index === 0 && state.controlOperationState === "Succeeded" ? null : "RoleAssignmentExists"
      }));
      result.push({
        state: "Failed", type: "Microsoft.Consumption/budgets",
        id: "private-resource-id", code: "private-error-code"
      });
    } else if (args[0] === "rest") {
      if (state.grantReadFailure) throw { stderr: "AuthorizationFailed private diagnostic", code: 1 };
      if (calls.some(call => call[0] === "role") &&
        (state.persistentPostMutationReadFailure || state.postMutationReadFailures > 0)) {
        state.postMutationReadFailures -= 1;
        throw { stderr: "AuthorizationFailed private post-mutation diagnostic", code: 1 };
      }
      const url = args[args.indexOf("--url") + 1];
      const scope = scopes.find(value => url.startsWith(`https://management.azure.com${value}/`));
      assert.ok(scope, "Assignment read escaped the two release containers");
      result = { value: [...grants.values()].filter(grant =>
        (grant.scope ?? grant.properties.scope ?? grant.id.slice(0, grant.id.lastIndexOf("/providers/")))
          .toLowerCase() === scope.toLowerCase()) };
      if (state.paginated) result.nextLink = "https://management.azure.com/private-next-page";
    } else if (args[0] === "role" && args[2] === "delete") {
      const id = args[args.indexOf("--ids") + 1].split("/").at(-1);
      assert.ok(oldIds.includes(id), "Deletion escaped the approved old assignments");
      grants.delete(id);
      if (state.mutationFailure === "delete") throw { stderr: "private-delete-error", code: 1 };
    } else if (args[0] === "role" && args[2] === "create") {
      const id = args[args.indexOf("--name") + 1];
      const scope = args[args.indexOf("--scope") + 1];
      assert.ok(scopes.includes(scope));
      assert.equal(args[args.indexOf("--role") + 1], role);
      assert.equal(args[args.indexOf("--assignee-object-id") + 1], principal);
      assert.equal(args[args.indexOf("--assignee-principal-type") + 1], "ServicePrincipal");
      if (state.rollbackFailure && oldIds.includes(id)) throw { stderr: "private-rollback-error", code: 1 };
      if (state.mutationFailure === "create" && newIds.includes(id) && !state.appliedButFailed) {
        throw { stderr: "RoleAssignmentExists private diagnostic", code: 1 };
      }
      if ([...grants.values()].some(grant => grant.name !== id &&
        (grant.scope ?? grant.properties.scope) === scope)) {
        throw { stderr: "RoleAssignmentExists private diagnostic", code: 1 };
      }
      result = assignment(id, scope);
      grants.set(id, result);
      if (state.mutationFailure === "create" && newIds.includes(id)) {
        throw { stderr: "private-timeout-after-create", code: 1 };
      }
    } else assert.fail(`Unexpected Azure command ${args.slice(0, 3).join(" ")}`);
    return { stdout: result === undefined ? "" : JSON.stringify(result), stderr: "" };
  };
  return { env, parameters, calls, state, grants, runCommand };
}

function mutations(f) {
  return f.calls.filter(args => args[0] === "role");
}

test("Azure operator inspection is read-only and reports only redacted release evidence", async () => {
  const f = fixture();
  const report = await operateReleaseAzure(f);
  assert.equal(report.operation, "inspect");
  assert.equal(report.stack_state, "failed");
  assert.equal(report.deployments_stopped, true);
  assert.equal(report.budget_email_valid, true);
  assert.deepEqual(report.containers.map(item => item.assignments), oldIds.map(id => [{
    id, release_identity: true, blob_contributor: true, has_condition: false
  }]));
  assert.deepEqual(report.requested_assignments, newIds.map((id, index) => ({
    container: containers[index], id, state: "failed", code: "RoleAssignmentExists"
  })));
  assert.equal(mutations(f).length, 0);
  const output = JSON.stringify(report);
  assert.doesNotMatch(output, /private-|mailto:|subscriptions|principalId|roleDefinitionId/);
});

test("Azure operator detects the invalid budget mailto prefix without echoing its value", async () => {
  const f = fixture();
  f.parameters.budgetAlertEmail.value = "mailto:private-recipient@example.invalid";
  f.env.AZURE_PARAMETERS_JSON = JSON.stringify({ parameters: f.parameters });
  const report = await operateReleaseAzure(f);
  assert.equal(report.budget_email_valid, false);
  assert.doesNotMatch(JSON.stringify(report), /private-recipient/);
});

test("Azure operator replaces only the two approved container grants and is idempotent", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  const result = await operateReleaseAzure(f);
  assert.equal(result.status, "repaired");
  assert.equal(result.actor, "owner");
  assert.deepEqual(result.containers.map(item => item.status), ["replaced", "replaced"]);
  assert.deepEqual([...f.grants.keys()], newIds);
  assert.equal(mutations(f).length, 4);
  const again = await operateReleaseAzure(f);
  assert.deepEqual(again.containers.map(item => item.status), ["already_aligned", "already_aligned"]);
  assert.equal(mutations(f).length, 4);
});

test("Azure operator accepts native ARM assignment scopes without relying on CLI-flattened properties", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  for (const grant of f.grants.values()) {
    grant.properties.scope = grant.scope.toLowerCase();
    delete grant.scope;
  }
  assert.equal((await operateReleaseAzure(f)).status, "repaired");
});

for (const [label, change, code] of [
  ["wrong ref", f => { f.env.GITHUB_REF = "refs/heads/unreviewed"; }, "operator_main_required"],
  ["missing reason", f => { f.env.OPERATOR_REASON = ""; }, "operator_attribution_required"],
  ["missing confirmation", f => { f.env.PREVIOUS_MUTATION_STOPPED = "false"; }, "operator_stop_confirmation_required"],
  ["invalid IDs", f => { f.env.OPERATOR_NEW_CONTROL_ASSIGNMENT_ID = "not-a-guid"; }, "operator_assignment_ids_invalid"],
  ["wrong subscription", f => { f.state.wrongAccount = true; }, "operator_subscription_mismatch"],
  ["runtime storage", f => {
    f.parameters.storageAccountName.value = "syntheticrelease";
    f.env.AZURE_PARAMETERS_JSON = JSON.stringify({ parameters: f.parameters });
  }, "operator_configuration_invalid"],
  ["duplicate containers", f => { f.env.AZURE_ARTIFACT_CONTAINER = containers[0]; }, "operator_configuration_invalid"],
  ["active stack", f => { f.state.stackState = "Updating"; }, "operator_azure_work_not_stopped"],
  ["active deployment", f => { f.state.deploymentState = "Running"; }, "operator_azure_work_not_stopped"],
  ["unknown stack state", f => { f.state.stackState = "Unexpected"; }, "operator_azure_work_not_stopped"],
  ["wrong second principal", f => { f.grants.get(oldIds[1]).properties.principalId = "wrong"; }, "operator_assignment_mismatch"],
  ["conditional grant", f => { f.grants.get(oldIds[1]).properties.condition = "restricted"; }, "operator_assignment_mismatch"],
  ["both old and new grants", f => {
    f.grants.set(newIds[1], assignment(newIds[1], scopes[1]));
  }, "operator_assignment_mismatch"],
  ["unapproved grant", f => {
    f.grants.delete(oldIds[1]);
    f.grants.set("00000000-0000-0000-0000-000000000007",
      assignment("00000000-0000-0000-0000-000000000007", scopes[1]));
  }, "operator_assignment_mismatch"],
  ["partial role listing", f => { f.state.paginated = true; }, "operator_assignment_listing_incomplete"],
  ["unreadable roles", f => { f.state.grantReadFailure = true; }, "operator_azure_command_failed"]
]) {
  test(`Azure operator refuses ${label} before any mutation`, async () => {
    const f = fixture();
    f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
    change(f);
    await assert.rejects(operateReleaseAzure(f), { code });
    assert.equal(mutations(f).length, 0);
  });
}

test("Azure operator permits absent failed stack resources only after confirming deployments stopped", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.state.stacks = false;
  assert.equal((await operateReleaseAzure(f)).status, "repaired");
});

test("Azure operator refuses a replacement ID that is not requested by the failed deployment", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.env.OPERATOR_NEW_CONTROL_ASSIGNMENT_ID = "00000000-0000-0000-0000-000000000008";
  await assert.rejects(operateReleaseAzure(f), { code: "operator_requested_assignment_mismatch" });
  assert.equal(mutations(f).length, 0);
});

test("Azure operator rechecks stopped work between containers and resumes a partial repair safely", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  const runCommand = f.runCommand;
  f.runCommand = async (command, args, options) => {
    const result = await runCommand(command, args, options);
    if (args[0] === "role" && args[2] === "create" && args.includes(newIds[0])) {
      f.state.deploymentState = "Running";
    }
    return result;
  };
  await assert.rejects(operateReleaseAzure(f), { code: "operator_azure_work_not_stopped" });
  assert.deepEqual([...f.grants.keys()].sort(), [newIds[0], oldIds[1]].sort());
  f.state.deploymentState = "Failed";
  const result = await operateReleaseAzure(f);
  assert.deepEqual(result.containers.map(item => item.status), ["already_aligned", "replaced"]);
  assert.equal(mutations(f).length, 4);
});

test("Azure operator accepts a succeeded requested assignment when resuming a failed deployment's partial repair", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.grants.delete(oldIds[0]);
  f.grants.set(newIds[0], assignment(newIds[0], scopes[0]));
  f.state.controlOperationState = "Succeeded";
  const result = await operateReleaseAzure(f);
  assert.deepEqual(result.containers.map(item => item.status), ["already_aligned", "replaced"]);
  assert.equal(mutations(f).length, 2);
});

for (const failure of ["create", "delete"]) {
  test(`Azure operator restores and verifies the old grant after a ${failure} failure`, async () => {
    const f = fixture();
    f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
    f.state.mutationFailure = failure;
    await assert.rejects(operateReleaseAzure(f), {
      code: "operator_original_grant_restored",
      stage: failure === "create" ? "create_release-control_grant" : "delete_release-control_bootstrap_grant",
      azure_code: failure === "create" ? "RoleAssignmentExists" : "unclassified"
    });
    assert.deepEqual([...f.grants.keys()].sort(), [...oldIds].sort());
    assert.equal(mutations(f).filter(args => args.includes(scopes[1])).length, 0);
  });
}

test("Azure operator reconciles a successful create whose response was lost", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.state.mutationFailure = "create";
  f.state.appliedButFailed = true;
  assert.equal((await operateReleaseAzure(f)).status, "repaired");
  assert.deepEqual([...f.grants.keys()], newIds);
  assert.equal(mutations(f).length, 4);
});

test("Azure operator attempts and verifies restoration when reconciliation reads fail after mutation", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.state.mutationFailure = "create";
  f.state.postMutationReadFailures = 2;
  await assert.rejects(operateReleaseAzure(f), { code: "operator_original_grant_restored" });
  assert.deepEqual([...f.grants.keys()].sort(), [...oldIds].sort());
  assert.ok(mutations(f).some(args => args[2] === "create" && args.includes(oldIds[0])));
  assert.equal(mutations(f).filter(args => args.includes(scopes[1])).length, 0);
});

for (const mutationFailed of [false, true]) {
  test(`Azure operator reports uncertainty when ${mutationFailed ? "restoration" : "successful replacement"} cannot be read back`, async () => {
    const f = fixture();
    f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
    f.state.persistentPostMutationReadFailure = true;
    if (mutationFailed) f.state.mutationFailure = "create";
    await assert.rejects(operateReleaseAzure(f), {
      code: "operator_repair_state_uncertain",
      stage: "read_release_control_assignments",
      azure_code: "AuthorizationFailed"
    });
    assert.equal(mutations(f).filter(args => args.includes(scopes[1])).length, 0);
    if (mutationFailed) assert.ok(f.grants.has(oldIds[0]), "The original grant was not restored");
  });
}

test("Azure operator reconciles a lost create response plus transient read failures without claiming rollback", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.state.mutationFailure = "create";
  f.state.appliedButFailed = true;
  f.state.postMutationReadFailures = 2;
  assert.equal((await operateReleaseAzure(f)).status, "repaired");
  assert.deepEqual([...f.grants.keys()], newIds);
});

test("Azure operator reports failed restoration explicitly and never proceeds to the second grant", async () => {
  const f = fixture();
  f.env.OPERATOR_OPERATION = "repair-bootstrap-roles";
  f.state.mutationFailure = "create";
  f.state.rollbackFailure = true;
  await assert.rejects(operateReleaseAzure(f), { code: "operator_repair_state_uncertain" });
  assert.equal(mutations(f).filter(args => args.includes(scopes[1])).length, 0);
});

test("Azure operator errors identify the failed stage without disclosing raw diagnostics", async () => {
  const f = fixture();
  f.state.grantReadFailure = true;
  await assert.rejects(operateReleaseAzure(f), error => {
    assert.equal(error.code, "operator_azure_command_failed");
    assert.equal(error.stage, "read_release_control_assignments");
    assert.equal(error.azure_code, "AuthorizationFailed");
    assert.doesNotMatch(String(error), /private diagnostic/);
    return true;
  });
});

test("Azure operator CLI withholds private malformed configuration and fails explicitly", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../scripts/release-azure-operator.mjs", import.meta.url))
  ], {
    env: { ...process.env, GITHUB_REF: "refs/heads/main", OPERATOR_OPERATION: "inspect",
      AZURE_PARAMETERS_JSON: "private-malformed-configuration" },
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    status: "failed", code: "operator_configuration_invalid", stage: "configuration"
  });
});
