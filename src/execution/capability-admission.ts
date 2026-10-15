/** Maps operator policy onto supplied namespace rights; no task field can select authority. */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { posix } from "node:path";
import {
  SeptError,
  type CapabilityBinding,
  type CapabilityConfiguration,
  type CapabilityGrant,
  type CapabilityPolicy,
  type CapabilityPolicyStore,
} from "../durable/index.js";
import { engineSocketIdentity } from "./profile-configuration.js";
import type { CodingToolName, DockerHandsConfiguration, HandsRequest } from "./contracts.js";

/** Bind exact supplied roots as well as namespace generation; root replacement invalidates authority. */
export function capabilityBinding(configuration: DockerHandsConfiguration): CapabilityBinding {
  try {
    const sources = [
      configuration.workspace,
      configuration.resources,
      ...configuration.readOnlyMounts.map((entry) => entry.source),
      ...(configuration.readWriteMounts ?? []).map((entry) => entry.source),
    ];
    const identities = sources.map((source) => {
      const stat = statSync(source);
      return { source, device: stat.dev, inode: stat.ino };
    });
    return {
      containerId: configuration.containerId,
      generation: configuration.generation,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            configuration: { ...configuration, imageSelected: configuration.imageSelected ?? [] },
            identities,
            engineSocket: engineSocketIdentity(configuration.engineSocket),
          }),
        )
        .digest("hex"),
    };
  } catch (error: unknown) {
    throw new SeptError("Supplied capability binding is unavailable", { cause: error });
  }
}
/** Safe file-only new-state authority omits commands and every selected host mount. */
export function defaultCapabilities(): CapabilityConfiguration {
  return {
    mode: "scoped",
    workspace: { read: true, write: true },
    selected: [],
    execute: false,
    network: false,
  };
}
function suppliedMounts(configuration: DockerHandsConfiguration) {
  return [
    ...configuration.readOnlyMounts.map((entry) => ({ ...entry, writable: false })),
    ...(configuration.readWriteMounts ?? []).map((entry) => ({ ...entry, writable: true })),
    ...(configuration.imageSelected ?? []).map((entry) => ({
      destination: `/selected/${entry.alias}`,
      writable: false,
    })),
  ];
}
function assertExecution(
  effective: CapabilityConfiguration,
  configuration: DockerHandsConfiguration,
  mounts: ReturnType<typeof suppliedMounts>,
): void {
  if (effective.execute) {
    const allRead = mounts.every((mount) =>
      effective.selected.some((entry) => entry.root === mount.destination && entry.read),
    );
    if (
      configuration.dataDomain !== "private" ||
      !configuration.shell ||
      !effective.workspace.read ||
      !effective.workspace.write ||
      !allRead ||
      mounts.some((entry) => entry.writable)
    ) {
      throw new SeptError(
        "Arbitrary execution requires bounded RW workspace and all selected mounts read-only/readable",
      );
    }
  }
}
function namespaceReadable(
  policy: CapabilityConfiguration,
  configuration: DockerHandsConfiguration | undefined,
): boolean {
  if (configuration?.dataDomain === "mutable-file-bind") {
    return false;
  }
  const mounted =
    configuration === undefined
      ? policy.selected.map((entry) => ({ destination: entry.root }))
      : suppliedMounts(configuration);
  return (
    policy.workspace.read &&
    mounted.every((mount) =>
      policy.selected.some((entry) => entry.root === mount.destination && entry.read),
    )
  );
}

/** Full covers only the supplied domain. Network remains a separately selected operator right. */
export function validateCapabilities(
  input: CapabilityConfiguration,
  configuration: DockerHandsConfiguration,
): CapabilityConfiguration {
  if (input.network && configuration.network === undefined) {
    throw new SeptError("Network grant requires a supplied enforced network namespace");
  }
  const mounts = suppliedMounts(configuration);
  const effective =
    input.mode === "full_access"
      ? {
          ...input,
          workspace: { read: true, write: true },
          selected: mounts.map((entry) => ({
            root: entry.destination,
            read: true,
            write: entry.writable,
          })),
        }
      : input;
  for (const selected of effective.selected) {
    const mount = mounts.find((entry) => entry.destination === selected.root);
    if (mount === undefined || (selected.write && !mount.writable)) {
      throw new SeptError("Capability grant differs from supplied kernel mounts");
    }
  }
  assertExecution(effective, configuration, mounts);
  return effective;
}
/** Read the effective roots, including only trusted projected resources and private scratch. */
export function capabilityGrants(policy: CapabilityConfiguration): CapabilityGrant[] {
  return [
    { root: "/workspace", ...policy.workspace },
    ...policy.selected,
    { root: "/resources", read: true, write: false },
    { root: "/tmp", read: true, write: true },
  ];
}
/** Construct the advertised tools from independent rights; live effect checks remain authoritative. */
function scopedCapabilityTools(
  policy: CapabilityConfiguration,
  configuration?: DockerHandsConfiguration,
): CodingToolName[] {
  const read = policy.workspace.read || policy.selected.some((entry) => entry.read);
  const write = policy.workspace.write || policy.selected.some((entry) => entry.write);
  return [
    ...(read ? (["read"] as const) : ([] as const)),
    ...(namespaceReadable(policy, configuration)
      ? (["grep", "find", "ls"] as const)
      : ([] as const)),
    ...(write ? (["write"] as const) : []),
    ...((policy.workspace.read && policy.workspace.write) ||
    policy.selected.some((entry) => entry.read && entry.write)
      ? (["edit"] as const)
      : []),
    ...(policy.execute ? (["bash"] as const) : []),
  ];
}
/** Requests advertise supported bodies so native Pi can request missing rights explicitly. */
export function capabilityTools(
  policy: CapabilityConfiguration,
  configuration?: DockerHandsConfiguration,
): CodingToolName[] {
  if (policy.mode !== "request_approval") {
    return scopedCapabilityTools(policy, configuration);
  }
  return [
    "read",
    "write",
    "edit",
    ...(configuration?.dataDomain === "mutable-file-bind" ? [] : (["grep", "find", "ls"] as const)),
    ...(configuration?.shell ? (["bash"] as const) : []),
  ];
}

