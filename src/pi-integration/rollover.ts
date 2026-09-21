import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SeptError, atomicWrite, type RunStore } from "../durable/index.js";

export const MAX_UNUSABLE_USAGE_SAMPLES = 3;
const MIN_CONTEXT_WINDOW = 4_096;
const MAX_CONTEXT_WINDOW = 10_000_000;
const GROWTH_HISTORY_LIMIT = 3;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

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

export interface RolloverDecision {
  rotate: boolean;
  reason: "sufficient_headroom" | "required_headroom_reached" | "reserve_exceeds_window";
  rotateAtTokens: number;
  headroomTokens: number;
  handoverReserveTokens: number;
  ordinaryTurnFloorTokens: number;
  nextTurnReserveTokens: number;
  confidenceMarginTokens: number;
  recentGrowthTokens: number;
  confidence: "low" | "medium" | "high";
}

export function providerContextTokens(
  usage: unknown,
  calculate: (value: never) => number,
): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const input = usage as Record<string, unknown>;
  for (const name of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    const value = input[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  }
  const calculated = calculate(usage as never);
  return Number.isSafeInteger(calculated) && calculated > 0 ? calculated : undefined;
}

function clampProportion(window: number, proportion: number): number {
  return Math.min(65_536, Math.max(8_192, Math.ceil(window * proportion)));
}

/** Exact Part 2 arithmetic over finalized provider usage and the active Pi model window. */
export function decideRollover(
  contextTokens: number,
  contextWindow: number,
  growthTokens: readonly number[],
): RolloverDecision {
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < MIN_CONTEXT_WINDOW ||
    contextWindow > MAX_CONTEXT_WINDOW
  )
    throw new SeptError("Active model context-window metadata is invalid");
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1 || contextTokens > contextWindow)
    throw new SeptError("Provider context usage is outside the active model window");
  if (
    growthTokens.length > GROWTH_HISTORY_LIMIT ||
    growthTokens.some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    throw new SeptError("Durable positive context-growth evidence is invalid");

  const confidence =
    growthTokens.length >= 2 ? "high" : growthTokens.length === 1 ? "medium" : "low";
  const recentGrowthTokens = growthTokens.length ? Math.max(...growthTokens) : 0;
  const handoverReserveTokens = clampProportion(contextWindow, 0.08);
  const ordinaryTurnFloorTokens = clampProportion(contextWindow, 0.06);
  const nextTurnReserveTokens = Math.max(
    ordinaryTurnFloorTokens,
    Math.ceil(1.5 * recentGrowthTokens),
  );
  const confidenceMarginTokens = Math.ceil(
    contextWindow * (confidence === "low" ? 0.08 : confidence === "medium" ? 0.05 : 0.03),
  );
  const headroomTokens = handoverReserveTokens + nextTurnReserveTokens + confidenceMarginTokens;
  const rotateAtTokens = Math.max(0, contextWindow - headroomTokens);
  const rotate = contextTokens + headroomTokens >= contextWindow;
  const reason =
    headroomTokens >= contextWindow
      ? "reserve_exceeds_window"
      : rotate
        ? "required_headroom_reached"
        : "sufficient_headroom";
  return {
    rotate,
    reason,
    rotateAtTokens,
    headroomTokens,
    handoverReserveTokens,
    ordinaryTurnFloorTokens,
    nextTurnReserveTokens,
    confidenceMarginTokens,
    recentGrowthTokens,
    confidence,
  };
}

function validateEvidence(value: unknown): RolloverEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SeptError("Durable rollover evidence is invalid");
  const input = value as Record<string, unknown>;
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
  if (
    required.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  )
    throw new SeptError("Durable rollover evidence has invalid fields");
  if (
    input.formatVersion !== 1 ||
    typeof input.provider !== "string" ||
    !SAFE_SCOPE.test(input.provider) ||
    typeof input.model !== "string" ||
    !SAFE_SCOPE.test(input.model) ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length < 1 ||
    input.sessionId.length > 4096 ||
    typeof input.rotationRequired !== "boolean"
  )
    throw new SeptError("Durable rollover evidence is invalid");
  if (
    !Number.isSafeInteger(input.contextWindow) ||
    (input.contextWindow as number) < MIN_CONTEXT_WINDOW ||
    (input.contextWindow as number) > MAX_CONTEXT_WINDOW ||
    !Number.isSafeInteger(input.unusableSamples) ||
    (input.unusableSamples as number) < 0 ||
    (input.unusableSamples as number) > MAX_UNUSABLE_USAGE_SAMPLES
  )
    throw new SeptError("Durable rollover evidence is invalid");
  if (
    !Array.isArray(input.growthTokens) ||
    input.growthTokens.length > GROWTH_HISTORY_LIMIT ||
    input.growthTokens.some((item) => !Number.isSafeInteger(item) || (item as number) <= 0)
  )
    throw new SeptError("Durable rollover evidence is invalid");
  if (
    input.lastTokens !== undefined &&
    (!Number.isSafeInteger(input.lastTokens) ||
      (input.lastTokens as number) < 1 ||
      (input.lastTokens as number) > (input.contextWindow as number))
  )
    throw new SeptError("Durable rollover evidence is invalid");
  if (
    typeof input.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.updatedAt)) ||
    new Date(Date.parse(input.updatedAt)).toISOString() !== input.updatedAt
  )
    throw new SeptError("Durable rollover evidence is invalid");
  return input as unknown as RolloverEvidence;
}

export function loadRolloverEvidence(
  store: RunStore,
  provider: string,
  model: string,
  sessionId: string,
  contextWindow: number,
): RolloverEvidence {
  const path = join(store.runDir, "rollover.json");
  if (!existsSync(path)) return initialRolloverEvidence(provider, model, sessionId, contextWindow);
  let evidence: RolloverEvidence;
  try {
    evidence = validateEvidence(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof SeptError) throw error;
    throw new SeptError("Durable rollover evidence must contain valid JSON");
  }
  if (
    evidence.provider !== provider ||
    evidence.model !== model ||
    evidence.sessionId !== sessionId ||
    evidence.contextWindow !== contextWindow
  )
    return initialRolloverEvidence(provider, model, sessionId, contextWindow);
  return evidence;
}

export function saveRolloverEvidence(store: RunStore, evidence: RolloverEvidence): void {
  atomicWrite(join(store.runDir, "rollover.json"), validateEvidence(evidence));
}

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

export function recordUsableSample(
  current: RolloverEvidence,
  tokens: number,
): { evidence: RolloverEvidence; decision: RolloverDecision } {
  if (current.lastTokens !== undefined && tokens < current.lastTokens)
    throw new SeptError("Provider context usage regressed within an uncompacted Pi session");
  const growth = current.lastTokens === undefined ? undefined : tokens - current.lastTokens;
  const growthTokens =
    growth !== undefined && growth > 0
      ? [...current.growthTokens, growth].slice(-GROWTH_HISTORY_LIMIT)
      : current.growthTokens;
  const decision = decideRollover(tokens, current.contextWindow, growthTokens);
  return {
    decision,
    evidence: validateEvidence({
      ...current,
      lastTokens: tokens,
      growthTokens,
      unusableSamples: 0,
      rotationRequired: current.rotationRequired || decision.rotate,
      updatedAt: new Date().toISOString(),
    }),
  };
}

export function recordUnusableSample(current: RolloverEvidence): RolloverEvidence {
  return validateEvidence({
    ...current,
    unusableSamples: Math.min(MAX_UNUSABLE_USAGE_SAMPLES, current.unusableSamples + 1),
    updatedAt: new Date().toISOString(),
  });
}
