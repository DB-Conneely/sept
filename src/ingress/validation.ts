/**
 * Validates hostile task and operator-message input at the ingress boundary. This module owns
 * schema, text, numeric, and workspace-confinement checks; downstream runtime code receives only
 * canonical paths and bounded domain values.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep, posix } from "node:path";
import {
  DEFAULTS,
  SeptError,
  type Manifest,
  type RunStore,
  type RunEvent,
  type RunSnapshot,
} from "../durable/index.js";
import { ModelAccessService } from "../model-access/index.js";

/** Exact fields accepted by direct and webhook task admission. */
export const TASK_KEYS = [
  "maxEpochs",
  "maxInvocations",
  "model",
  "provider",
  "role",
  "task",
  "thinking",
  "timeoutSeconds",
  "workspace",
] as const;

const THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

interface ValidatedTextFields {
  task: string;
  role: string;
  provider?: string;
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError(`${name} must be an object`);
  }
  return value;
}

function assertKnownKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  if (Object.keys(input).some((key) => !expected.includes(key))) {
    throw new SeptError(`${name} has unexpected fields`);
  }
}

function safeText(value: unknown, name: string, maximum: number): string {
  const invalidText =
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    UNSAFE_CONTROLS.test(value);
  if (invalidText) {
    throw new SeptError(
      `${name} must be a non-empty string of at most ${String(maximum)} characters without unsafe control characters`,
    );
  }
  return value;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = safeText(value, name, 4096);
  if (text !== text.trim()) {
    throw new SeptError(`${name} must not have leading or trailing whitespace`);
  }
  return text;
}

function optionalRole(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.length > 4096 || UNSAFE_CONTROLS.test(value)) {
    throw new SeptError(
      "role must be a string of at most 4096 characters without unsafe control characters",
    );
  }
  return value;
}

function validateTextFields(input: Record<string, unknown>): ValidatedTextFields {
  const provider = optionalIdentifier(input.provider, "provider");
  const model = optionalIdentifier(input.model, "model");
  if ((provider === undefined) !== (model === undefined)) {
    throw new SeptError("provider and model must be selected together");
  }
  return {
    task: safeText(input.task, "task", 32_768),
    role: optionalRole(input.role),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}

function canonicalDirectory(path: string, name: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
  } catch {
    throw new SeptError(`${name} does not exist`);
  }
  try {
    if (!statSync(canonical).isDirectory()) {
      throw new SeptError(`${name} must be a directory`);
    }
  } catch (error) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError(`${name} must be a directory`, { cause: error });
  }
  return canonical;
}

/** Canonicalize the configured workspace authority before accepting any task paths. */
export function canonicalWorkspaceRoot(path: string): string {
  return canonicalDirectory(path, "workspace root");
}

