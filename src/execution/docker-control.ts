/** Kernel qualification and exact-generation ownership over the one explicit Engine control port. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireStateRootLease, atomicWrite, type RunStore, SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration, EngineExec, NamespaceLifetime } from "./contracts.js";
import { DockerEngineControl } from "./docker-engine.js";
import { handsRecord } from "./protocol.js";
import { validateNetworkEnforcement } from "./network-enforcement.js";
import { validateDockerProfile, kernelProfile, recordKernelProfile } from "./profile.js";
import {
  qualifyCapabilityEngine,
  readBoundedHandsRecord as readBinding,
  recordNamespaceLifetime,
  readNamespaceLifetime,
  namespaceLifetimePath,
} from "./profile-configuration.js";
import {
  captureNamespaceLifetime,
  stopCapturedNamespace,
  guardedCommand,
  validateSealedInputs,
} from "./hands-processes.js";
export { qualifyCapabilityEngine } from "./profile-configuration.js";
/** Exact credential-free cold entry; model data never becomes Engine command/environment selection. */
export function handsExecution(
  cwd: string,
  input: string,
  rights: { network: boolean },
): EngineExec {
  return {
    cwd,
    input,
    command: guardedCommand(["/app/dist/src/execution/hands-entry.js"], rights),
  };
}
/** Read bounded kernel/namespace facts from the already authenticated daemon. */
export function inspect(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
): Promise<unknown> {
  return engine.inspect(configuration.containerId);
}
/** New default authority qualifies its daemon without probing profile/control ports before worker bind. */
export async function initializeCapabilityEngine(
  configuration: DockerHandsConfiguration,
  policyPath: string,
): Promise<void> {
  const engine = await DockerEngineControl.open(configuration.engineSocket);
  try {
    qualifyCapabilityEngine(engine, policyPath, { initialize: true });
  } finally {
    await engine.close();
  }
}
/** Validate kernel profile without acquiring native task authority; temporary connections always close. */
export async function validateDockerConfiguration(
  configuration: DockerHandsConfiguration,
  brainRoots: readonly string[],
  workspace = configuration.workspace,
  controlEndpoint?: { address: string; port: number },
  authority?: { policyPath: string; initialize: boolean },
  supplied?: DockerEngineControl,
): Promise<string> {
  const engine = supplied ?? (await DockerEngineControl.open(configuration.engineSocket));
  try {
    if (authority !== undefined) {
      qualifyCapabilityEngine(engine, authority.policyPath, authority);
    }
    const inspected = await inspect(configuration, engine);
    const cwd = validateDockerProfile(configuration, inspected, workspace, brainRoots);
    await validateNetworkEnforcement(configuration, inspected, controlEndpoint, engine);
    await qualifyKernelProfile(configuration, inspected, engine);
    if (authority !== undefined) {
      recordKernelProfile(
        configuration,
        authority.policyPath,
        kernelProfile(configuration, inspected),
      );
      const lifetime = await captureNamespaceLifetime(configuration, engine);
      recordNamespaceLifetime(configuration, engine, authority.policyPath, lifetime);
    }
    return cwd;
  } finally {
    if (supplied === undefined) {
      await engine.close();
    }
  }
}
/** Fixed kernel checks compare real cgroup v2 caps/tmpfs capacity, rather than accepting inspect promises. */
export async function qualifyKernelProfile(
  configuration: DockerHandsConfiguration,
  inspected: unknown,
  engine: DockerEngineControl,
): Promise<void> {
  const expected = kernelProfile(configuration, inspected);
  const script = `const fs = require('node:fs');
const expected = JSON.parse(process.argv[1]);
const read = name => fs.readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim();
const cpu = read('cpu.max').split(' ').map(Number);
const mount = fs.statfsSync('/workspace');
const workspace = fs.statSync('/workspace');
if (expected.dataDomain === 'private' && (workspace.uid !== 10002 || workspace.gid !== 10002 || (workspace.mode & 0o7777) !== 0o2770)) process.exit(126);
const actual = { memory: Number(read('memory.max')), pids: Number(read('pids.max')), nanoCpus: cpu[0] * 1e9 / cpu[1] };
if (actual.memory !== expected.memory || actual.pids !== expected.pids || actual.nanoCpus !== expected.nanoCpus) process.exit(126);
if (expected.dataDomain === 'private' && (mount.type !== 0x01021994 || mount.blocks * mount.bsize !== expected.workspaceLimits.bytes || mount.files !== expected.workspaceLimits.inodes)) process.exit(126);
process.stdout.write('qualified');`;
  const result = await engine.exec(configuration.containerId, {
    command: guardedCommand(["--eval", script, JSON.stringify(expected)]),
    maximum: 1024,
  });
  if (result !== "qualified") {
    throw new SeptError("Hands actual cgroup/tmpfs capacity is unsupported");
  }
  await validateSealedInputs(configuration, engine);
}

