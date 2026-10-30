import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const guidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const blobContributor = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const terminalStates = new Set(["succeeded", "failed", "canceled", "cancelled"]);
const knownStates = new Set([...terminalStates, "running", "accepted", "creating", "updating", "deleting"]);
const azureCodes = ["AuthorizationFailed", "RoleAssignmentExists", "RoleAssignmentNotFound",
  "ResourceNotFound", "DeploymentStackNotFound", "InvalidTemplateDeployment", "DeploymentFailed"];

class OperatorFailure extends Error {
  constructor(code, stage, azureCode) {
    super(code);
    this.code = code;
    this.stage = stage;
    this.azure_code = azureCode;
  }
}

function fail(code, stage) {
  throw new OperatorFailure(code, stage);
}

function same(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function stateOf(value) {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  return knownStates.has(state) ? state : "unknown";
}

export async function operateReleaseAzure({ env = process.env, runCommand = execFileAsync } = {}) {
  if (env.GITHUB_REF !== "refs/heads/main") fail("operator_main_required", "configuration");
  const operation = env.OPERATOR_OPERATION;
  if (!["inspect", "repair-bootstrap-roles"].includes(operation)) fail("operator_operation_invalid", "configuration");
  const repairing = operation === "repair-bootstrap-roles";
  if (repairing && (!env.GITHUB_ACTOR || !env.OPERATOR_REASON?.trim() ||
    env.OPERATOR_REASON.length > 500 || /[\x00-\x1f\x7f]/.test(env.OPERATOR_REASON))) {
    fail("operator_attribution_required", "configuration");
  }
  if (repairing && env.PREVIOUS_MUTATION_STOPPED !== "true") {
    fail("operator_stop_confirmation_required", "configuration");
  }
  let parameters;
  try {
    parameters = JSON.parse(env.AZURE_PARAMETERS_JSON).parameters;
  } catch {
    fail("operator_configuration_invalid", "configuration");
  }
  const subscription = env.AZURE_SUBSCRIPTION_ID;
  const group = env.AZURE_RESOURCE_GROUP_NAME;
  const account = env.AZURE_STORAGE_ACCOUNT;
  const principal = parameters?.releaseControllerPrincipalId?.value;
  const containers = [env.AZURE_RELEASE_CONTAINER, env.AZURE_ARTIFACT_CONTAINER];
  if (!guidPattern.test(subscription ?? "") || !guidPattern.test(principal ?? "") ||
    !/^[A-Za-z0-9_.()-]{1,90}$/.test(group ?? "") || !/^[a-z0-9]{3,24}$/.test(account ?? "") ||
    containers.some(name => !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(name ?? "")) ||
    containers[0] === containers[1] ||
    parameters.resourceGroupName?.value !== group ||
    parameters.releaseStorageAccountName?.value !== account ||
    typeof parameters.storageAccountName?.value !== "string" ||
    same(parameters.storageAccountName.value, account) ||
    parameters.releaseControlContainerName?.value !== containers[0] ||
    parameters.releaseArtifactContainerName?.value !== containers[1]) {
    fail("operator_configuration_invalid", "configuration");
  }
  const pairs = [
    { old: env.OPERATOR_OLD_CONTROL_ASSIGNMENT_ID, next: env.OPERATOR_NEW_CONTROL_ASSIGNMENT_ID },
    { old: env.OPERATOR_OLD_ARTIFACT_ASSIGNMENT_ID, next: env.OPERATOR_NEW_ARTIFACT_ASSIGNMENT_ID }
  ];
  const ids = pairs.flatMap(pair => [pair.old, pair.next]);
  if (repairing && (ids.some(id => !guidPattern.test(id ?? "")) ||
    new Set(ids.map(id => id.toLowerCase())).size !== 4)) {
    fail("operator_assignment_ids_invalid", "configuration");
  }
  const toolEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "LANG", "LC_ALL",
    "AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR", "SystemRoot"]) {
    if (env[key] !== undefined) toolEnv[key] = env[key];
  }
  const azure = async (args, stage) => {
    let stdout;
    try {
      ({ stdout } = await runCommand("az", [...args, "--output", "json", "--only-show-errors"], {
        env: toolEnv, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024
      }));
    } catch (error) {
      const code = azureCodes.find(value => new RegExp(`\\b${value}\\b`).test(error.stderr ?? ""));
      throw new OperatorFailure("operator_azure_command_failed", stage, code ?? "unclassified");
    }
    if (!stdout.trim()) return null;
    try {
      return JSON.parse(stdout);
    } catch {
      fail("operator_azure_response_invalid", stage);
    }
  };
  const actualSubscription = await azure(["account", "show", "--query", "id"], "read_subscription");
  if (!same(actualSubscription, subscription)) fail("operator_subscription_mismatch", "read_subscription");
  const storageScope = `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.Storage/storageAccounts/${account}`;
  const storage = await azure(["storage", "account", "show", "--subscription", subscription,
    "--resource-group", group, "--name", account, "--query", "{id:id}"], "read_release_storage");
  if (!same(storage?.id, storageScope)) fail("operator_storage_mismatch", "read_release_storage");
  const scopes = containers.map(name => `${storageScope}/blobServices/default/containers/${name}`);
  const readWork = async () => {
    const stacks = await azure(["stack", "group", "list", "--subscription", subscription,
      "--resource-group", group], "read_release_stacks");
    const deployments = await azure(["deployment", "group", "list", "--subscription", subscription,
      "--resource-group", group, "--query", "[].{name:name,properties:{provisioningState:properties.provisioningState,timestamp:properties.timestamp}}"],
    "read_group_deployments");
    if (!Array.isArray(stacks) || !Array.isArray(deployments)) {
      fail("operator_azure_response_invalid", "read_work_state");
    }
    const matches = stacks.filter(stack => stack.name === "trmnl-calendar-managed");
    if (matches.length > 1) fail("operator_azure_response_invalid", "read_release_stacks");
    const stackState = matches.length
      ? stateOf(matches[0].provisioningState ?? matches[0].properties?.provisioningState) : "absent";
    return {
      stackState, deployments,
      stopped: (stackState === "absent" || terminalStates.has(stackState)) &&
        deployments.length > 0 && deployments.every(item => terminalStates.has(stateOf(item.properties?.provisioningState)))
    };
  };
  const work = await readWork();
  const requested = [];
  const failed = work.deployments.filter(item => same(item.properties?.provisioningState, "Failed"))
    .sort((a, b) => String(b.properties?.timestamp).localeCompare(String(a.properties?.timestamp)))[0];
  if (failed) {
    if (!/^[A-Za-z0-9_.()-]{1,64}$/.test(failed.name ?? "")) {
      fail("operator_azure_response_invalid", "read_failed_operations");
    }
    const operations = await azure(["deployment", "operation", "group", "list", "--subscription", subscription,
      "--resource-group", group, "--name", failed.name,
      "--query", "[].{state:properties.provisioningState,type:properties.targetResource.resourceType,id:properties.targetResource.id,code:properties.statusMessage.error.code}"],
    "read_failed_operations");
    if (!Array.isArray(operations)) fail("operator_azure_response_invalid", "read_failed_operations");
    for (const item of operations) {
      if (item.type !== "Microsoft.Authorization/roleAssignments" ||
        typeof item.id !== "string") continue;
      const index = scopes.findIndex(scope => same(item.id.slice(0, item.id.lastIndexOf("/providers/")), scope));
      const id = item.id.split("/").at(-1);
      if (index >= 0 && guidPattern.test(id)) {
        requested.push({
          container: containers[index], id, state: stateOf(item.state),
          code: item.state === "Succeeded" ? null : azureCodes.includes(item.code) ? item.code : "unclassified"
        });
      }
    }
  }
  const readAssignments = async index => {
    const stage = index === 0 ? "read_release_control_assignments" : "read_release_artifact_assignments";
    const result = await azure(["rest", "--method", "get", "--url",
      `https://management.azure.com${scopes[index]}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`], stage);
    if (!Array.isArray(result?.value)) fail("operator_azure_response_invalid", stage);
    if (result.nextLink) fail("operator_assignment_listing_incomplete", stage);
    return result.value.filter(item => same(item.properties?.principalId, principal) || (
      guidPattern.test(item.name ?? "") && [pairs[index].old, pairs[index].next].some(id => same(id, item.name))
    )).filter(item => same(item.scope ?? item.properties?.scope ??
      item.id?.slice(0, item.id.lastIndexOf("/providers/")), scopes[index]));
  };
  const isExact = (item, index, id) => same(item?.name, id) &&
    same(item.id, `${scopes[index]}/providers/Microsoft.Authorization/roleAssignments/${id}`) &&
    same(item.properties?.principalId, principal) &&
    same(item.properties?.roleDefinitionId, `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${blobContributor}`) &&
    item.properties?.principalType === "ServicePrincipal" &&
    !item.properties?.condition;
  const onlyGrant = (items, index, id) => {
    const relevant = items.filter(item => same(item.name, pairs[index].old) ||
      same(item.name, pairs[index].next) ||
      same(item.properties?.roleDefinitionId?.split("/").at(-1), blobContributor));
    return relevant.length === 1 && isExact(relevant[0], index, id);
  };
  const observeAfterMutation = async index => {
    let failure;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return { items: await readAssignments(index) };
      } catch (error) {
        failure = error;
      }
    }
    return { failure };
  };
  const uncertain = (observed, stage) => {
    throw new OperatorFailure("operator_repair_state_uncertain",
      observed.failure?.stage ?? stage, observed.failure?.azure_code);
  };
  const grants = await Promise.all(containers.map((_name, index) => readAssignments(index)));
  if (!repairing) {
    const email = parameters.budgetAlertEmail?.value;
    return {
      operation, stack_state: work.stackState, deployments_stopped: work.stopped,
      budget_email_valid: typeof email === "string" && /^[^@\s<>:,]+@[^@\s<>:,]+\.[^@\s<>:,]+$/.test(email),
      requested_assignments: requested,
      containers: containers.map((container, index) => ({
        container,
        assignments: grants[index].map(item => ({
          id: guidPattern.test(item.name ?? "") ? item.name : "unknown",
          release_identity: same(item.properties?.principalId, principal),
          blob_contributor: same(item.properties?.roleDefinitionId?.split("/").at(-1), blobContributor),
          has_condition: Boolean(item.properties?.condition)
        }))
      }))
    };
  }
  if (!work.stopped) fail("operator_azure_work_not_stopped", "repair_preflight");
  for (let index = 0; index < containers.length; index += 1) {
    if (![pairs[index].old, pairs[index].next].some(id => onlyGrant(grants[index], index, id))) {
      fail("operator_assignment_mismatch", "repair_preflight");
    }
    if (!requested.some(item => item.container === containers[index] && same(item.id, pairs[index].next))) {
      fail("operator_requested_assignment_mismatch", "repair_preflight");
    }
  }
  const results = [];
  for (let index = 0; index < containers.length; index += 1) {
    const pair = pairs[index];
    if (onlyGrant(grants[index], index, pair.next)) {
      results.push({ container: containers[index], status: "already_aligned" });
      continue;
    }
    if (!(await readWork()).stopped) fail("operator_azure_work_not_stopped", "repair_preflight");
    const current = await readAssignments(index);
    if (!onlyGrant(current, index, pair.old)) {
      fail("operator_assignment_mismatch", "repair_preflight");
    }
    const create = id => azure(["role", "assignment", "create", "--subscription", subscription,
      "--assignee-object-id", principal, "--assignee-principal-type", "ServicePrincipal",
      "--role", blobContributor, "--scope", scopes[index], "--name", id], `create_${containers[index]}_grant`);
    try {
      await azure(["role", "assignment", "delete", "--ids",
        `${scopes[index]}/providers/Microsoft.Authorization/roleAssignments/${pair.old}`], `delete_${containers[index]}_bootstrap_grant`);
      await create(pair.next);
    } catch (error) {
      const observed = await observeAfterMutation(index);
      if (observed.failure || !onlyGrant(observed.items, index, pair.next)) {
        if (observed.failure || !onlyGrant(observed.items, index, pair.old)) {
          try {
            await create(pair.old);
          } catch {
            // Either approved ID may already exist; resolve the result through readback.
          }
        }
        const restored = await observeAfterMutation(index);
        if (restored.failure) uncertain(restored, `restore_${containers[index]}_grant`);
        if (onlyGrant(restored.items, index, pair.old)) {
          throw new OperatorFailure("operator_original_grant_restored", error.stage, error.azure_code);
        }
        if (!onlyGrant(restored.items, index, pair.next)) {
          uncertain(restored, `restore_${containers[index]}_grant`);
        }
      }
    }
    const verified = await observeAfterMutation(index);
    if (verified.failure || !onlyGrant(verified.items, index, pair.next)) {
      uncertain(verified, `verify_${containers[index]}_grant`);
    }
    results.push({ container: containers[index], status: "replaced" });
  }
  return { operation, status: "repaired", actor: env.GITHUB_ACTOR, containers: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await operateReleaseAzure()));
  } catch (error) {
    console.error(JSON.stringify(error instanceof OperatorFailure
      ? { status: "failed", code: error.code, stage: error.stage, azure_code: error.azure_code }
      : { status: "failed", code: "operator_unexpected_failure" }));
    process.exitCode = 1;
  }
}
