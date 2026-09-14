import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SeptError, atomicWrite, type RunStore } from "../durable/index.js";

export const MAX_UNUSABLE_USAGE_SAMPLES = 3;
const MIN_CONTEXT_WINDOW = 4_096;
const MAX_CONTEXT_WINDOW = 10_000_000;
const GROWTH_HISTORY_LIMIT = 4;

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
  rotateAtTokens: number;
  headroomTokens: number;
  handoverReserveTokens: number;
  nextTurnReserveTokens: number;
  recentGrowthTokens: number;
  confidence: "low" | "medium" | "high";
}

export function assertUsableModelMetadata(model: { provider: string; id: string; contextWindow: number; maxTokens: number }): void {
  const { contextWindow, maxTokens } = model;
  if (!Number.isSafeInteger(contextWindow) || contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) {
    throw new SeptError(`Pi model ${model.provider}/${model.id} has missing or invalid context-window metadata`);
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) {
    throw new SeptError(`Pi model ${model.provider}/${model.id} has missing or invalid maximum-output metadata`);
  }
}

export function providerContextTokens(usage: unknown, calculate: (value: never) => number): number | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const input = usage as Record<string, unknown>;
  for (const name of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    const value = input[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  }
  const calculated = calculate(usage as never);
  return Number.isSafeInteger(calculated) && calculated > 0 ? calculated : undefined;
}

function boundedProportion(window: number, proportion: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.ceil(window * proportion)));
}

/**
 * Reserve one bounded handover call plus one bounded next ordinary/tool turn.
 * With insufficient growth history the next-turn reserve is deliberately conservative.
 */
export function decideRollover(contextTokens: number, contextWindow: number, growthTokens: readonly number[]): RolloverDecision {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1 || contextTokens > contextWindow) throw new SeptError("Provider context usage is outside the active model window");
  if (!Number.isSafeInteger(contextWindow) || contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) throw new SeptError("Active model context-window metadata is invalid");
  if (growthTokens.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new SeptError("Durable context-growth evidence is invalid");

  const confidence = growthTokens.length >= 2 ? "high" : growthTokens.length === 1 ? "medium" : "low";
  const handoverReserveTokens = boundedProportion(contextWindow, 0.08, 8_192, 65_536);
  const observedGrowth = growthTokens.length ? Math.max(...growthTokens.slice(-GROWTH_HISTORY_LIMIT)) : 0;
  const growthReserve = confidence === "low" ? Math.ceil(contextWindow * 0.12) : Math.max(Math.ceil(contextWindow * 0.04), observedGrowth * 2);
  const nextTurnReserveTokens = Math.min(98_304, Math.ceil(contextWindow * 0.12), Math.max(4_096, growthReserve));
  const maximumHeadroom = Math.floor(contextWindow * 0.25);
  const headroomTokens = Math.min(maximumHeadroom, handoverReserveTokens + nextTurnReserveTokens);
  const rotateAtTokens = contextWindow - headroomTokens;
  return {
    rotate: contextTokens >= rotateAtTokens,
    rotateAtTokens,
    headroomTokens,
    handoverReserveTokens,
    nextTurnReserveTokens,
    recentGrowthTokens: observedGrowth,
    confidence,
  };
}

function validateEvidence(value: unknown): RolloverEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeptError("Durable rollover evidence is invalid");
  const input = value as Record<string, unknown>;
  const expected = ["contextWindow", "formatVersion", "growthTokens", "lastTokens", "model", "provider", "rotationRequired", "sessionId", "unusableSamples", "updatedAt"];
  const keys = Object.keys(input).sort();
  const withoutOptional = expected.filter((key) => key !== "lastTokens").sort();
  if (keys.join() !== expected.sort().join() && keys.join() !== withoutOptional.join()) throw new SeptError("Durable rollover evidence has invalid fields");
  if (input.formatVersion !== 1 || typeof input.provider !== "string" || typeof input.model !== "string" || typeof input.sessionId !== "string" || typeof input.rotationRequired !== "boolean") throw new SeptError("Durable rollover evidence is invalid");
  if (!Number.isSafeInteger(input.contextWindow) || (input.contextWindow as number) < MIN_CONTEXT_WINDOW || !Number.isSafeInteger(input.unusableSamples) || (input.unusableSamples as number) < 0 || (input.unusableSamples as number) > MAX_UNUSABLE_USAGE_SAMPLES) throw new SeptError("Durable rollover evidence is invalid");
  if (!Array.isArray(input.growthTokens) || input.growthTokens.length > GROWTH_HISTORY_LIMIT || input.growthTokens.some((item) => !Number.isSafeInteger(item) || (item as number) < 0)) throw new SeptError("Durable rollover evidence is invalid");
  if (input.lastTokens !== undefined && (!Number.isSafeInteger(input.lastTokens) || (input.lastTokens as number) < 1 || (input.lastTokens as number) > (input.contextWindow as number))) throw new SeptError("Durable rollover evidence is invalid");
  if (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))) throw new SeptError("Durable rollover evidence is invalid");
  return input as unknown as RolloverEvidence;
}

export function loadRolloverEvidence(store: RunStore, provider: string, model: string, sessionId: string, contextWindow: number): RolloverEvidence {
  const path = join(store.runDir, "rollover.json");
  if (!existsSync(path)) return initialRolloverEvidence(provider, model, sessionId, contextWindow);
  let evidence: RolloverEvidence;
  try { evidence = validateEvidence(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (error instanceof SeptError) throw error; throw new SeptError("Durable rollover evidence must contain valid JSON"); }
  if (evidence.provider !== provider || evidence.model !== model || evidence.sessionId !== sessionId || evidence.contextWindow !== contextWindow) {
    return initialRolloverEvidence(provider, model, sessionId, contextWindow);
  }
  return evidence;
}

export function saveRolloverEvidence(store: RunStore, evidence: RolloverEvidence): void {
  atomicWrite(join(store.runDir, "rollover.json"), validateEvidence(evidence));
}

export function initialRolloverEvidence(provider: string, model: string, sessionId: string, contextWindow: number): RolloverEvidence {
  return { formatVersion: 1, provider, model, sessionId, contextWindow, growthTokens: [], unusableSamples: 0, rotationRequired: false, updatedAt: new Date().toISOString() };
}

export function recordUsableSample(current: RolloverEvidence, tokens: number): { evidence: RolloverEvidence; decision: RolloverDecision } {
  if (current.lastTokens !== undefined && tokens < current.lastTokens) throw new SeptError("Provider context usage regressed within an uncompacted Pi session");
  const growth = current.lastTokens === undefined ? undefined : tokens - current.lastTokens;
  const growthTokens = growth === undefined ? current.growthTokens : [...current.growthTokens, growth].slice(-GROWTH_HISTORY_LIMIT);
  const decision = decideRollover(tokens, current.contextWindow, growthTokens);
  return {
    decision,
    evidence: {
      ...current,
      lastTokens: tokens,
      growthTokens,
      unusableSamples: 0,
      rotationRequired: current.rotationRequired || decision.rotate,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function recordUnusableSample(current: RolloverEvidence): RolloverEvidence {
  return { ...current, unusableSamples: current.unusableSamples + 1, updatedAt: new Date().toISOString() };
}
