/** Owns bounded local operator configuration parsing; kernel facts belong to profile.ts. */
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { realpathSync, readFileSync, statSync, existsSync } from "node:fs";
import { atomicWrite, SeptError } from "../durable/index.js";
import {
  parseHandsDataDomain,
  type DockerHandsConfiguration,
  type CustomHand,
  type NamespaceLifetime,
} from "./contracts.js";
import { parseNetworkConfiguration } from "./network-profile.js";
import type { DockerEngineControl } from "./docker-engine.js";
import { handsRecord } from "./protocol.js";
import { parseNamespaceLifetime } from "./hands-processes.js";
/** Validate bounded trusted configuration text, never task arguments. */
export function configuredText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new SeptError("Hands configuration text is invalid");
  }
  return value;
}

function directory(value: unknown): string {
  const path = realpathSync(configuredText(value));
  if (!statSync(path).isDirectory()) {
    throw new SeptError("Hands configuration requires a directory");
  }
  return path;
}

function parseMount(value: unknown): DockerHandsConfiguration["readOnlyMounts"][number] {
  const mount = handsRecord(value);
  const destination = configuredText(mount.destination);
  if (!/^\/selected\/[A-Za-z0-9_-]+$/.test(destination)) {
    throw new SeptError("Selected mount alias must be below /selected");
  }
  return { source: directory(mount.source), destination };
}

function selectedMounts(value: unknown): DockerHandsConfiguration["readOnlyMounts"] {
  const mounts = value ?? [];
  if (!Array.isArray(mounts) || mounts.length > 8) {
    throw new SeptError("Hands selected mounts exceed their bound");
  }
  return mounts.map((mount: unknown) => parseMount(mount));
}

function mountConfiguration(input: Record<string, unknown>) {
  const mounts = selectedMounts(input.readOnlyMounts);
  const writable = selectedMounts(input.readWriteMounts);
  if (
    mounts.length + writable.length > 8 ||
    new Set([...mounts, ...writable].map((entry) => entry.destination)).size !==
      mounts.length + writable.length
  ) {
    throw new SeptError("Selected mount aliases exceed their bound or collide");
  }
  if (input.shell && writable.length > 0) {
    throw new SeptError("Arbitrary execution with persistent selected RW mounts is unsupported");
  }
  return { mounts, writable };
}

