/** Bridges one supplied Docker Linux namespace to native Pi; Docker provisioning remains consumer-owned. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  atomicWrite,
  acquireStateRootLease,
  SeptError,
  type RunStore,
  CapabilityPolicyStore,
  type CapabilityPolicy,
} from "../durable/index.js";
import { HandsBackendUnavailableError } from "./contracts.js";
import type { DockerHandsConfiguration, ExecutionBackend, HandsRequest } from "./contracts.js";
import { HANDS_REQUEST_BYTES, handsRecord } from "./protocol.js";
import {
  capabilityBinding,
  admitCapabilityRequest,
  capabilityTools,
} from "./capability-admission.js";
import {
  dockerArguments,
  runDocker,
  inspect,
  revokeDockerBinding,
  reconcileDockerBinding,
  validateDockerConfiguration,
} from "./docker-control.js";
import { validateDockerProfile } from "./profile.js";

function projectionReceipt(resources: string, root: string): string {
  return join(
    root,
    ".hands-projections",
    createHash("sha256").update(resources).digest("hex"),
    "receipt.json",
  );
}
function openingPolicy(
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
  return policy;
}

async function recordBinding(
  store: RunStore,
  configuration: DockerHandsConfiguration,
  cwd: string,
): Promise<void> {
  const path = join(store.runDir, "hands-binding.json");
  if (existsSync(path)) {
    if (statSync(path).size > 16 * 1024) {
      throw new SeptError("Hands binding metadata is oversized");
    }
    const previous: unknown = JSON.parse(readFileSync(path, "utf8"));
    const binding = handsRecord(previous);
    // A surviving namespace may contain interrupted mutations. Consumer restart supplies fresh identity.
    if (
      binding.containerId === configuration.containerId &&
      binding.generation === configuration.generation
    ) {
      throw new SeptError("Hands restart requires a fresh consumer-started backend generation");
    }
    if (typeof binding.containerId !== "string" || typeof binding.generation !== "string") {
      throw new SeptError("Previous hands binding is malformed");
    }
    // Unknown surviving writes/commands must join before native scheduling with fresh authority.
    await reconcileDockerBinding(
      { containerId: binding.containerId, generation: binding.generation },
      configuration,
    );
  }
  atomicWrite(path, {
    profile: configuration.profile,
    containerId: configuration.containerId,
    generation: configuration.generation,
    cwd,
    runId: store.runId,
  });
}

/** Owns bounded control calls, cancellation, and namespace lease for one resident run. */
export class DockerExecutionBackend implements ExecutionBackend {
  public readonly id: string;
  public readonly generation: string;
  public readonly shell: boolean;
  public readonly tools: readonly import("./contracts.js").CodingToolName[] | undefined;
  private readonly watcher: FSWatcher | undefined;
  public readonly resourceProjectionDirectory: string;
  public readonly resourceProjectionReceipt: string;
  private readonly joins = new Set<Promise<void>>();
  private transport: Promise<void> = Promise.resolve();
  private unavailable = false;
  private stopping: Promise<void> | undefined;

  private constructor(
    private readonly configuration: DockerHandsConfiguration,
    public readonly cwd: string,
    private readonly workspace: string,
    private readonly brainRoots: readonly string[],
    private readonly release: () => void,
    projectionReceipt: string,
    private readonly policyStore: CapabilityPolicyStore,
    private readonly policy: CapabilityPolicy,
  ) {
    this.id = `docker:${configuration.containerId}`;
    this.generation = configuration.generation;
    this.shell = policy.execute;
    this.tools = capabilityTools(policy, configuration);
    this.watcher = watch(join(policyStore.path, ".."), () => {
      try {
        this.assertPolicy();
      } catch {
        void this.stopNamespace().catch(() => undefined);
      }
    });
    this.resourceProjectionDirectory = configuration.resources;
    this.resourceProjectionReceipt = projectionReceipt;
  }

  /** Validate actual containment before resources or native scheduling, retaining one exclusive lease. */
  public static async create(
    configuration: DockerHandsConfiguration,
    store: RunStore,
    brainRoots: readonly string[],
    policyStore: CapabilityPolicyStore,
  ): Promise<DockerExecutionBackend> {
    const policy = openingPolicy(configuration, policyStore);
    const workspace = store.manifest().workspace;
    const cwd = await validateDockerConfiguration(configuration, brainRoots, workspace);
    const leaseRoot = join(
      brainRoots[1] ?? store.runDir,
      ".hands-leases",
      configuration.containerId,
    );
    mkdirSync(leaseRoot, { recursive: true });
    const release = acquireStateRootLease(leaseRoot);
    try {
      await recordBinding(store, configuration, cwd);
      return new DockerExecutionBackend(
        configuration,
        cwd,
        workspace,
        brainRoots,
        release,
        projectionReceipt(configuration.resources, brainRoots[1] ?? store.runDir),
        policyStore,
        policy,
      );
    } catch (error: unknown) {
      release();
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
    this.joins.add(joined);
    // Bounded transport backpressure keeps native batches inside the supplied PID/memory limits.
    // Pi still owns task scheduling/replay; queued calls retain cancellation ownership.
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
      context.abortSignal?.removeEventListener("abort", abort);
      this.joins.delete(joined);
      finish();
    }
  }

  private async dispatch(context: Context, input: string): Promise<unknown> {
    this.assertAvailable(context);
    await this.validateLive(context);
    this.assertPolicy();
    const raw = await runDocker(dockerArguments(this.configuration, this.cwd), input);
    this.assertAvailable(context);
    this.assertPolicy();
    const value: unknown = JSON.parse(raw);
    return value;
  }

  private admit(request: HandsRequest, context: Context): string {
    this.assertAvailable(context);
    const policy = this.assertPolicy();
    const admitted = admitCapabilityRequest(policy, request, this.cwd, this.configuration);
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
    validateDockerProfile(
      this.configuration,
      await inspect(this.configuration),
      this.workspace,
      this.brainRoots,
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
    await revokeDockerBinding({
      containerId: this.configuration.containerId,
      generation: this.generation,
    });
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
      this.release();
    }
  }
}
