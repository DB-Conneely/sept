/** Bridges one supplied Docker Linux namespace to native Pi; Docker provisioning remains consumer-owned. */

import type { FSWatcher } from "node:fs";
import type { Context } from "@earendil-works/chord";
import {
  SeptError,
  type RunStore,
  CapabilityPolicyStore,
  CapabilityRequestWaitingError,
  type CapabilityPolicy,
} from "../durable/index.js";
import { assertHandsAvailable } from "./hands-loss.js";
import type { DockerHandsConfiguration, ExecutionBackend, HandsRequest } from "./contracts.js";
import { openHandsControl, closeFailedHandsOpening } from "./hands-opening.js";
import { captureHandsRequest } from "./hands-request.js";
import { capabilityTools, openingPolicy } from "./capability-admission.js";
import { revokeDockerBinding, recordHandsBinding } from "./docker-control.js";
import { validateLiveHands } from "./hands-live-authority.js";
import type { DockerEngineControl } from "./docker-engine.js";
import { handsProjectionReceipt } from "./profile-configuration.js";
import { WarmHandsChannel } from "./warm-channel.js";
import {
  CapabilityRequestAuthority,
  verifyHandsPolicy,
  watchHandsPolicy,
} from "./capability-requests.js";
import { HandsProcessOwner } from "./hands-process-owner.js";
import {
  invokeHandsOperation,
  joinHandsBeforeClose,
  invokeAdmittedHands,
} from "./hands-operation.js";

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
  private channel: WarmHandsChannel | undefined;
  private processes: HandsProcessOwner | undefined;
  private readonly permissions: CapabilityRequestAuthority;
  private stopping: Promise<void> | undefined;
  private loss: Error | undefined;
  private namespaceStopped = false;

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
    this.watcher = watchHandsPolicy(
      policyStore.path,
      () => this.assertPolicy(),
      () => this.stopNamespace(),
    );
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
    const { engine, cwd, release } = await openHandsControl(
      configuration,
      store,
      brainRoots,
      policyStore,
      controlEndpoint,
    );
    let backend: DockerExecutionBackend | undefined;
    try {
      backend = new DockerExecutionBackend(
        configuration,
        engine,
        cwd,
        store.manifest().workspace,
        brainRoots,
        release,
        policyStore,
        policy,
        store,
        controlEndpoint,
      );
      await backend.start(store);
      return backend;
    } catch (error: unknown) {
      await closeFailedHandsOpening(engine, release, backend?.watcher, () =>
        backend?.stopNamespace(),
      );
      throw error;
    }
  }

  private async start(store: RunStore): Promise<void> {
    await recordHandsBinding(store, this.configuration, this.cwd, this.engine);
    this.channel = await WarmHandsChannel.open(
      this.configuration,
      this.engine,
      this.cwd,
      (error) => {
        this.loss = error;
        void this.stopNamespace().catch(() => undefined);
      },
    );
    this.processes = await HandsProcessOwner.open(
      this.configuration,
      this.engine,
      this.channel.identity,
    );
  }

  /** Register ownership before validation/dispatch; cancellation invalidates the entire dedicated namespace. */
  public async invoke(request: HandsRequest, context: Context): Promise<unknown> {
    const input = this.admit(request, context);
    let finish: () => void = () => undefined;
    const joined = new Promise<void>((resolvePromise) => {
      finish = resolvePromise;
    });
    const expiryTimer = this.permissions.expirationTimer(request, () => {
      void this.stopNamespace().catch(() => undefined);
    });
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
      return await invokeAdmittedHands(context, input, {
        dispatch: (stage) => this.dispatch(context, input, stage),
        stop: () => this.stopNamespace(),
        loss: () => this.loss,
      });
    } finally {
      clearTimeout(expiryTimer);
      context.abortSignal?.removeEventListener("abort", abort);
      this.joins.delete(joined);
      finish();
    }
  }

  private async dispatch(
    context: Context,
    request: HandsRequest,
    stage: (stage: "effect" | "result") => void,
  ): Promise<unknown> {
    this.assertAvailable(context);
    await this.validateLive(context, request);
    this.assertPolicy();
    this.permissions.authorize(request);
    if (this.channel === undefined) {
      throw new SeptError("Hands resident channel is absent");
    }
    stage("effect");
    const result = await invokeHandsOperation(
      this.channel,
      this.processes,
      request,
      this.cwd,
      async () => {
        await this.authorize(context, request);
        return this.permissions.authorize(request);
      },
    );
    stage("result");
    await this.authorize(context, request);
    return result;
  }
  private async authorize(context: Context, request: HandsRequest): Promise<void> {
    this.assertAvailable(context);
    await this.validateLive(context, request);
    // The permission owner rechecks the whole live policy itself; transport/parent snapshots confer no authority.
    this.permissions.authorize(request);
  }

  private admit(request: HandsRequest, context: Context): HandsRequest {
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
    return captureHandsRequest(admitted);
  }

  /** Native pre-intent gate and generation seal use this same live effect authority. */
  public beforeTool(
    request: Extract<HandsRequest, { kind: "tool" | "custom" }>,
  ): string | undefined {
    this.assertAvailable();
    return this.permissions.beforeTool(request);
  }
  /** No model polling while a decision is pending. */
  public pendingPermission(): string | undefined {
    return this.permissions.pendingPermission();
  }

  private assertPolicy(): CapabilityPolicy {
    try {
      return verifyHandsPolicy(this.configuration, this.policyStore, this.policy);
    } catch (error: unknown) {
      // Durable denial wins before the asynchronous exact-generation shutdown can acknowledge it.
      void this.stopNamespace().catch(() => undefined);
      throw error;
    }
  }

  private assertAvailable(context?: Context): void {
    assertHandsAvailable({
      unavailable: this.unavailable,
      loss: this.loss,
      namespaceStopped: this.namespaceStopped,
      cancelled: context?.abortSignal?.aborted === true,
    });
  }

  private async validateLive(context: Context, request: HandsRequest): Promise<void> {
    await validateLiveHands(this.configuration, this.engine, request, {
      workspace: this.workspace,
      brainRoots: this.brainRoots,
      policyPath: this.policyStore.path,
      ...(this.controlEndpoint === undefined ? {} : { controlEndpoint: this.controlEndpoint }),
    });
    this.assertAvailable(context);
  }

  private stopNamespace(): Promise<void> {
    // Denial wins before the asynchronous stop acknowledgement, including concurrent native calls.
    this.unavailable = true;
    this.stopping ??= revokeDockerBinding(
      {
        containerId: this.configuration.containerId,
        generation: this.generation,
      },
      this.configuration,
      { policyPath: this.policyStore.path },
      this.engine,
    )
      .then(() => {
        this.namespaceStopped = true;
      })
      .finally(async () => {
        // Stop joins the exact namespace; resident and Engine ownership still finalize if either close fails.
        try {
          await this.channel?.release();
        } finally {
          await this.engine.close();
        }
      });
    return this.stopping;
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
          await joinHandsBeforeClose(this.processes, this.stopping, () => this.stopNamespace());
        }
      } finally {
        await Promise.all(this.joins);
      }
    } finally {
      try {
        await this.channel?.close();
      } finally {
        await this.engine.close();
        this.release();
      }
    }
  }
}
