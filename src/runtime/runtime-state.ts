/**
 * Centralizes runtime-only lifecycle patching and execution limits. Durable storage remains the
 * authority that validates and fsyncs every patch; this module permits explicit clearing of optional
 * snapshot fields and measures only active invocation time, never dormant wall-clock age.
 */

import {
  SeptError,
  type Manifest,
  type OperatorMessage,
  type RunSnapshot,
  type RunStore,
  parseJsonObject,
  validateHandover,
  validateWorkResponse,
} from "../durable/index.js";
import type {
  SessionHost,
  SessionRunResult,
  ValidatedSessionResponse,
} from "../pi-integration/index.js";

type RuntimeSnapshotPatch = {
  [Key in keyof RunSnapshot]?: RunSnapshot[Key] | undefined;
};

/** Apply a runtime transition, allowing optional durable fields to be explicitly cleared. */
export function updateRuntimeSnapshot(store: RunStore, patch: RuntimeSnapshotPatch): RunSnapshot {
  // RunStore validates the merged snapshot before persistence.
  // CAST: Undefined is admitted only to clear optional fields that Partial cannot express exactly.
  return store.update(patch as Partial<RunSnapshot>);
}

/** Classified configured-capacity failure that runtime converts to a blocked terminal outcome. */
export class RuntimeLimitError extends SeptError {
  public constructor(
    public override readonly cause: "invocation_limit" | "epoch_limit" | "timeout",
    message: string,
  ) {
    super(message);
  }
}

/** Fail before creating another native session when the configured epoch capacity is exhausted. */
export function enforceEpochLimit(manifest: Manifest, snapshot: RunSnapshot): void {
  if (snapshot.epoch >= manifest.maxEpochs) {
    throw new RuntimeLimitError(
      "epoch_limit",
      `Maximum Pi session epochs reached (${String(manifest.maxEpochs)})`,
    );
  }
}

/** Fail before another invocation when count or active-time capacity is exhausted. */
export function enforceInvocationLimits(manifest: Manifest, snapshot: RunSnapshot): void {
  if (snapshot.invocations >= manifest.maxInvocations) {
    throw new RuntimeLimitError(
      "invocation_limit",
      `Maximum Pi invocations reached (${String(manifest.maxInvocations)})`,
    );
  }
  if (snapshot.activeMilliseconds >= manifest.timeoutSeconds * 1000) {
    throw new RuntimeLimitError(
      "timeout",
      `Active execution timeout reached (${String(manifest.timeoutSeconds)}s)`,
    );
  }
}

/** Debit an interrupted active interval under the controller lease before native scheduling resumes. */
export function reconcileActiveDeadline(store: RunStore): void {
  const snapshot = store.snapshot();
  if (snapshot.activeStartedAt === undefined) {
    return;
  }
  // Death time is unknowable: charge the uncertain interval up to the hard budget, never waiting age.
  const elapsed = Math.max(0, Date.now() - snapshot.activeStartedAt);
  const remaining = Math.max(
    0,
    store.manifest().timeoutSeconds * 1000 - snapshot.activeMilliseconds,
  );
  updateRuntimeSnapshot(store, {
    activeMilliseconds: snapshot.activeMilliseconds + Math.min(elapsed, remaining),
    activeStartedAt: undefined,
  });
}

/** Run one native Pi invocation within remaining active time and durably add elapsed time. */
export async function runWithActiveDeadline(
  store: RunStore,
  host: SessionHost,
  prompt: string,
  manifest: Manifest,
  operatorMessages: readonly OperatorMessage[] = [],
): Promise<SessionRunResult> {
  const exhausted = store.snapshot().activeMilliseconds >= manifest.timeoutSeconds * 1000;
  if (exhausted) {
    return reuseExhaustedInvocation(host, prompt, operatorMessages);
  }
  const remaining = Math.max(
    1,
    manifest.timeoutSeconds * 1000 - store.snapshot().activeMilliseconds,
  );
  const started = Date.now();
  updateRuntimeSnapshot(store, { activeStartedAt: started });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new RuntimeLimitError(
            "timeout",
            `Active execution timeout reached (${String(manifest.timeoutSeconds)}s)`,
          ),
        );
      }, remaining);
    });
    return await Promise.race([
      host.run(prompt, operatorMessages, validateNativeResponse),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    settleActiveDeadline(store, started);
  }
}

function reuseExhaustedInvocation(
  host: SessionHost,
  prompt: string,
  messages: readonly OperatorMessage[],
): Promise<SessionRunResult> {
  if (host.recoveryInvocation === undefined) {
    throw new RuntimeLimitError("timeout", "Active execution timeout reached");
  }
  // Native dispatch checks the same durable budget; already-settled answers require no dispatch.
  return host.run(prompt, messages, validateNativeResponse);
}

function settleActiveDeadline(store: RunStore, started: number): void {
  const snapshot = store.snapshot();
  updateRuntimeSnapshot(store, {
    activeMilliseconds: snapshot.activeMilliseconds + Math.max(0, Date.now() - started),
    activeStartedAt: undefined,
  });
}

function validateNativeResponse(
  text: string,
  kind: "control" | "handover",
): ValidatedSessionResponse {
  return kind === "control"
    ? { kind, response: validateWorkResponse(parseJsonObject(text)) }
    : { kind, handover: validateHandover(parseJsonObject(text)) };
}
