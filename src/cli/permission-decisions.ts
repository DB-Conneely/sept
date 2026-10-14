/** Local bounded operator decisions, separate from worker scheduling and the policy effect owner. */
import { join } from "node:path";
import {
  CapabilityPolicyStore,
  CapabilityRequestStore,
  RunStore,
  listRuns,
  WorkerLifecycleStore,
  SeptError,
  type CapabilityPolicy,
} from "../durable/index.js";
import {
  loadHandsConfiguration,
  validateDockerConfiguration,
  capabilityBinding,
} from "../execution/index.js";
import { assertCapabilityExpansion } from "./permissions.js";
import { wakeRunForOperator } from "../runtime/index.js";
import { CliError } from "./errors.js";
import type { CliInvocation } from "./options.js";
function permissionRequest(invocation: CliInvocation, requests: CapabilityRequestStore) {
  const selected = requests.read().find((entry) => entry.id === invocation.options.request);
  if (selected === undefined) {
    throw new SeptError("Exact permission request is absent");
  }
  if (invocation.options.digest !== selected.digest) {
    throw new SeptError("Permission decision requires the exact inspected --digest");
  }
  return selected;
}
/** Local installed decision interaction; HTTP and task text have no policy writer. */
export async function permissionDecision(
  invocation: CliInvocation,
  root: string,
  agentDir: string,
  policy: CapabilityPolicyStore,
  previous: CapabilityPolicy | undefined,
): Promise<unknown> {
  const requests = new CapabilityRequestStore(root);
  const inspection = inspectPermissions(invocation, requests);
  if (inspection !== undefined) {
    return inspection;
  }
  const selected = permissionRequest(invocation, requests);
  const run = new RunStore(join(root, selected.runId));
  if (run.snapshot().status !== "waiting") {
    throw new SeptError("Permission decisions require the still-waiting original run");
  }
  if (
    previous === undefined ||
    previous.denied ||
    previous.revision !== Number(invocation.options.revision)
  ) {
    throw new SeptError("Permission decision revision is stale or revoked");
  }
  return applyPermissionDecision(
    invocation,
    root,
    agentDir,
    policy,
    previous,
    requests,
    selected,
    run,
  );
}
function inspectPermissions(invocation: CliInvocation, requests: CapabilityRequestStore): unknown {
  if (invocation.action === "requests") {
    return requests.read().map((entry) => ({
      id: entry.id,
      runId: entry.runId,
      operation: entry.operation,
      digest: entry.digest,
      revision: entry.revision,
      binding: entry.binding,
      expiresAt: entry.expiresAt,
      decision: entry.decision,
    }));
  }
  if (invocation.action === "inspect") {
    const selected = requests.read().find((entry) => entry.id === invocation.options.request);
    if (selected === undefined) {
      throw new SeptError("Exact permission request is absent");
    }
    return selected;
  }
  return undefined;
}
async function applyPermissionDecision(
  invocation: CliInvocation,
  root: string,
  agentDir: string,
  policy: CapabilityPolicyStore,
  previous: CapabilityPolicy,
  requests: CapabilityRequestStore,
  selected: import("../durable/index.js").CapabilityRequest,
  run: RunStore,
): Promise<unknown> {
  if (invocation.action === "deny") {
    return requests.decide(selected.id, selected.digest, {
      status: "denied",
      revision: previous.revision,
      binding: previous.binding,
      expiresAt: selected.expiresAt,
    });
  }
  return approvePermission(invocation, root, agentDir, policy, previous, requests, selected, run);
}
async function approvePermission(
  invocation: CliInvocation,
  root: string,
  agentDir: string,
  policy: CapabilityPolicyStore,
  previous: CapabilityPolicy,
  requests: CapabilityRequestStore,
  selected: import("../durable/index.js").CapabilityRequest,
  run: RunStore,
): Promise<unknown> {
  const seconds = approvalSeconds(invocation.options.expires);
  const configuration = loadHandsConfiguration(
    invocation.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
  );
  await validateDockerConfiguration(
    configuration,
    [agentDir, root],
    run.manifest().workspace,
    undefined,
    { policyPath: policy.path, initialize: false },
  );
  const binding = capabilityBinding(configuration);
  if (duplicateApproval(selected, previous, binding)) {
    return selected;
  }
  await assertCapabilityExpansion(previous, previous, true, root, binding, configuration);
  // Policy activation first: a crash before the exact decision leaves no usable grant.
  if (run.snapshot().status !== "waiting") {
    throw new SeptError("Original request was cancelled before approval activation");
  }
  const activated = policy.activate(previous, binding, previous.revision);
  if (run.snapshot().status !== "waiting") {
    throw new SeptError("Original request was cancelled before its decision became active");
  }
  return requests.decide(selected.id, selected.digest, {
    status: "approved",
    revision: activated.revision,
    binding: activated.binding,
    expiresAt: Math.min(selected.expiresAt, Date.now() + seconds * 1000),
  });
}

