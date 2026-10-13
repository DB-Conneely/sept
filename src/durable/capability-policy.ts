/** Bounded operator authority. Atomic fsync and a separate lease serialize revision activation. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicCreate, atomicWrite } from "./filesystem.js";
import { acquireStateRootLease } from "./lease.js";
import { SeptError } from "./errors.js";
import {
  boundedInteger,
  boundedString,
  enumValue,
  exactKeys,
  unknownRecord,
} from "./validation-primitives.js";

/** Missing, denied or malformed live authority makes scheduling dormant, never hides lifecycle failures. */
export class CapabilityPolicyDeniedError extends SeptError {}

/** Independent rights for one work-visible root, never a host path chosen by model text. */
export interface CapabilityRights {
  read: boolean;
  write: boolean;
}
/** One selected supplied mount; the kernel and effect owner both enforce its rights. */
export interface CapabilityGrant extends CapabilityRights {
  root: string;
}
/** Operator input. Network requests unsupported by the shipped profile are refused before activation. */
export interface CapabilityConfiguration {
  mode: "full_access" | "scoped";
  workspace: CapabilityRights;
  selected: CapabilityGrant[];
  execute: boolean;
  network: boolean;
}
/** Durable binding prevents a changed root or surviving old namespace from acquiring fresh authority. */
export interface CapabilityBinding {
  containerId: string;
  generation: string;
  fingerprint: string;
}
/** Versioned authority; denial is durable before any old namespace is stopped. */
export interface CapabilityPolicy extends CapabilityConfiguration {
  version: 1;
  revision: number;
  denied: boolean;
  binding: CapabilityBinding;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SeptError("Capability right must be boolean");
  }
  return value;
}
function rights(value: unknown): CapabilityRights {
  const input = unknownRecord(value, "capability rights");
  exactKeys(input, ["read", "write"], [], "capability rights");
  return { read: boolean(input.read), write: boolean(input.write) };
}
function grant(value: unknown): CapabilityGrant {
  const input = unknownRecord(value, "capability grant");
  exactKeys(input, ["root", "read", "write"], [], "capability grant");
  const root = boundedString(input.root, 1, 256, "capability root");
  if (!/^\/selected\/[A-Za-z0-9_-]+$/.test(root)) {
    throw new SeptError("Capability root is unsupported");
  }
  return { root, read: boolean(input.read), write: boolean(input.write) };
}
/** Decode exact bounded local operator input once; extra task-like fields cannot grant authority. */
export function parseCapabilityConfiguration(value: unknown): CapabilityConfiguration {
  const input = unknownRecord(value, "capability configuration");
  exactKeys(
    input,
    ["mode", "workspace", "selected", "execute", "network"],
    [],
    "capability configuration",
  );
  if (!Array.isArray(input.selected) || input.selected.length > 8) {
    throw new SeptError("Capability grants exceed their bound");
  }
  const selected = input.selected.map((value: unknown) => grant(value));
  if (new Set(selected.map((entry) => entry.root)).size !== selected.length) {
    throw new SeptError("Capability roots must be unique");
  }
  return {
    mode: enumValue(input.mode, ["full_access", "scoped"], "capability mode"),
    workspace: rights(input.workspace),
    selected,
    execute: boolean(input.execute),
    network: boolean(input.network),
  };
}
function binding(value: unknown): CapabilityBinding {
  const input = unknownRecord(value, "capability binding");
  exactKeys(input, ["containerId", "generation", "fingerprint"], [], "capability binding");
  const containerId = boundedString(input.containerId, 64, 64, "capability backend");
  const fingerprint = boundedString(input.fingerprint, 64, 64, "capability fingerprint");
  if (!/^[a-f0-9]{64}$/.test(containerId) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new SeptError("Capability identity is malformed");
  }
  return {
    containerId,
    generation: boundedString(input.generation, 1, 256, "capability generation"),
    fingerprint,
  };
}
function policy(value: unknown): CapabilityPolicy {
  const input = unknownRecord(value, "capability policy");
  exactKeys(
    input,
    [
      "version",
      "revision",
      "denied",
      "binding",
      "mode",
      "workspace",
      "selected",
      "execute",
      "network",
    ],
    [],
    "capability policy",
  );
  if (input.version !== 1 || input.network === true) {
    throw new SeptError("Capability policy version is unsupported");
  }
  return {
    ...parseCapabilityConfiguration({
      mode: input.mode,
      workspace: input.workspace,
      selected: input.selected,
      execute: input.execute,
      network: input.network,
    }),
    version: 1,
    revision: boundedInteger(input.revision, 1, Number.MAX_SAFE_INTEGER - 1, "capability revision"),
    denied: boolean(input.denied),
    binding: binding(input.binding),
  };
}
/** Owns only the private policy record, separate from native tasks and the worker slot lease. */
export class CapabilityPolicyStore {
  public readonly path: string;
  public constructor(private readonly root: string) {
    this.path = join(root, "capability-policy.json");
  }
  /** Missing old state is dormant; malformed present state fails closed without replacement. */
  public read(): CapabilityPolicy | undefined {
    if (!existsSync(this.path)) {
      return undefined;
    }
    try {
      if (statSync(this.path).size > 16 * 1024) {
        throw new SeptError("Capability policy exceeds its bound");
      }
      const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      return policy(value);
    } catch (error: unknown) {
      throw new CapabilityPolicyDeniedError("Capability policy is malformed; execution is denied", {
        cause: error,
      });
    }
  }
  /** New state alone receives the safe default. Existing absent policy is never silently adopted. */
  public initialize(configuration: CapabilityConfiguration, authority: CapabilityBinding): void {
    atomicCreate(
      this.path,
      policy({
        ...configuration,
        version: 1,
        revision: 1,
        denied: false,
        binding: authority,
      }),
    );
    this.read();
  }
  /** Serialize compare-and-swap; the caller must validate quiescence before expansion. */
  public activate(
    configuration: CapabilityConfiguration,
    authority: CapabilityBinding,
    expectedRevision: number,
  ): CapabilityPolicy {
    const release = acquireStateRootLease(join(this.root, ".capability-policy-lock"));
    try {
      const previous = this.read();
      if ((previous?.revision ?? 0) !== expectedRevision) {
        throw new SeptError("Capability revision changed; inspect and retry");
      }
      const next = policy({
        ...configuration,
        version: 1,
        revision: expectedRevision + 1,
        denied: false,
        binding: authority,
      });
      atomicWrite(this.path, next);
      return next;
    } finally {
      release();
    }
  }
  /** Fsync denial first; stopping/joining incompatible effects is the execution owner's next duty. */
  public revoke(expectedRevision: number): CapabilityPolicy {
    const release = acquireStateRootLease(join(this.root, ".capability-policy-lock"));
    try {
      const previous = this.read();
      if (previous?.revision !== expectedRevision) {
        throw new SeptError("Capability revision changed; inspect and retry");
      }
      const next = policy({ ...previous, revision: previous.revision + 1, denied: true });
      atomicWrite(this.path, next);
      return next;
    } finally {
      release();
    }
  }
}