function validateWorkspace(value: unknown, workspaceRoot?: string): string {
  const canonicalRoot =
    workspaceRoot === undefined ? undefined : canonicalWorkspaceRoot(workspaceRoot);
  const requested =
    value === undefined ? (canonicalRoot ?? process.cwd()) : optionalIdentifier(value, "workspace");
  if (requested === undefined) {
    throw new SeptError("workspace is required");
  }
  const workspace = canonicalDirectory(requested, "workspace");
  if (canonicalRoot === undefined) {
    return workspace;
  }

  // Canonical paths, not caller spelling, determine confinement so symlinks cannot escape.
  const child = relative(canonicalRoot, workspace);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new SeptError("workspace is outside the configured workspace root");
  }
  return workspace;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : value;
  const valid =
    typeof result === "number" &&
    Number.isFinite(result) &&
    Number.isInteger(result) &&
    result >= minimum &&
    result <= maximum;
  if (!valid) {
    throw new SeptError(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return result;
}

function thinkingValue(value: unknown): Manifest["thinking"] {
  if (value === undefined) {
    return DEFAULTS.thinking;
  }
  const matched = THINKING_VALUES.find((candidate) => candidate === value);
  if (matched === undefined) {
    throw new SeptError("thinking is invalid");
  }
  return matched;
}

/** Preserve accepted operator text exactly while rejecting empty, unsafe, or oversized input. */
export function validateOperatorMessage(value: unknown): string {
  const invalidMessage =
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 32_768 ||
    UNSAFE_CONTROLS.test(value);
  if (invalidMessage) {
    throw new SeptError(
      "message must contain 1-32768 characters without unsafe control characters",
    );
  }
  return value;
}

/** Validate the exact direct-message request envelope and return its preserved text. */
export function validateMessageBody(value: unknown): string {
  const input = requestRecord(value, "message request");
  if (Object.keys(input).length !== 1 || !("message" in input)) {
    throw new SeptError("message request has unexpected or missing fields");
  }
  return validateOperatorMessage(input.message);
}

/**
 * Validate a hostile task request into the durable manifest fields owned by admission.
 * Workspace paths are canonical and confined before the runtime can observe them.
 */
export function validateRequest(
  value: unknown,
  piVersion: string,
  workspaceRoot?: string,
): Omit<Manifest, "runId" | "createdAt"> {
  const input = requestRecord(value, "task request");
  assertKnownKeys(input, TASK_KEYS, "task request");
  const text = validateTextFields(input);
  return {
    formatVersion: 3,
    task: text.task,
    role: text.role,
    workspace: validateWorkspace(input.workspace, workspaceRoot),
    provider: text.provider ?? DEFAULTS.provider,
    model: text.model ?? DEFAULTS.model,
    thinking: thinkingValue(input.thinking),
    maxInvocations: boundedNumber(
      input.maxInvocations,
      DEFAULTS.maxInvocations,
      "maxInvocations",
      1,
      10_000,
    ),
    maxEpochs: boundedNumber(input.maxEpochs, DEFAULTS.maxEpochs, "maxEpochs", 1, 1000),
    timeoutSeconds: boundedNumber(
      input.timeoutSeconds,
      DEFAULTS.timeoutSeconds,
      "timeoutSeconds",
      1,
      604_800,
    ),
    piVersion,
  };
}

/** Resolve model policy only after schema and workspace admission have succeeded. */
export async function resolveTaskManifest(
  value: unknown,
  piVersion: string,
  modelAccess: ModelAccessService,
  workspaceRoot?: string,
): Promise<Omit<Manifest, "runId" | "createdAt">> {
  const validated = validateRequest(value, piVersion, workspaceRoot);
  const input = requestRecord(value, "task request");
  const explicit =
    input.provider === undefined
      ? undefined
      : { provider: validated.provider, model: validated.model };
  const resolved = modelAccess.resolveSelection(explicit);
  const preflight = await modelAccess.preflightSelection(
    resolved.provider,
    resolved.model,
    resolved.source,
    AbortSignal.timeout(15_000),
  );
  return {
    ...validated,
    provider: preflight.selected.provider,
    model: preflight.selected.model,
  };
}

function publicWorkspace(store: RunStore): string {
  const path = join(store.runDir, "hands-binding.json");
  if (!existsSync(path)) {
    return "/workspace";
  }
  if (statSync(path).size > 16 * 1024) {
    throw new SeptError("Hands namespace metadata exceeds its bound");
  }
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const input = requestRecord(value, "hands namespace");
  if (
    typeof input.cwd !== "string" ||
    (input.cwd !== "/workspace" && !input.cwd.startsWith("/workspace/")) ||
    posix.normalize(input.cwd) !== input.cwd ||
    input.cwd.length > 4096 ||
    UNSAFE_CONTROLS.test(input.cwd)
  ) {
    throw new SeptError("Hands namespace metadata is invalid");
  }
  return input.cwd;
}

function publicSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    ...(snapshot.activeSessionFile === undefined
      ? {}
      : { activeSessionFile: `<pi-session>/${basename(snapshot.activeSessionFile)}` }),
    ...(snapshot.predecessorSessionFile === undefined
      ? {}
      : { predecessorSessionFile: `<pi-session>/${basename(snapshot.predecessorSessionFile)}` }),
  };
}

/** Authenticated metadata exposes work aliases; private admission/history files retain their original paths. */
export function publicTaskProjection(store: RunStore): { manifest: Manifest; state: RunSnapshot } {
  return {
    manifest: { ...store.manifest(), workspace: publicWorkspace(store) },
    state: publicSnapshot(store.snapshot()),
  };
}

/** Project known internal locator fields without modifying exact operator text or persisted recovery facts. */
export function publicRunEvent(event: RunEvent): RunEvent {
  const result = { ...event };
  for (const key of [
    "sessionFile",
    "predecessorFile",
    "successorFile",
    "predecessorSessionFile",
    "successorSessionFile",
  ]) {
    const path = event[key];
    if (typeof path === "string") {
      result[key] = `<pi-session>/${basename(path)}`;
    }
  }
  return result;
}