function approvalSeconds(value: string | undefined): number {
  const seconds = Number(value ?? "300");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new SeptError("Approval expiry must be between 1 and 3600 seconds");
  }
  return seconds;
}
function duplicateApproval(
  selected: import("../durable/index.js").CapabilityRequest,
  previous: CapabilityPolicy,
  binding: import("../durable/index.js").CapabilityBinding,
): boolean {
  if (selected.decision !== undefined) {
    if (
      selected.decision.status !== "approved" ||
      JSON.stringify(selected.decision.binding) !== JSON.stringify(binding) ||
      selected.decision.revision !== previous.revision
    ) {
      throw new SeptError("Permission decision conflicts with its durable predecessor");
    }
    return true;
  }
  if (
    previous.mode !== "request_approval" ||
    previous.revision !== selected.revision ||
    JSON.stringify(previous.binding) !== JSON.stringify(selected.binding)
  ) {
    throw new SeptError("Permission source namespace or revision changed; request again");
  }
  return false;
}

/** Installed direct explicit retry shares accepted input/wake and never resets original limits. */
export async function resumePermissionRun(
  context: CliInvocation,
  root: string,
  agentDir: string,
): Promise<RunStore | undefined> {
  const id = context.options.resume;
  if (id === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || context.options.message === undefined) {
    throw new CliError("run --resume requires an exact run identity and --message");
  }
  const allowed = ["resume", "message", "state-dir", "agent-dir", "hands"];
  if (Object.keys(context.options).some((key) => !allowed.includes(key))) {
    throw new CliError("Resuming preserves the original task, model and limits");
  }
  const store = new RunStore(join(root, id));
  if (store.snapshot().status !== "waiting" || store.snapshot().permissionRequestId === undefined) {
    throw new CliError("Explicit local permission retry requires its still-waiting original run");
  }
  await validateRetryConfiguration(context, root, agentDir, store);
  const message = store.enqueueMessage(context.options.message);
  wakeRunForOperator(store, message.id);
  return store;
}

async function validateRetryConfiguration(
  context: CliInvocation,
  root: string,
  agentDir: string,
  store: RunStore,
): Promise<void> {
  const configuration = loadHandsConfiguration(
    context.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
  );
  const policy = new CapabilityPolicyStore(root);
  await validateDockerConfiguration(
    configuration,
    [agentDir, root],
    store.manifest().workspace,
    undefined,
    { policyPath: policy.path, initialize: false },
  );
  const current = policy.read();
  if (
    current === undefined ||
    current.denied ||
    JSON.stringify(current.binding) !== JSON.stringify(capabilityBinding(configuration))
  ) {
    throw new CliError("Explicit retry requires its current validated capability binding");
  }
}

/** Local direct admission keeps drained state and every other resident run outside the selected retry. */
export function assertLocalRunSlot(root: string, selectedRunId?: string): void {
  if (new WorkerLifecycleStore(root).read().readiness !== "accepting") {
    throw new SeptError("worker state root is drained and not accepting new work");
  }
  const busy = listRuns(root).some((store) => {
    const status = store.snapshot().status;
    return (
      store.runId !== selectedRunId &&
      (status === "active" || status === "waiting" || status === "cancelling")
    );
  });
  if (busy) {
    throw new SeptError("single worker slot is busy");
  }
}
