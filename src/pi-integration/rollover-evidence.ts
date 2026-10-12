/**
 * Owns the validated, atomic rollover evidence file for one active native Pi session. Session
 * execution may update this evidence, but only this module parses hostile disk state and enforces
 * identity scoping, bounded growth history, and the irreversible rotation-required latch.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SeptError, atomicWrite, type RunStore } from "../durable/index.js";
import {
  GROWTH_HISTORY_LIMIT,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  decideRollover,
  type RolloverDecision,
} from "./rollover.js";

/** Maximum consecutive finalized assistant responses that may omit usable provider usage. */
export const MAX_UNUSABLE_USAGE_SAMPLES = 3;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Durable, session-scoped provider evidence that survives interruption without granting authority. */
export interface RolloverEvidence {
  formatVersion: 1;
  provider: string;
  model: string;
  sessionId: string;
  contextWindow: number;
  lastTokens?: number;
  growthTokens: number[];
  unusableSamples: number;
  rotationRequired: boolean;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validContextWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_CONTEXT_WINDOW &&
    value <= MAX_CONTEXT_WINDOW
  );
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SeptError("Durable rollover evidence is invalid");
  }
  const required = [
    "contextWindow",
    "formatVersion",
    "growthTokens",
    "model",
    "provider",
    "rotationRequired",
    "sessionId",
    "unusableSamples",
    "updatedAt",
  ];
  const allowed = new Set([...required, "lastTokens"]);
  const invalidKeys =
    required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key));
  if (invalidKeys) {
    throw new SeptError("Durable rollover evidence has invalid fields");
  }
  return value;
}

function safeScope(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_SCOPE.test(value) ? value : undefined;
}

function canonicalDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function positiveGrowth(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length > GROWTH_HISTORY_LIMIT) {
    return undefined;
  }
  const entries: unknown[] = value;
  const result: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return undefined;
    }
    result.push(entry);
  }
  return result;
}

function unusableSampleCount(value: unknown): number | undefined {
  return isNonnegativeInteger(value) && value <= MAX_UNUSABLE_USAGE_SAMPLES ? value : undefined;
}

function optionalLastTokens(value: unknown, contextWindow: number): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  const valid = Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= contextWindow;
  return valid ? Number(value) : null;
}

function identityFields(
  input: Record<string, unknown>,
): Pick<RolloverEvidence, "provider" | "model" | "sessionId"> {
  const provider = safeScope(input.provider);
  const model = safeScope(input.model);
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
  if (
    provider === undefined ||
    model === undefined ||
    sessionId === undefined ||
    sessionId.length < 1 ||
    sessionId.length > 4096
  ) {
    throw new SeptError("Durable rollover evidence is invalid");
  }
  return { provider, model, sessionId };
}

function stateFields(
  input: Record<string, unknown>,
): Omit<RolloverEvidence, "provider" | "model" | "sessionId" | "lastTokens"> {
  const contextWindow = validContextWindow(input.contextWindow) ? input.contextWindow : undefined;
  const growthTokens = positiveGrowth(input.growthTokens);
  const updatedAt = canonicalDate(input.updatedAt);
  const unusableSamples = unusableSampleCount(input.unusableSamples);
  if (
    input.formatVersion !== 1 ||
    contextWindow === undefined ||
    growthTokens === undefined ||
    unusableSamples === undefined ||
    typeof input.rotationRequired !== "boolean" ||
    updatedAt === undefined
  ) {
    throw new SeptError("Durable rollover evidence is invalid");
  }
  return {
    formatVersion: 1,
    contextWindow,
    growthTokens,
    unusableSamples,
    rotationRequired: input.rotationRequired,
    updatedAt,
  };
}

function evidenceFields(input: Record<string, unknown>): Omit<RolloverEvidence, "lastTokens"> {
  return { ...identityFields(input), ...stateFields(input) };
}

function validateEvidence(value: unknown): RolloverEvidence {
  const input = requiredRecord(value);
  const fields = evidenceFields(input);
  const lastTokens = optionalLastTokens(input.lastTokens, fields.contextWindow);
  if (lastTokens === null) {
    throw new SeptError("Durable rollover evidence is invalid");
  }
  return { ...fields, ...(lastTokens === undefined ? {} : { lastTokens }) };
}

function sameSession(
  evidence: RolloverEvidence,
  provider: string,
  model: string,
  sessionId: string,
  contextWindow: number,
): boolean {
  return (
    evidence.provider === provider &&
    evidence.model === model &&
    evidence.sessionId === sessionId &&
    evidence.contextWindow === contextWindow
  );
}

/** Load session-scoped evidence, resetting cleanly when the active Pi identity has changed. */
export function loadRolloverEvidence(
  store: RunStore,
  provider: string,
  model: string,
  sessionId: string,
  contextWindow: number,
): RolloverEvidence {
  const path = join(store.runDir, "rollover.json");
  if (!existsSync(path)) {
    return initialRolloverEvidence(provider, model, sessionId, contextWindow);
  }
  let evidence: RolloverEvidence;
  try {
    evidence = validateEvidence(JSON.parse(readFileSync(path, "utf8")));
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Durable rollover evidence must contain valid JSON", { cause: error });
  }
  return sameSession(evidence, provider, model, sessionId, contextWindow)
    ? evidence
    : initialRolloverEvidence(provider, model, sessionId, contextWindow);
}

/** Atomically persist validated rollover evidence before later lifecycle transitions observe it. */
export function saveRolloverEvidence(store: RunStore, evidence: RolloverEvidence): void {
  atomicWrite(join(store.runDir, "rollover.json"), validateEvidence(evidence));
}

/** Create empty validated evidence bound to one provider, model, native session, and context window. */
export function initialRolloverEvidence(
  provider: string,
  model: string,
  sessionId: string,
  contextWindow: number,
): RolloverEvidence {
  return validateEvidence({
    formatVersion: 1,
    provider,
    model,
    sessionId,
    contextWindow,
    growthTokens: [],
    unusableSamples: 0,
    rotationRequired: false,
    updatedAt: new Date().toISOString(),
  });
}

/** Record one usable finalized sample and latch rotation once the adaptive threshold is reached. */
export function recordUsableSample(
  current: RolloverEvidence,
  tokens: number,
): { evidence: RolloverEvidence; decision: RolloverDecision } {
  if (current.lastTokens !== undefined && tokens < current.lastTokens) {
    throw new SeptError("Provider context usage regressed within an uncompacted Pi session");
  }
  const growth = current.lastTokens === undefined ? undefined : tokens - current.lastTokens;
  const growthTokens =
    growth !== undefined && growth > 0
      ? [...current.growthTokens, growth].slice(-GROWTH_HISTORY_LIMIT)
      : current.growthTokens;
  const decision = decideRollover(tokens, current.contextWindow, growthTokens);
  const evidence = validateEvidence({
    ...current,
    lastTokens: tokens,
    growthTokens,
    unusableSamples: 0,
    rotationRequired: current.rotationRequired || decision.rotate,
    updatedAt: new Date().toISOString(),
  });
  return { decision, evidence };
}

/** Increment the bounded incompatibility counter for one unusable finalized provider response. */
export function recordUnusableSample(current: RolloverEvidence): RolloverEvidence {
  return validateEvidence({
    ...current,
    unusableSamples: Math.min(MAX_UNUSABLE_USAGE_SAMPLES, current.unusableSamples + 1),
    updatedAt: new Date().toISOString(),
  });
}
