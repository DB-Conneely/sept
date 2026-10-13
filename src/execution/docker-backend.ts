/** Bridges one supplied Docker Linux namespace to native Pi; Docker provisioning remains consumer-owned. */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { atomicWrite, acquireStateRootLease, SeptError, type RunStore } from "../durable/index.js";
import { HandsBackendUnavailableError } from "./contracts.js";
import type { DockerHandsConfiguration, ExecutionBackend, HandsRequest } from "./contracts.js";
import { HANDS_REQUEST_BYTES, HANDS_RESPONSE_BYTES, handsRecord } from "./protocol.js";
import { validateDockerProfile } from "./profile.js";

function dockerArguments(configuration: DockerHandsConfiguration, cwd: string): string[] {
  return [
    "exec",
    "-i",
    "--workdir",
    cwd,
    configuration.containerId,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "TMPDIR=/tmp",
    "PI_OFFLINE=1",
    "node",
    "/app/dist/src/execution/hands-entry.js",
  ];
}

function runDocker(
  arguments_: string[],
  input = "",
  maximum = HANDS_RESPONSE_BYTES,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      // This is the trusted control client. Executed hands receive env -i, never this environment.
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let output = "";
    let overflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > maximum) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        output += chunk;
      }
    });
    // Diagnostics are intentionally drained, never buffered or exposed as hostile error text.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", (error: unknown) => {
      clearTimeout(timer);
      reject(new SeptError("Hands control client is unavailable", { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow) {
        reject(new SeptError("Hands operation failed or exceeded its transport bound"));
      } else {
        resolvePromise(output);
      }
    });
    child.stdin.end(input);
  });
}

async function inspect(configuration: DockerHandsConfiguration): Promise<unknown> {
  const raw = await runDocker(
    ["inspect", "--format", "{{json .}}", configuration.containerId],
    "",
    256 * 1024,
  );
  const value: unknown = JSON.parse(raw);
  return value;
}

function recordBinding(
  store: RunStore,
  configuration: DockerHandsConfiguration,
  cwd: string,
): void {
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
  ) {
    this.id = `docker:${configuration.containerId}`;
    this.generation = configuration.generation;
    this.shell = configuration.shell;
    this.resourceProjectionDirectory = configuration.resources;
    this.resourceProjectionReceipt = projectionReceipt;
  }

  /** Validate actual containment before resources or native scheduling, retaining one exclusive lease. */
  public static async create(
    configuration: DockerHandsConfiguration,
    store: RunStore,
    brainRoots: readonly string[],
  ): Promise<DockerExecutionBackend> {
    const workspace = store.manifest().workspace;
    const cwd = validateDockerProfile(
      configuration,
      await inspect(configuration),
      workspace,
      brainRoots,
    );
    const leaseRoot = join(
      brainRoots[1] ?? store.runDir,
      ".hands-leases",
      configuration.containerId,
    );
    mkdirSync(leaseRoot, { recursive: true });
    const release = acquireStateRootLease(leaseRoot);
    try {
      recordBinding(store, configuration, cwd);
      return new DockerExecutionBackend(
        configuration,
        cwd,
        workspace,
        brainRoots,
        release,
        join(
          brainRoots[1] ?? store.runDir,
          ".hands-projections",
          createHash("sha256").update(configuration.resources).digest("hex"),
          "receipt.json",
        ),
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
      this.assertAvailable(context);
      await this.validateLive(context);
      const raw = await runDocker(dockerArguments(this.configuration, this.cwd), input);
      this.assertAvailable(context);
      const value: unknown = JSON.parse(raw);
      return value;
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

  private admit(request: HandsRequest, context: Context): string {
    this.assertAvailable(context);
    if (this.joins.size >= 8) {
      throw new SeptError("Hands backend is at capacity");
    }
    if (request.kind === "tool" && request.name === "bash" && !this.shell) {
      throw new SeptError("Shell capability is absent");
    }
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > HANDS_REQUEST_BYTES) {
      throw new SeptError("Hands request exceeds its bound");
    }
    return input;
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
    const before = handsRecord(await inspect(this.configuration));
    const stateBefore = handsRecord(before.State);
    // A consumer restart can reuse the container ID. Stale authority cannot kill that generation.
    if (stateBefore.Running === true && stateBefore.StartedAt !== this.generation) {
      throw new SeptError("Hands shutdown authority belongs to another generation");
    }
    try {
      await runDocker(["kill", this.configuration.containerId], "", 1024);
    } catch {
      /* Already-stopped backend still needs a trustworthy stopped-state receipt. */
    }
    const inspected = handsRecord(await inspect(this.configuration));
    const state = handsRecord(inspected.State);
    if (state.Running !== false || state.Pid !== 0) {
      throw new SeptError("Hands descendant shutdown could not be verified");
    }
  }

  /** Close every owned transport before releasing authority; the consumer owns restart/removal. */
  public async close(): Promise<void> {
    this.unavailable = true;
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