/** Stop and verify only exact persisted authority; a replaced generation is never touched, even if stopped. */
export async function revokeDockerBinding(
  binding: { containerId: string; generation: string },
  configuration: Pick<DockerHandsConfiguration, "engineSocket">,
  authority?: { policyPath: string },
  supplied?: DockerEngineControl,
): Promise<void> {
  const engine = supplied ?? (await DockerEngineControl.open(configuration.engineSocket));
  try {
    if (authority !== undefined) {
      qualifyCapabilityEngine(engine, authority.policyPath, { initialize: false });
    }
    const state = handsRecord(handsRecord(await engine.inspect(binding.containerId)).State);
    if (state.StartedAt !== binding.generation) {
      throw new SeptError("Revocation requires reconciliation of the changed backend generation");
    }
    if (state.Running === true) {
      if (authority === undefined) {
        throw new SeptError("Exact namespace lifetime receipt is required");
      }
      const lifetime = readNamespaceLifetime(binding, engine, authority.policyPath);
      await stopAndVerify(binding, lifetime, engine);
    } else {
      await verifyNamespaceClosed(binding, engine);
    }
  } finally {
    if (supplied === undefined) {
      await engine.close();
    }
  }
}
/** A consumer restart replaces kernel identity; stale authority cannot stop that fresh generation. */
export async function reconcileDockerBinding(
  previous: { containerId: string; generation: string },
  next: DockerHandsConfiguration,
  authority?: { policyPath: string },
  supplied?: DockerEngineControl,
): Promise<void> {
  if (previous.containerId !== next.containerId) {
    return revokeDockerBinding(previous, next, authority, supplied);
  }
  if (previous.generation === next.generation) {
    throw new SeptError("Reconciliation requires a fresh namespace generation");
  }
  const engine = supplied ?? (await DockerEngineControl.open(next.engineSocket));
  try {
    if (authority !== undefined) {
      qualifyCapabilityEngine(engine, authority.policyPath, { initialize: false });
    }
    const state = handsRecord(handsRecord(await engine.inspect(next.containerId)).State);
    if (state.Running !== true || state.StartedAt !== next.generation) {
      throw new SeptError("Fresh consumer namespace generation could not be reconciled");
    }
  } finally {
    if (supplied === undefined) {
      await engine.close();
    }
  }
}
/** Persist qualified namespace/daemon ownership before scheduling; prior uncertainty joins first. */
export async function recordHandsBinding(
  store: RunStore,
  configuration: DockerHandsConfiguration,
  cwd: string,
  engine: DockerEngineControl,
): Promise<void> {
  const path = join(store.runDir, "hands-binding.json");
  const policyPath = join(dirname(store.runDir), "capability-policy.json");
  if (existsSync(path)) {
    const binding = readBinding(path);
    if (typeof binding.containerId !== "string" || typeof binding.generation !== "string") {
      throw new SeptError("Previous hands binding is malformed");
    }
    // Old records remain readable but cannot authenticate a newly selected control daemon.
    if (binding.daemonId !== engine.daemonId || binding.socketIdentity !== engine.socketIdentity) {
      throw new SeptError("Previous hands Engine receipt is absent or incompatible");
    }
    await reconcileDockerBinding(
      { containerId: binding.containerId, generation: binding.generation },
      configuration,
      { policyPath },
      engine,
    );
  }
  atomicWrite(path, {
    kernel: readBinding(
      join(namespaceLifetimePath(policyPath, configuration), "..", "kernel.json"),
    ),
    profile: configuration.profile,
    containerId: configuration.containerId,
    generation: configuration.generation,
    daemonId: engine.daemonId,
    socketIdentity: engine.socketIdentity,
    cwd,
    runId: store.runId,
    lifetime: readNamespaceLifetime(configuration, engine, policyPath),
  });
}

/** The dedicated namespace lease is acquired only after kernel qualification, before binding/scheduling. */
export function acquireHandsLease(
  configuration: DockerHandsConfiguration,
  store: RunStore,
  brainRoots: readonly string[],
): () => void {
  return acquireStateRootLease(
    join(brainRoots[1] ?? store.runDir, ".hands-leases", configuration.containerId),
  );
}

/** Restart cleanup uses captured authenticated control facts, never ambient current configuration. */
export async function revokeRecordedHandsBinding(
  store: RunStore,
  expected: { containerId: string; generation: string },
): Promise<void> {
  const binding = readBinding(join(store.runDir, "hands-binding.json"));
  if (
    binding.containerId !== expected.containerId ||
    binding.generation !== expected.generation ||
    typeof binding.socketIdentity !== "string" ||
    typeof binding.daemonId !== "string"
  ) {
    throw new SeptError("Captured hands Engine receipt is absent or incompatible");
  }
  let socket: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(binding.socketIdentity);
    socket = handsRecord(value);
  } catch {
    throw new SeptError("Captured hands Engine socket receipt is malformed");
  }
  if (typeof socket.path !== "string") {
    throw new SeptError("Captured hands Engine socket receipt is malformed");
  }
  const engine = await DockerEngineControl.open(socket.path);
  try {
    if (engine.socketIdentity !== binding.socketIdentity || engine.daemonId !== binding.daemonId) {
      throw new SeptError("Captured hands Engine identity changed");
    }
    await revokeDockerBinding(
      expected,
      { engineSocket: socket.path },
      {
        policyPath: join(dirname(store.runDir), "capability-policy.json"),
      },
      engine,
    );
  } finally {
    await engine.close();
  }
}

async function verifyNamespaceClosed(
  binding: { containerId: string; generation: string },
  engine: DockerEngineControl,
): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const state = handsRecord(handsRecord(await engine.inspect(binding.containerId)).State);
    if (state.StartedAt !== binding.generation) {
      throw new SeptError("Capability revocation encountered a replacement generation");
    }
    if (state.Running === false && state.Pid === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new SeptError("Capability revocation shutdown could not be verified");
}

async function stopAndVerify(
  binding: { containerId: string; generation: string },
  lifetime: NamespaceLifetime,
  engine: DockerEngineControl,
): Promise<void> {
  let stopFailure: unknown;
  try {
    await stopCapturedNamespace(binding, lifetime, engine);
  } catch (error: unknown) {
    // Namespace teardown can terminate the helper. Verify closure before classifying success.
    stopFailure = error;
  }
  try {
    await verifyNamespaceClosed(binding, engine);
  } catch (error: unknown) {
    throw new SeptError("Capability revocation shutdown could not be verified", {
      cause: stopFailure ?? error,
    });
  }
}
