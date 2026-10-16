/** Local operator policy commands never enter the ordinary HTTP/task/model control surface. */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilityPolicyStore,
  acquireStateRootLease,
  parseCapabilityConfiguration,
  SeptError,
  type CapabilityConfiguration,
  type CapabilityPolicy,
} from "../durable/index.js";
import {
  capabilityBinding,
  capabilityGrants,
  defaultCapabilities,
  validateDockerConfiguration,
  revokeDockerBinding,
  reconcileDockerBinding,
  loadHandsConfiguration,
  validateCapabilities,
  type DockerHandsConfiguration,
} from "../execution/index.js";
import { permissionDecision } from "./permission-decisions.js";
import type { CliInvocation } from "./options.js";

function localConfiguration(path: string | undefined): CapabilityConfiguration {
  if (path === undefined || statSync(path).size > 16 * 1024) {
    throw new SeptError("permissions set requires bounded --policy input");
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseCapabilityConfiguration(value);
  } catch (error: unknown) {
    throw new SeptError("Capability configuration is malformed", { cause: error });
  }
}
function expands(previous: CapabilityPolicy, next: CapabilityConfiguration): boolean {
  if (
    previous.denied ||
    (next.execute && !previous.execute) ||
    (next.network && !previous.network)
  ) {
    return true;
  }
  const grants = capabilityGrants(previous);
  return capabilityGrants(next).some((entry) => {
    const before = grants.find((grant) => grant.root === entry.root);
    return (entry.read && before?.read !== true) || (entry.write && before?.write !== true);
  });
}
function revision(options: Record<string, string>): number {
  const value = Number(options.revision);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SeptError("permissions mutation requires --revision from permissions show");
  }
  return value;
}
function inputConfiguration(
  invocation: CliInvocation,
  configuration: DockerHandsConfiguration,
): CapabilityConfiguration {
  if (invocation.options.policy !== undefined) {
    if (invocation.options.mode !== undefined) {
      throw new SeptError("Choose --policy or --mode, not both");
    }
    return localConfiguration(invocation.options.policy);
  }
  if (invocation.options.mode === "request_approval") {
    return { ...defaultCapabilities(), mode: "request_approval" };
  }
  if (invocation.options.mode === "scoped") {
    return defaultCapabilities();
  }
  if (invocation.options.mode === "full_access") {
    return { ...defaultCapabilities(), mode: "full_access", execute: configuration.shell };
  }
  return localConfiguration(undefined);
}

/** Validate exclusive old ownership and a truly fresh target before expanding or rebinding authority. */
export async function assertCapabilityExpansion(
  previous: CapabilityPolicy,
  effective: CapabilityConfiguration,
  changed: boolean,
  root: string,
  next: import("../durable/index.js").CapabilityBinding,
  configuration: DockerHandsConfiguration,
): Promise<void> {
  if (!changed && !expands(previous, effective)) {
    return;
  }
  const leaseRoot = join(root, ".hands-leases", previous.binding.containerId);
  const fresh =
    previous.binding.containerId !== next.containerId ||
    previous.binding.generation !== next.generation;
  if (!fresh) {
    throw new SeptError("Expansion requires quiescence and a fresh validated backend generation");
  }
  const release = acquireStateRootLease(leaseRoot);
  try {
    await reconcileDockerBinding(previous.binding, configuration, {
      policyPath: join(root, "capability-policy.json"),
    });
  } finally {
    release();
  }
}

async function setPermissions(
  invocation: CliInvocation,
  root: string,
  agentDir: string,
  store: CapabilityPolicyStore,
  previous: CapabilityPolicy | undefined,
): Promise<unknown> {
  const configuration = loadHandsConfiguration(
    invocation.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
  );
  const effective = validateCapabilities(
    inputConfiguration(invocation, configuration),
    configuration,
  );
  await validateDockerConfiguration(configuration, [agentDir, root], undefined, undefined, {
    policyPath: store.path,
    initialize: previous === undefined,
  });
  const binding = capabilityBinding(configuration);
  const changed =
    previous !== undefined && JSON.stringify(previous.binding) !== JSON.stringify(binding);
  if (previous !== undefined) {
    await assertCapabilityExpansion(previous, effective, changed, root, binding, configuration);
  }
  const activated = store.activate(effective, binding, revision(invocation.options));
  if (previous !== undefined && !changed) {
    await revokeDockerBinding(previous.binding, configuration, { policyPath: store.path });
  }
  return {
    revision: activated.revision,
    denied: false,
    mode: activated.mode,
    freshBackendRequired: previous !== undefined && !changed,
  };
}

/** Installed operator writer: validate first, persist narrow/deny, then stop and verify old effects. */
export async function runPermissions(
  invocation: CliInvocation,
  root: string,
  agentDir: string,
): Promise<unknown> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = new CapabilityPolicyStore(root);
  const previous = store.read();
  if (["requests", "inspect", "approve", "deny"].includes(invocation.action ?? "")) {
    return permissionDecision(invocation, root, agentDir, store, previous);
  }
  if (invocation.action === "show") {
    return (
      previous ?? {
        version: 1,
        revision: 0,
        denied: true,
        reason: "operator configuration required",
      }
    );
  }
  const expected = revision(invocation.options);
  if ((previous?.revision ?? 0) !== expected) {
    throw new SeptError("Capability revision changed; inspect and retry");
  }
  if (invocation.action === "revoke") {
    return revokePermissions(invocation, store, expected);
  }
  if (invocation.action !== "set") {
    throw new SeptError("Usage: sept permissions show|set|revoke --state-dir <path>");
  }
  return setPermissions(invocation, root, agentDir, store, previous);
}

async function revokePermissions(
  invocation: CliInvocation,
  store: CapabilityPolicyStore,
  expected: number,
): Promise<unknown> {
  const configuration = loadHandsConfiguration(
    invocation.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
  );
  const previous = store.read();
  if (
    previous === undefined ||
    JSON.stringify(previous.binding) !== JSON.stringify(capabilityBinding(configuration))
  ) {
    throw new SeptError("Revocation configuration does not match persisted capability authority");
  }
  // Incompatible cold configuration cannot mutate records; valid revocation still denies before stop.
  const denied = store.revoke(expected);
  await revokeDockerBinding(denied.binding, configuration, { policyPath: store.path });
  return { revision: denied.revision, denied: true, stopped: true };
}
