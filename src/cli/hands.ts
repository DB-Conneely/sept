/** Optional local setup composition; the existing worker and policy authority remain unchanged. */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { acquireStateRootLease, atomicWrite, SeptError } from "../durable/index.js";
import { DockerEngineControl, loadHandsConfiguration } from "../execution/index.js";
import { finishHands } from "./hands-finish.js";
import { runPermissions } from "./permissions.js";
import type { CliInvocation } from "./options.js";
import {
  createHandsRoot,
  handsPaths,
  newHandsOwner,
  trustedHandsRoot,
  writeHandsReceipt,
  type HandsReceipt,
} from "./hands-record.js";
import { createHandsArguments, handsDocker } from "./hands-docker.js";
import { captureHandsOwner, inspectHandsOwner, stopHandsOwner } from "./hands-owner.js";

/** Execute the two installed operator commands; signals join cleanup before the process exits. */
export async function runHands(invocation: CliInvocation): Promise<unknown> {
  if (invocation.action !== "init" && invocation.action !== "finish") {
    throw new SeptError("Usage: sept hands init|finish --root <absolute-new-instance>");
  }
  const abort = new AbortController();
  const cancel = (): void => {
    abort.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    return invocation.action === "init"
      ? await initialize(invocation.options, abort.signal)
      : await finishHands(invocation.options);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SeptError("Hands setup cancelled; ownership and recovery receipts retained");
  }
}

async function initialize(options: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const root = trustedHandsRoot(options.root, true);
  if (options.access !== "files" && options.access !== "none") {
    throw new SeptError("hands init requires explicit --access files|none");
  }
  if (
    options.image === undefined ||
    options.image.length > 512 ||
    options.image.startsWith("-") ||
    options["engine-socket"] === undefined
  ) {
    throw new SeptError("hands init requires --image and explicit local --engine-socket");
  }
  const engine = await DockerEngineControl.open(options["engine-socket"]);
  try {
    assertNotCancelled(signal);
    createHandsRoot(root);
    return await initializeOwned(root, options, engine, signal);
  } finally {
    await engine.close();
  }
}

async function initializeOwned(
  root: string,
  options: Record<string, string>,
  engine: DockerEngineControl,
  signal: AbortSignal,
): Promise<unknown> {
  const release = acquireStateRootLease(join(root, "evidence"));
  const receipt = initialReceipt(options, engine);
  try {
    writeHandsReceipt(root, receipt);
    resolveImage(root, receipt, options.image ?? "");
    await createContainer(root, receipt, engine, signal);
    await activatePermissions(root, options.access === "files");
    assertNotCancelled(signal);
    receipt.phase = "ready";
    writeHandsReceipt(root, receipt);
    return {
      ...handsPaths(root),
      containerId: receipt.containerId,
      generation: receipt.generation,
      access: options.access,
    };
  } catch (error: unknown) {
    await initializationFailure(root, receipt, engine);
    throw new SeptError("Hands initialization failed; recovery evidence retained under --root", {
      cause: error,
    });
  } finally {
    release();
  }
}

function resolveImage(root: string, receipt: HandsReceipt, imageName: string): void {
  const image = handsDocker(root, receipt, ["image", "inspect", "--format", "{{.Id}}", imageName]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    throw new SeptError("Hands image must already be locally available with immutable identity");
  }
  receipt.image = image;
}

function initialReceipt(
  options: Record<string, string>,
  engine: DockerEngineControl,
): HandsReceipt {
  return {
    version: 1,
    owner: newHandsOwner(),
    engineSocket: realpathSync(options["engine-socket"] ?? ""),
    socketIdentity: engine.socketIdentity,
    daemonId: engine.daemonId,
    image: `sha256:${"0".repeat(64)}`,
    phase: "prepared",
  };
}

async function createContainer(
  root: string,
  receipt: HandsReceipt,
  engine: DockerEngineControl,
  signal: AbortSignal,
): Promise<void> {
  receipt.phase = "creating";
  writeHandsReceipt(root, receipt);
  receipt.containerId = handsDocker(root, receipt, createHandsArguments(root, receipt));
  await inspectHandsOwner(root, receipt, engine);
  assertNotCancelled(signal);
  handsDocker(root, receipt, ["start", receipt.containerId]);
  const state = await inspectHandsOwner(root, receipt, engine);
  if (typeof state.StartedAt !== "string" || state.Running !== true) {
    throw new SeptError("Hands start generation was not established");
  }
  receipt.generation = state.StartedAt;
  writeHandsReceipt(root, receipt);
  const paths = handsPaths(root);
  atomicWrite(paths.handsConfigurationPath, {
    profile: "docker-linux-warm-v1",
    engineSocket: receipt.engineSocket,
    containerId: receipt.containerId,
    generation: receipt.generation,
    workspace: paths.workspaceRoot,
    resources: join(root, "resources"),
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    shell: false,
    readOnlyMounts: [],
  });
  await captureHandsOwner(
    root,
    receipt,
    loadHandsConfiguration(paths.handsConfigurationPath),
    engine,
  );
  assertNotCancelled(signal);
}

async function activatePermissions(root: string, files: boolean): Promise<void> {
  const paths = handsPaths(root);
  const policy = join(root, "evidence", "initial-policy.json");
  atomicWrite(policy, {
    mode: "scoped",
    workspace: { read: files, write: files },
    selected: [],
    execute: false,
    network: false,
  });
  await runPermissions(
    {
      command: "permissions",
      action: "set",
      options: { hands: paths.handsConfigurationPath, policy, revision: "0" },
    },
    paths.stateRoot,
    paths.agentDir,
  );
}

async function initializationFailure(
  root: string,
  receipt: HandsReceipt,
  engine: DockerEngineControl,
): Promise<void> {
  let stopped = receipt.phase === "prepared";
  try {
    if (!stopped) {
      await stopHandsOwner(root, receipt, engine);
      stopped = true;
    }
  } catch {
    // Unknown ownership never authorizes a broader stop; retain evidence for explicit reconciliation.
  } finally {
    receipt.phase = "failed";
    writeHandsReceipt(root, receipt);
    atomicWrite(join(root, "evidence", "initialization-failure.json"), {
      stopped,
      reconciliationRequired: !stopped,
    });
  }
}
