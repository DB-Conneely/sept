import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULTS, SeptError, type Manifest } from "../durable/index.js";

export const TASK_KEYS = ["maxEpochs", "maxInvocations", "model", "provider", "role", "task", "thinking", "timeoutSeconds", "workspace"] as const;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function assertKnownKeys(input: Record<string, unknown>, expected: readonly string[], name: string): void {
  if (Object.keys(input).some((key) => !expected.includes(key))) throw new SeptError(`${name} has unexpected fields`);
}

function safeText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || UNSAFE_CONTROLS.test(value) || (!allowEmpty && !value.trim())) {
    throw new SeptError(`${name} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maximum} characters without unsafe control characters`);
  }
  return value;
}

function canonicalDirectory(path: string, name: string): string {
  let canonical: string;
  try { canonical = realpathSync(resolve(path)); }
  catch { throw new SeptError(`${name} does not exist`); }
  try { if (!statSync(canonical).isDirectory()) throw new SeptError(`${name} must be a directory`); }
  catch (error) {
    if (error instanceof SeptError) throw error;
    throw new SeptError(`${name} must be a directory`);
  }
  return canonical;
}

export function canonicalWorkspaceRoot(path: string): string {
  return canonicalDirectory(path, "workspace root");
}

export function validateOperatorMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768 || UNSAFE_CONTROLS.test(value)) {
    throw new SeptError("message must contain 1-32768 characters without unsafe control characters");
  }
  return value;
}

export function validateMessageBody(value: unknown): string {
  const input = record(value, "message request");
  if (Object.keys(input).length !== 1 || !("message" in input)) throw new SeptError("message request has unexpected or missing fields");
  return validateOperatorMessage(input.message);
}

export function validateRequest(value: unknown, piVersion: string, workspaceRoot?: string, selected?: { provider: string; model: string }): Omit<Manifest, "runId" | "createdAt"> {
  const input = record(value, "task request");
  assertKnownKeys(input, TASK_KEYS, "task request");
  const task = safeText(input.task, "task", 32_768);
  const role = input.role === undefined ? "" : safeText(input.role, "role", 4096, true);
  if ((input.provider === undefined) !== (input.model === undefined)) throw new SeptError("provider and model must be selected together");
  for (const field of ["workspace", "provider", "model"] as const) {
    const fieldValue = input[field];
    if (fieldValue !== undefined) {
      const text = safeText(fieldValue, field, 4096);
      if (text !== text.trim()) throw new SeptError(`${field} must not have leading or trailing whitespace`);
    }
  }
  if (input.thinking !== undefined && !(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as unknown[]).includes(input.thinking)) throw new SeptError("thinking is invalid");

  const canonicalRoot = workspaceRoot === undefined ? undefined : canonicalWorkspaceRoot(workspaceRoot);
  const requestedWorkspace = input.workspace === undefined ? canonicalRoot ?? process.cwd() : input.workspace as string;
  const workspace = canonicalDirectory(requestedWorkspace, "workspace");
  if (canonicalRoot !== undefined) {
    const child = relative(canonicalRoot, workspace);
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new SeptError("workspace is outside the configured workspace root");
  }

  const maxInvocations = boundedNumber(input.maxInvocations, DEFAULTS.maxInvocations, "maxInvocations", 1, 10000);
  const maxEpochs = boundedNumber(input.maxEpochs, DEFAULTS.maxEpochs, "maxEpochs", 1, 1000);
  const timeoutSeconds = boundedNumber(input.timeoutSeconds, DEFAULTS.timeoutSeconds, "timeoutSeconds", 1, 604800);
  return {
    formatVersion: 3,
    task,
    role,
    workspace,
    provider: input.provider as string | undefined ?? selected?.provider ?? DEFAULTS.provider,
    model: input.model as string | undefined ?? selected?.model ?? DEFAULTS.model,
    thinking: input.thinking as Manifest["thinking"] | undefined ?? DEFAULTS.thinking,
    maxInvocations,
    maxEpochs,
    timeoutSeconds,
    piVersion,
  };
}

function boundedNumber(value: unknown, fallback: number, name: string, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isFinite(result) || !Number.isInteger(result) || result < min || result > max) throw new SeptError(`${name} must be an integer from ${min} to ${max}`);
  return result;
}
