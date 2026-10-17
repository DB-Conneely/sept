/** Exact Engine, setup label, image and kernel lifetime checks precede every setup finalizer. */
import { join } from "node:path";
import { atomicWrite, SeptError } from "../durable/index.js";
import {
  DockerEngineControl,
  captureNamespaceLifetime,
  stopCapturedNamespace,
  parseNamespaceLifetime,
  type DockerHandsConfiguration,
} from "../execution/index.js";
import { handsDocker } from "./hands-docker.js";
import { readHandsMetadata, writeHandsReceipt, type HandsReceipt } from "./hands-record.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Hands setup inspection is malformed");
  }
  return value;
}

/** Open the originally captured socket/daemon only; ambient context and replacement daemons refuse. */
export async function openHandsEngine(receipt: HandsReceipt): Promise<DockerEngineControl> {
  const engine = await DockerEngineControl.open(receipt.engineSocket);
  if (engine.socketIdentity !== receipt.socketIdentity || engine.daemonId !== receipt.daemonId) {
    await engine.close();
    throw new SeptError("Hands setup Engine ownership changed");
  }
  return engine;
}

/** A pre-create receipt can recover only its unique setup-labelled container, never a foreign name. */
export async function inspectHandsOwner(
  root: string,
  receipt: HandsReceipt,
  engine: DockerEngineControl,
): Promise<Record<string, unknown>> {
  const containerId =
    receipt.containerId ??
    handsDocker(root, receipt, ["inspect", "--format", "{{.Id}}", `sept-hands-${receipt.owner}`]);
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    throw new SeptError("Hands setup container identity is malformed");
  }
  const inspected = record(await engine.inspect(containerId));
  const labels = record(record(inspected.Config).Labels);
  const state = record(inspected.State);
  if (
    labels["sept.setup.owner"] !== receipt.owner ||
    inspected.Image !== receipt.image ||
    inspected.Id !== containerId ||
    (receipt.generation !== undefined && state.StartedAt !== receipt.generation)
  ) {
    throw new SeptError("Hands setup container ownership or generation changed");
  }
  receipt.containerId = containerId;
  writeHandsReceipt(root, receipt);
  return state;
}

/** Capture the native pinned stop receipt before granting the first permission revision. */
export async function captureHandsOwner(
  root: string,
  receipt: HandsReceipt,
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<void> {
  const lifetime = await captureNamespaceLifetime(configuration, engine);
  atomicWrite(join(root, "evidence", "lifetime.json"), lifetime);
  receipt.phase = "running";
  writeHandsReceipt(root, receipt);
}

/** Stop only the captured namespace lifetime, independently verifying stopped/PID0 after helper teardown. */
export async function stopHandsOwner(
  root: string,
  receipt: HandsReceipt,
  engine: DockerEngineControl,
): Promise<void> {
  const state = await inspectHandsOwner(root, receipt, engine);
  if (state.Running === false && state.Pid === 0) {
    return;
  }
  if (receipt.containerId === undefined || receipt.generation === undefined) {
    throw new SeptError("Hands generation was not captured; manual reconciliation required");
  }
  const path = join(root, "evidence", "lifetime.json");
  const raw = readHandsMetadata(path, 1024);
  const lifetime = parseNamespaceLifetime(raw);
  try {
    await stopCapturedNamespace(
      { containerId: receipt.containerId, generation: receipt.generation },
      lifetime,
      engine,
    );
  } catch {
    // A successful pinned namespace stop also tears down its own helper; closure decides success.
  }
  await verifyStopped(root, receipt, engine);
}

async function verifyStopped(
  root: string,
  receipt: HandsReceipt,
  engine: DockerEngineControl,
): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const state = await inspectHandsOwner(root, receipt, engine);
    if (state.Running === false && state.Pid === 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new SeptError("Hands setup shutdown could not be verified");
}