/** Initial, queued and replayed requests all recheck the same live revision immediately before effects. */
export function admitCapabilityRequest(
  policy: CapabilityPolicy,
  request: HandsRequest,
  cwd: string,
  configuration?: DockerHandsConfiguration,
): HandsRequest {
  if (policy.denied) {
    throw new SeptError("Capability authority was revoked");
  }
  const grants = capabilityGrants(policy);
  if (request.kind === "resources") {
    return {
      ...request,
      workspaceRead: namespaceReadable(policy, configuration),
      grants,
    };
  }
  if ((request.kind === "tool" && request.name === "bash") || request.kind === "custom") {
    if (!policy.execute) {
      throw new SeptError("Shell capability is absent");
    }
    return admitExecutionRequest(policy, request, grants);
  }
  assertPathRights(request, cwd, grants);
  if (
    request.kind === "tool" &&
    ["grep", "find", "ls"].includes(request.name) &&
    !namespaceReadable(policy, configuration)
  ) {
    throw new SeptError("Search requires a fully readable supplied namespace");
  }
  return { ...request, grants };
}

function assertPathRights(
  request: Exclude<HandsRequest, { kind: "resources" }>,
  cwd: string,
  grants: CapabilityGrant[],
): void {
  if (request.kind === "custom") {
    return;
  }
  const path = request.kind === "file" ? request.path : (request.arguments.path ?? ".");
  if (typeof path !== "string") {
    throw new SeptError("Capability path must be text");
  }
  const absolute = posix.resolve(cwd, path);
  const selected = grants.find(
    (entry) => absolute === entry.root || absolute.startsWith(`${entry.root}/`),
  );
  const { writing, reading } = requiredRights(request);
  if (selected === undefined || (writing && !selected.write) || (reading && !selected.read)) {
    throw new SeptError("Capability rights deny this operation");
  }
}

function requiredRights(request: Exclude<HandsRequest, { kind: "resources" }>): {
  writing: boolean;
  reading: boolean;
} {
  if (request.kind === "custom") {
    return { writing: true, reading: true };
  }
  if (request.kind === "file") {
    return { writing: request.method === "writeFile", reading: request.method === "readTextFile" };
  }
  return { writing: ["write", "edit"].includes(request.name), reading: request.name !== "write" };
}

/** Translate an exact approved call only; no ambient policy or later call gains these rights. */
export function admitApprovedCapabilityRequest(
  policy: CapabilityPolicy,
  request: HandsRequest,
  cwd: string,
  configuration: DockerHandsConfiguration,
): HandsRequest {
  const effective = validateCapabilities(
    {
      ...policy,
      mode: "full_access",
      execute: (request.kind === "tool" && request.name === "bash") || request.kind === "custom",
      network:
        (request.kind === "tool" || request.kind === "custom") &&
        request.arguments.network === true,
    },
    configuration,
  );
  return admitCapabilityRequest(
    { ...policy, ...effective, mode: "request_approval" },
    request,
    cwd,
    configuration,
  );
}

function admitExecutionRequest(
  policy: CapabilityPolicy,
  request: Extract<HandsRequest, { kind: "tool" | "custom" }>,
  grants: CapabilityGrant[],
): HandsRequest {
  const requestedNetwork = request.arguments.network;
  if (requestedNetwork !== undefined && typeof requestedNetwork !== "boolean") {
    throw new SeptError("Network intent must be boolean");
  }
  if (requestedNetwork === true && !policy.network) {
    throw new SeptError("Network capability is absent");
  }
  return { ...request, grants };
}

/** Opening admission binds live policy before any Engine-owned native effect. */
export function openingPolicy(
  configuration: DockerHandsConfiguration,
  store: CapabilityPolicyStore,
): CapabilityPolicy {
  const policy = store.read();
  if (
    policy === undefined ||
    policy.denied ||
    JSON.stringify(policy.binding) !== JSON.stringify(capabilityBinding(configuration))
  ) {
    throw new SeptError("Capability policy is absent, denied or bound to another namespace");
  }
  validateCapabilities(policy, configuration);
  return policy;
}