/** Read only trusted local operator configuration; task text cannot choose a backend. */
export function loadHandsConfiguration(path: string | undefined): DockerHandsConfiguration {
  try {
    if (path === undefined || statSync(path).size > 16 * 1024) {
      throw new SeptError("A supported supplied hands configuration is required");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const input = handsRecord(value);
    if (input.profile !== "docker-linux-warm-v1" || typeof input.shell !== "boolean") {
      throw new SeptError("Hands profile is unsupported");
    }
    const containerId = immutableId(configuredText(input.containerId));
    engineSocketIdentity(configuredText(input.engineSocket));
    const { mounts, writable } = mountConfiguration(input);
    const domain = parseHandsDataDomain(input);
    return {
      profile: input.profile,
      containerId,
      engineSocket: realpathSync(configuredText(input.engineSocket)),
      generation: configuredText(input.generation),
      workspace: directory(input.workspace),
      ...domain,
      resources: directory(input.resources),
      shell: input.shell,
      ...networkConfiguration(input.network),
      readOnlyMounts: mounts,
      ...(input.customHand === undefined
        ? {}
        : { customHand: parseCustomHand(input.customHand, mounts, input.shell) }),
      ...(writable.length === 0 ? {} : { readWriteMounts: writable }),
    };
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Supplied hands configuration is unavailable", { cause: error });
  }
}

/** Derived projection receipt identity stays private and independent of task/model paths. */
export function handsProjectionReceipt(resources: string, root: string): string {
  return join(
    root,
    ".hands-projections",
    createHash("sha256").update(resources).digest("hex"),
    "receipt.json",
  );
}

/** One exact operator program: bounded code path/hash and honest native replay declaration. */
export function parseCustomHand(
  value: unknown,
  mounts: DockerHandsConfiguration["readOnlyMounts"],
  shell: boolean,
): CustomHand {
  const input = handsRecord(value);
  const path = configuredText(input.path);
  if (
    !shell ||
    !mounts.some((mount) => path.startsWith(`${mount.destination}/`)) ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new SeptError(
      "Custom hand requires the bounded execution profile and a selected RO code path",
    );
  }
  if (
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    (input.replay !== "safe" && input.replay !== "unsafe") ||
    Object.keys(input).some((key) => !["path", "sha256", "replay"].includes(key))
  ) {
    throw new SeptError("Custom hand registration is malformed");
  }
  return { path, sha256: input.sha256, replay: input.replay };
}

function networkConfiguration(value: unknown): Pick<DockerHandsConfiguration, "network"> {
  return value === undefined ? {} : { network: parseNetworkConfiguration(value) };
}

/** Stable local socket identity is bound to configuration and checked before every exchange. */
export function engineSocketIdentity(path: string): string {
  try {
    return socketIdentity(path);
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Hands Engine socket is unavailable", { cause: error });
  }
}
function socketIdentity(path: string): string {
  if (!isAbsolute(path) || path.length > 4096 || path.includes("\0")) {
    throw new SeptError("Hands requires an explicit absolute local Engine socket");
  }
  const canonical = realpathSync(path);
  const socket = statSync(canonical);
  if (!socket.isSocket() || !trustedSocketOwner(socket.uid) || (socket.mode & 0o002) !== 0) {
    throw new SeptError("Hands Engine socket provenance is unsupported");
  }
  validateSocketAncestors(canonical);
  return JSON.stringify({
    path: canonical,
    dev: socket.dev,
    ino: socket.ino,
    uid: socket.uid,
    mode: socket.mode,
  });
}

function trustedSocketOwner(uid: number): boolean {
  return uid === 0 || uid === process.getuid?.();
}
function validateSocketAncestors(canonical: string): void {
  // A writable ancestor could substitute the authenticated endpoint between checks.
  for (let directory = dirname(canonical); ; directory = dirname(directory)) {
    const parent = statSync(directory);
    const stickyRoot = parent.uid === 0 && (parent.mode & 0o1000) !== 0;
    if (!trustedSocketOwner(parent.uid) || ((parent.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new SeptError("Hands Engine socket ancestor provenance is unsupported");
    }
    if (directory === dirname(directory)) {
      break;
    }
  }
}
/** Bound daemon/object identity without copying peer diagnostics. */
export function engineText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new SeptError("Hands Engine identity is malformed");
  }
  return value;
}

/** Additive private daemon receipt grants nothing; absence in old authority refuses automatic adoption. */
export function qualifyCapabilityEngine(
  engine: DockerEngineControl,
  policyPath: string,
  options: { initialize: boolean },
): void {
  const path = join(dirname(policyPath), "hands-engine.json");
  const expected = { version: 1, daemonId: engine.daemonId, socketIdentity: engine.socketIdentity };
  if (existsSync(path)) {
    const previous = readBoundedHandsRecord(path);
    if (
      Object.keys(previous).length !== 3 ||
      previous.version !== 1 ||
      previous.daemonId !== expected.daemonId ||
      previous.socketIdentity !== expected.socketIdentity
    ) {
      throw new SeptError(
        "Capability Engine receipt is incompatible; explicit separate state is required",
      );
    }
  } else {
    if (!options.initialize) {
      throw new SeptError("Capability Engine receipt is absent; old authority cannot be adopted");
    }
    atomicWrite(path, expected);
  }
}

/** Read private bounded metadata; missing/unreadable files never expose their paths. */
export function readBoundedHandsRecord(path: string): Record<string, unknown> {
  try {
    if (statSync(path).size > 16 * 1024) {
      throw new SeptError("Hands binding metadata is oversized");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return handsRecord(value);
  } catch {
    throw new SeptError("Hands binding metadata is malformed");
  }
}

/** One exact generation receipt, independent of run/policy schema and never scanned on an operation. */
export function namespaceLifetimePath(
  policyPath: string,
  binding: { containerId: string; generation: string },
): string {
  const key = createHash("sha256")
    .update(JSON.stringify([binding.containerId, binding.generation]))
    .digest("hex");
  return join(dirname(policyPath), ".hands-generations", key, "receipt.json");
}
/** Opening capture is immutable for its generation; changed or unknown existing facts refuse replacement. */
export function recordNamespaceLifetime(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
  policyPath: string,
  lifetime: NamespaceLifetime,
): void {
  const path = namespaceLifetimePath(policyPath, configuration);
  const receipt = {
    version: 1,
    containerId: configuration.containerId,
    generation: configuration.generation,
    daemonId: engine.daemonId,
    socketIdentity: engine.socketIdentity,
    lifetime,
  };
  if (existsSync(path)) {
    const previous = readNamespaceLifetime(configuration, engine, policyPath);
    if (JSON.stringify(previous) !== JSON.stringify(lifetime)) {
      throw new SeptError("Hands kernel lifetime changed for its recorded generation");
    }
    return;
  }
  atomicWrite(path, receipt);
}
/** A captured lifetime authenticates only the same socket, daemon, full ID and generation. */
export function readNamespaceLifetime(
  binding: { containerId: string; generation: string },
  engine: DockerEngineControl,
  policyPath: string,
): NamespaceLifetime {
  const receipt = readBoundedHandsRecord(namespaceLifetimePath(policyPath, binding));
  if (
    receipt.version !== 1 ||
    receipt.containerId !== binding.containerId ||
    receipt.generation !== binding.generation ||
    receipt.daemonId !== engine.daemonId ||
    receipt.socketIdentity !== engine.socketIdentity ||
    Object.keys(receipt).length !== 6
  ) {
    throw new SeptError("Hands kernel lifetime receipt is absent or incompatible");
  }
  return parseNamespaceLifetime(receipt.lifetime);
}

/** Decode the supported major/minor Engine version at negotiation. */
export function apiMinor(value: unknown): number {
  if (typeof value !== "string" || !/^1\.\d{1,3}$/.test(value)) {
    throw new SeptError("Hands Engine API version is malformed");
  }
  return Number(value.slice(2));
}

/** Only immutable full object IDs may enter REST routes. */
export function immutableId(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new SeptError("Hands Engine object identity is malformed");
  }
  return value;
}
