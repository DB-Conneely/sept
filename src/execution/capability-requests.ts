/** Exact permission authority translates bounded facts only; the backend owns all effects and timers. */
import { join } from "node:path";
import {
  CapabilityRequestStore,
  CapabilityRequestWaitingError,
  capabilityArguments,
  type CapabilityRequestFacts,
  type CapabilityPolicyStore,
  type CapabilityPolicy,
  type RunStore,
} from "../durable/index.js";
import {
  HandsBackendUnavailableError,
  type HandsRequest,
  type DockerHandsConfiguration,
} from "./contracts.js";
import { admitCapabilityRequest, admitApprovedCapabilityRequest } from "./capability-admission.js";
/** One live exact-decision owner bound to the installed backend and immutable native run. */
export class CapabilityRequestAuthority {
  private pendingRequest: string | undefined;
  private readonly requests: CapabilityRequestStore;
  public constructor(
    private readonly configuration: DockerHandsConfiguration,
    private readonly cwd: string,
    private readonly store: RunStore,
    policyStore: CapabilityPolicyStore,
    private readonly policy: CapabilityPolicy,
    private readonly assertPolicy: () => CapabilityPolicy,
  ) {
    this.requests = new CapabilityRequestStore(join(policyStore.path, ".."));
  }
  /** Explicit block keeps the original native call denied before its unsafe intent is admitted. */
  public beforeTool(
    request: Extract<HandsRequest, { kind: "tool" | "custom" }>,
  ): string | undefined {
    try {
      this.authorize(request);
      return undefined;
    } catch (error: unknown) {
      if (error instanceof CapabilityRequestWaitingError) {
        return "Exact permission requested; original call denied. Local decision and explicit retry required.";
      }
      throw error;
    }
  }
  /** No provider work is parked while a local operator chooses. */
  public pendingPermission(): string | undefined {
    return this.pendingRequest;
  }
  private nativeIdentity(request: Extract<HandsRequest, { kind: "file" }>): string {
    if (request.callId === undefined) {
      throw new HandsBackendUnavailableError(
        "Native approval requires its trusted tool/task identity",
      );
    }
    return request.callId;
  }
  private facts(
    request: Exclude<HandsRequest, { kind: "resources" }>,
    policy: CapabilityPolicy,
  ): CapabilityRequestFacts {
    return {
      runId: this.store.runId,
      invocation: this.store.snapshot().invocations,
      callId:
        request.kind === "file"
          ? this.nativeIdentity(request)
          : (request.taskKey ?? request.callId),
      ...this.operation(request),
      revision: policy.revision,
      binding: policy.binding,
    };
  }
  private operation(request: Exclude<HandsRequest, { kind: "resources" }>): {
    operation: string;
    arguments: string;
  } {
    if (request.kind === "custom") {
      return {
        operation: "custom_hand",
        arguments: capabilityArguments({
          ...request.arguments,
          hand: this.configuration.customHand,
        }),
      };
    }
    if (request.kind === "tool") {
      return { operation: request.name, arguments: capabilityArguments(request.arguments) };
    }
    return {
      operation: request.method,
      arguments: capabilityArguments({
        path: request.path,
        ...(request.content === undefined ? {} : { content: request.content }),
      }),
    };
  }
  private bindCustom(request: HandsRequest): HandsRequest {
    if (request.kind === "custom") {
      if (this.configuration.customHand === undefined) {
        throw new HandsBackendUnavailableError("Custom hand is not operator registered");
      }
      request = { ...request, hand: this.configuration.customHand };
    }
    return request;
  }
  private refuseOriginal(request: HandsRequest): void {
    if (request.kind === "resources") {
      return;
    }
    const callId = request.kind === "file" ? request.callId : (request.taskKey ?? request.callId);
    if (callId === undefined) {
      return;
    }
    const original = this.requests
      .read()
      .find((entry) => entry.runId === this.store.runId && entry.callId === callId);
    if (original !== undefined) {
      this.pendingRequest = original.id;
      throw new CapabilityRequestWaitingError(original.id);
    }
  }
  /** Live run/policy/decision check repeated at pre-intent, dispatch, replay and settlement. */
  public authorize(request: HandsRequest): HandsRequest {
    request = this.bindCustom(request);
    const policy = this.assertPolicy();
    const status = this.store.snapshot().status;
    if (status !== "active") {
      throw new HandsBackendUnavailableError("Run no longer owns effect authority");
    }
    this.refuseOriginal(request);
    try {
      return admitCapabilityRequest(policy, request, this.cwd, this.configuration);
    } catch (error: unknown) {
      if (policy.mode !== "request_approval" || request.kind === "resources") {
        throw error;
      }
      const facts = this.facts(request, policy);
      if (this.requests.permits(facts) || this.requests.claim(facts) !== undefined) {
        return admitApprovedCapabilityRequest(policy, request, this.cwd, this.configuration);
      }
      const pending = this.requests.create(facts);
      this.pendingRequest = pending.id;
      throw new CapabilityRequestWaitingError(pending.id);
    }
  }

  /** The backend owns the corresponding timer and namespace join. */
  public approvalExpiry(request: HandsRequest): number | undefined {
    if (request.kind === "resources" || this.policy.mode !== "request_approval") {
      return undefined;
    }
    try {
      admitCapabilityRequest(this.policy, request, this.cwd, this.configuration);
      return undefined;
    } catch {
      // Only an exact exception owns an expiry timer; ordinary native permissions need no identity.
    }
    const facts = this.facts(request, this.policy);
    if (!this.requests.permits(facts)) {
      return undefined;
    }
    const approved = this.requests
      .read()
      .find(
        (entry) =>
          entry.decision?.retry?.invocation === facts.invocation &&
          entry.decision.retry.callId === facts.callId &&
          entry.runId === facts.runId,
      );
    return approved?.decision?.expiresAt;
  }
}
