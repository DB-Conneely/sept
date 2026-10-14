/** Bridges one supplied Docker Linux namespace to native Pi; Docker provisioning remains consumer-owned. */

import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  SeptError,
  type RunStore,
  CapabilityPolicyStore,
  CapabilityRequestWaitingError,
  type CapabilityPolicy,
} from "../durable/index.js";
import { HandsBackendUnavailableError } from "./contracts.js";
import type { DockerHandsConfiguration, ExecutionBackend, HandsRequest } from "./contracts.js";
import { HANDS_REQUEST_BYTES, parseHandsRequest } from "./protocol.js";
import { capabilityBinding, capabilityTools, openingPolicy } from "./capability-admission.js";
import {
  acquireHandsLease,
  handsExecution,
  inspect,
  revokeDockerBinding,
  recordHandsBinding,
  validateDockerConfiguration,
} from "./docker-control.js";
import { validateDockerProfile, verifyKernelBinding } from "./profile.js";
import { validateNetworkEnforcement } from "./network-enforcement.js";
import { DockerEngineControl } from "./docker-engine.js";
import { validateSealedInputs } from "./hands-processes.js";
import { handsProjectionReceipt } from "./profile-configuration.js";
import { CapabilityRequestAuthority } from "./capability-requests.js";

/** Owns bounded control calls, cancellation, and namespace lease for one resident run. */
export class DockerExecutionBackend implements ExecutionBackend {
  public readonly id: string;
  public readonly generation: string;
  public readonly shell: boolean;
  public readonly customHand: DockerHandsConfiguration["customHand"];
  public readonly tools: readonly import("./contracts.js").CodingToolName[] | undefined;
  private readonly watcher: FSWatcher | undefined;
  public readonly resourceProjectionDirectory: string;
  public readonly resourceProjectionReceipt: string;
  private readonly joins = new Set<Promise<void>>();
  private transport: Promise<void> = Promise.resolve();
  private unavailable = false;
  private readonly permissions: CapabilityRequestAuthority;
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly configuration: DockerHandsConfiguration,
    private readonly engine: DockerEngineControl,
    public readonly cwd: string,
    private readonly workspace: string,
    private readonly brainRoots: readonly string[],
    private readonly release: () => void,
    private readonly policyStore: CapabilityPolicyStore,
    private readonly policy: CapabilityPolicy,
    store: RunStore,
    private readonly controlEndpoint?: { address: string; port: number },
  ) {
    this.id = `docker:${configuration.containerId}`;
    this.generation = configuration.generation;
    this.customHand =
      policy.execute || policy.mode === "request_approval" ? configuration.customHand : undefined;
    this.shell = policy.execute || (policy.mode === "request_approval" && configuration.shell);
    this.permissions = new CapabilityRequestAuthority(
      configuration,
      cwd,
      store,
      policyStore,
      policy,
      () => this.assertPolicy(),
    );
    this.tools = capabilityTools(policy, configuration);
    this.watcher = watch(join(policyStore.path, ".."), () => {
      try {
        this.assertPolicy();
      } catch {
        void this.stopNamespace().catch(() => undefined);
      }
    });
    this.resourceProjectionDirectory = configuration.resources;
    this.resourceProjectionReceipt = handsProjectionReceipt(
      configuration.resources,
      brainRoots[1] ?? store.runDir,
    );
  }

  /** Validate actual containment before resources or native scheduling, retaining one exclusive lease. */
  public static async create(
    configuration: DockerHandsConfiguration,
    store: RunStore,
    brainRoots: readonly string[],
    policyStore: CapabilityPolicyStore,
    controlEndpoint?: { address: string; port: number },
  ): Promise<DockerExecutionBackend> {
    const policy = openingPolicy(configuration, policyStore);
    const workspace = store.manifest().workspace;
    const engine = await DockerEngineControl.open(configuration.engineSocket);
    let release: (() => void) | undefined;
    try {
      const cwd = await validateDockerConfiguration(
        configuration,
        brainRoots,
        workspace,
        controlEndpoint,
        { policyPath: policyStore.path, initialize: false },
        engine,
      );
      release = acquireHandsLease(configuration, store, brainRoots);
      await recordHandsBinding(store, configuration, cwd, engine);
      return new DockerExecutionBackend(
        configuration,
        engine,
        cwd,
        workspace,
        brainRoots,
        release,
        policyStore,
        policy,
        store,
        controlEndpoint,
      );
    } catch (error: unknown) {
      await engine.close();
      release?.();
      throw error;
    }
  }

  /** Register ownership before validation/dispatch; cancellation invalidates the entire dedicated namespace. */
  public async invoke(request: HandsRequest, context: Context): Promise<unknown> {
    const input = this.admit(request, context);
    let finish: () => void = () => undefined;
    const joined = new Promise<void>((resolvePromise) => {
      finish = resolvePromise;
    });
    const expiryTimer = this.permissionTimer(request);
    // Bounded transport backpressure keeps native batches inside the supplied PID/memory limits.
    // Pi still owns task scheduling/replay; queued calls retain cancellation ownership.
    this.joins.add(joined);
    const preceding = this.transport;
    this.transport = joined;
    const abort = (): void => {
      void this.stopNamespace().catch(() => undefined);
    };
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      await preceding;
      return await this.dispatch(context, input);
    } catch (error: unknown) {
      // A lost client cannot prove that its command stopped. Join the kernel namespace before settlement.
      try {
        await this.stopNamespace();
      } catch (stopError: unknown) {
        throw new HandsBackendUnavailableError(
          "Hands shutdown is unverified; consumer reconciliation is required",
          { cause: stopError },
        );
      }
      throw new HandsBackendUnavailableError(
        "Hands backend lost execution authority; interrupted effects may be uncertain",
        { cause: error },
      );
    } finally {
      if (expiryTimer !== undefined) {
        clearTimeout(expiryTimer);
      }
      context.abortSignal?.removeEventListener("abort", abort);
      this.joins.delete(joined);
      finish();
    }
  }

  private permissionTimer(request: HandsRequest): NodeJS.Timeout | undefined {
    const expiry = this.permissions.approvalExpiry(request);
    return expiry === undefined
      ? undefined
      : setTimeout(
          () => {
            void this.stopNamespace().catch(() => undefined);
          },
          Math.max(1, expiry - Date.now()),
        );
  }

  private async dispatch(context: Context, input: string): Promise<unknown> {
    const request = parseHandsRequest(JSON.parse(input));
    this.assertAvailable(context);
    await this.validateLive(context);
    this.assertPolicy();
    this.permissions.authorize(request);
    const raw = await this.engine.exec(
      this.configuration.containerId,
      handsExecution(this.cwd, input, {
        network:
          (request.kind === "tool" || request.kind === "custom") &&
          request.arguments.network === true,
      }),
    );
    this.assertAvailable(context);
    this.assertPolicy();
    this.permissions.authorize(request);
    const value: unknown = JSON.parse(raw);
    return value;
  }

  private admit(request: HandsRequest, context: Context): string {
    this.assertAvailable(context);
    const pending = this.permissions.pendingPermission();
    if (pending !== undefined) {
      throw new CapabilityRequestWaitingError(pending);
    }
    this.assertPolicy();
    const admitted = this.permissions.authorize(request);
    if (this.joins.size >= 8) {
      throw new SeptError("Hands backend is at capacity");
    }
    if (request.kind === "tool" && request.name === "bash" && !this.shell) {
      throw new SeptError("Shell capability is absent");
    }
    const input = JSON.stringify(admitted);
    if (Buffer.byteLength(input) > HANDS_REQUEST_BYTES) {
      throw new SeptError("Hands request exceeds its bound");
    }
    return input;
  }

  /** Native pre-intent gate and generation seal use this same live effect authority. */
  public beforeTool(
    request: Extract<HandsRequest, { kind: "tool" | "custom" }>,
  ): string | undefined {
    return this.permissions.beforeTool(request);
  }
  /** No model polling while a decision is pending. */
  public pendingPermission(): string | undefined {
    return this.permissions.pendingPermission();
  }

  private assertPolicy(): CapabilityPolicy {
    try {
      const current = this.policyStore.read();
      if (
        current === undefined ||
        current.denied ||
        // Equal revision cannot legitimize edited authority; captured arguments/rights stay immutable.
        JSON.stringify(current) !== JSON.stringify(this.policy) ||
        JSON.stringify(current.binding) !== JSON.stringify(capabilityBinding(this.configuration))
      ) {
        throw new HandsBackendUnavailableError(
          "Live capability authority is unavailable; explicit fresh configuration is required",
        );
      }
      return current;
    } catch (error: unknown) {
      throw new HandsBackendUnavailableError(
        "Live capability authority is unavailable; explicit fresh configuration is required",
        { cause: error },
      );
    }
  }

  private assertAvailable(context: Context): void {
    if (this.unavailable || context.abortSignal?.aborted) {
      throw new HandsBackendUnavailableError(
        "Hands operation was interrupted; effects may be uncertain",
      );
    }
  }

  private async validateLive(context: Context): Promise<void> {
    const inspected = await inspect(this.configuration, this.engine);
    validateDockerProfile(this.configuration, inspected, this.workspace, this.brainRoots);
    verifyKernelBinding(this.configuration, inspected, this.policyStore.path);
    await validateSealedInputs(this.configuration, this.engine);
    await validateNetworkEnforcement(
      this.configuration,
      inspected,
      this.controlEndpoint,
      this.engine,
    );
    if (this.unavailable || context.abortSignal?.aborted) {
      throw new SeptError("Hands execution was cancelled before dispatch");
    }
  }

  private stopNamespace(): Promise<void> {
    // Denial wins before the asynchronous stop acknowledgement, including concurrent native calls.
    this.unavailable = true;
    this.stopping ??= this.stopAndVerify();
    return this.stopping;
  }

  private async stopAndVerify(): Promise<void> {
    await revokeDockerBinding(
      {
        containerId: this.configuration.containerId,
        generation: this.generation,
      },
      this.configuration,
      { policyPath: this.policyStore.path },
      this.engine,
    );
  }

  /** Close every owned transport before releasing authority; the consumer owns restart/removal. */
  public async close(): Promise<void> {
    this.unavailable = true;
    this.watcher?.close();
    try {
      try {
        if (this.joins.size > 0) {
          await this.stopNamespace();
        } else {
          // A previous failed stop remains unverified after its last transport joined.
          await this.stopping;
        }
      } finally {
        await Promise.all(this.joins);
      }
    } finally {
      await this.engine.close();
      this.release();
    }
  }
}
