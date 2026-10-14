/** Local operator policy commands never enter the ordinary HTTP/task/model control surface. */
import { existsSync, mkdirSync, readFileSync, statSync, opendirSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilityPolicyStore,
  CapabilityPolicyDeniedError,
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
  DockerExecutionBackend,
  initializeCapabilityEngine,
  validateDockerConfiguration,
  revokeDockerBinding,
  reconcileDockerBinding,
  loadHandsConfiguration,
  validateCapabilities,
  type DockerHandsConfiguration,
} from "../execution/index.js";
import { PiSessionHost } from "../pi-integration/index.js";
import type { HostFactory } from "../runtime/index.js";
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
  const denied = store.revoke(expected);
  const configuration = loadHandsConfiguration(
    invocation.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
  );
  if (JSON.stringify(denied.binding) !== JSON.stringify(capabilityBinding(configuration))) {
    throw new SeptError("Revocation configuration does not match persisted capability authority");
  }
  await revokeDockerBinding(denied.binding, configuration, { policyPath: store.path });
  return { revision: denied.revision, denied: true, stopped: true };
}

function newStateRoot(root: string): boolean {
  if (!existsSync(root)) {
    return true;
  }
  const directory = opendirSync(root);
  try {
    return directory.readSync() === null;
  } finally {
    directory.closeSync();
  }
}

/** New supplied state gets safe default; unreadable old policy stays dormant and is never replaced. */
export async function initializeCapabilities(
  options: Record<string, string>,
  root: string,
): Promise<CapabilityPolicyStore> {
  const store = new CapabilityPolicyStore(root);
  try {
    if (store.read() !== undefined || !newStateRoot(root)) {
      return store;
    }
  } catch {
    return store;
  }
  const path = options.hands ?? process.env.SEPT_HANDS_CONFIGURATION;
  if (path !== undefined) {
    try {
      const configuration = loadHandsConfiguration(path);
      await initializeCapabilityEngine(configuration, store.path);
      store.initialize(defaultCapabilities(), capabilityBinding(configuration));
    } catch {
      // Missing Engine authority leaves scheduling dormant; authenticated health/history still bind.
      return store;
    }
  }
  return store;
}

/** Installed admission reads live operator authority; missing/denied state cannot schedule native work. */
export function assertCapabilityAdmission(store: CapabilityPolicyStore): void {
  const policy = store.read();
  if (policy === undefined || policy.denied) {
    throw new CapabilityPolicyDeniedError(
      "Operator capability configuration is required before execution",
    );
  }
}

/** Worker/direct composition binds the same private policy to the installed effect owner. */
export function capabilityHostFactory(
  root: string,
  configurationPath: string | undefined,
  controlEndpoint?: () => { address: string; port: number } | undefined,
): HostFactory {
  return async (manifest, store, agentDir, existing, telemetry) => {
    const configuration = loadHandsConfiguration(configurationPath);
    const backend = await DockerExecutionBackend.create(
      configuration,
      store,
      [agentDir, root],
      new CapabilityPolicyStore(root),
      controlEndpoint?.(),
    );
    return PiSessionHost.create(manifest, store, agentDir, existing, telemetry, {
      executionBackend: backend,
    });
  };
}
