/** Bounded exact permission facts. Native Pi remains the sole task journal and retry scheduler. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./filesystem.js";
import { acquireStateRootLease } from "./lease.js";
import {
  MAX_CAPABILITY_REQUESTS,
  MAX_CAPABILITY_REQUEST_BYTES,
  parseCapabilityRequest,
  parseCapabilityDecision,
  capabilityDigest,
  sameCapabilityBinding,
  type CapabilityRequest,
  type CapabilityRequestFacts,
  type CapabilityDecision,
} from "./capability-request-codec.js";
export {
  CapabilityRequestWaitingError,
  capabilityArguments,
  MAX_CAPABILITY_REQUESTS,
  MAX_CAPABILITY_REQUEST_BYTES,
  type CapabilityRequest,
  type CapabilityRequestFacts,
  type CapabilityDecision,
} from "./capability-request-codec.js";
import { unknownRecord, exactKeys } from "./validation-primitives.js";
import { SeptError } from "./errors.js";

/** One bounded fsynced facts file, serialized with the same operator policy lease. */
export class CapabilityRequestStore {
  public readonly path: string;
  public constructor(private readonly root: string) {
    this.path = join(root, "capability-requests.json");
  }
  /** Read without granting, dispatching, expiring away, or discarding original-call denial evidence. */
  public read(): CapabilityRequest[] {
    try {
      if (!existsSync(this.path)) {
        return [];
      }
      if (
        statSync(this.path).size >
        MAX_CAPABILITY_REQUESTS * (2 * MAX_CAPABILITY_REQUEST_BYTES + 4096)
      ) {
        throw new SeptError("Permission request storage exceeds its bound");
      }
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const input = unknownRecord(raw, "permission requests");
      exactKeys(input, ["version", "requests"], [], "permission requests");
      if (
        input.version !== 1 ||
        !Array.isArray(input.requests) ||
        input.requests.length > MAX_CAPABILITY_REQUESTS
      ) {
        throw new SeptError("Permission request storage is malformed");
      }
      const requests = input.requests.map((entry: unknown) => parseCapabilityRequest(entry));
      if (new Set(requests.map((entry) => entry.id)).size !== requests.length) {
        throw new SeptError("Permission request identities collide");
      }
      return requests;
    } catch (error: unknown) {
      throw new SeptError("Permission request storage is unreadable or malformed", {
        cause: error,
      });
    }
  }
  private mutate<T>(change: (requests: CapabilityRequest[]) => T): T {
    const release = acquireStateRootLease(join(this.root, ".capability-policy-lock"));
    try {
      const requests = this.read();
      const result = change(requests);
      atomicWrite(this.path, { version: 1, requests });
      return result;
    } finally {
      release();
    }
  }
  /** A repeated exact denied call is idempotent; a collision fails closed before any effect. */
  public create(facts: CapabilityRequestFacts): CapabilityRequest {
    return this.mutate((requests) => {
      const id = createHash("sha256")
        .update(JSON.stringify([facts.runId, facts.invocation, facts.callId]))
        .digest("hex");
      const candidate = parseCapabilityRequest({
        ...facts,
        id,
        digest: capabilityDigest(facts.operation, facts.arguments),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      const existing = requests.find((entry) => entry.id === id);
      if (existing !== undefined) {
        if (
          existing.digest !== candidate.digest ||
          existing.revision !== facts.revision ||
          !sameCapabilityBinding(existing.binding, facts.binding)
        ) {
          throw new SeptError(
            "Permission call identity collides with changed content or authority",
          );
        }
        return existing;
      }
      if (requests.length === MAX_CAPABILITY_REQUESTS) {
        throw new SeptError("Permission request capacity reached");
      }
      requests.push(candidate);
      return candidate;
    });
  }
  /** Exact local decision only. Repeating it is inert; conflicting, expired or stale decisions refuse. */
  public decide(id: string, expectedDigest: string, target: CapabilityDecision): CapabilityRequest {
    return this.mutate((requests) => {
      const selected = requests.find((entry) => entry.id === id);
      if (selected?.digest !== expectedDigest || selected.expiresAt <= Date.now()) {
        throw new SeptError("Permission request is absent, changed or expired");
      }
      const checked = parseCapabilityDecision(target);
      if (selected.decision !== undefined) {
        const existing = { ...selected.decision, retry: undefined };
        if (JSON.stringify(existing) !== JSON.stringify({ ...checked, retry: undefined })) {
          throw new SeptError("Permission decision conflicts with its durable predecessor");
        }
        return selected;
      }
      selected.decision = checked;
      return selected;
    });
  }
  /** Reserve at most one new call in a later explicit invocation; uncertainty never frees this claim. */
  public claim(facts: CapabilityRequestFacts): CapabilityRequest | undefined {
    return this.mutate((requests) => {
      const selected = requests.find((entry) => this.matches(entry, facts));
      if (selected?.decision === undefined) {
        return undefined;
      }
      const retry = { invocation: facts.invocation, callId: facts.callId };
      if (
        selected.decision.retry?.callId !== undefined &&
        JSON.stringify(selected.decision.retry) !== JSON.stringify(retry)
      ) {
        return undefined;
      }
      selected.decision.retry = retry;
      return selected;
    });
  }
  /** Bounded scan (32) rechecks current decision and exact retry immediately before effects/settlement. */
  public permits(facts: CapabilityRequestFacts): boolean {
    return this.read().some(
      (entry) =>
        this.matches(entry, facts) &&
        entry.decision?.retry?.invocation === facts.invocation &&
        entry.decision.retry.callId === facts.callId,
    );
  }
  private matches(entry: CapabilityRequest, facts: CapabilityRequestFacts): boolean {
    const approved = entry.decision;
    return (
      entry.runId === facts.runId &&
      entry.invocation < facts.invocation &&
      entry.callId !== facts.callId &&
      entry.digest === capabilityDigest(facts.operation, facts.arguments) &&
      entry.expiresAt > Date.now() &&
      approved?.status === "approved" &&
      approved.expiresAt > Date.now() &&
      approved.revision === facts.revision &&
      sameCapabilityBinding(approved.binding, facts.binding)
    );
  }
}
