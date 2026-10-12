/**
 * Owns validation of finalized provider usage and adaptive rollover arithmetic. It consumes only
 * native Pi usage plus active-model metadata; session orchestration and durable evidence remain in
 * their owning modules, and no text-based context estimate is permitted here.
 */

import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";

/** Smallest active model context window accepted by SEPT rollover policy. */
export const MIN_CONTEXT_WINDOW = 4_096;
/** Largest active model context window accepted by SEPT rollover policy. */
export const MAX_CONTEXT_WINDOW = 10_000_000;
/** Number of positive finalized-usage deltas retained for adaptive headroom. */
export const GROWTH_HISTORY_LIMIT = 3;

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

/** Deterministic headroom decision derived from active-window metadata and bounded recent growth. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsageCost(value: unknown): boolean {
  return isRecord(value) && COST_FIELDS.every((name) => isNonnegativeNumber(value[name]));
}

function isOptionalUsageInteger(value: unknown): boolean {
  return value === undefined || isNonnegativeInteger(value);
}

function isProviderUsage(value: unknown): value is Parameters<typeof calculateContextTokens>[0] {
  if (!isRecord(value) || !USAGE_FIELDS.every((name) => isNonnegativeInteger(value[name]))) {
    return false;
  }
  return (
    isUsageCost(value.cost) &&
    isOptionalUsageInteger(value.cacheWrite1h) &&
    isOptionalUsageInteger(value.reasoning)
  );
}

/** Return native Pi context tokens only when every required provider usage field is trustworthy. */
export function providerContextTokens(usage: unknown): number | undefined {
  if (!isProviderUsage(usage)) {
    return undefined;
  }
  const calculated = calculateContextTokens(usage);
  return Number.isSafeInteger(calculated) && calculated > 0 ? calculated : undefined;
}

function validContextWindow(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW;
}

function assertDecisionInput(
  contextTokens: number,
  contextWindow: number,
  growthTokens: readonly number[],
): void {
  if (!validContextWindow(contextWindow)) {
    throw new SeptError("Active model context-window metadata is invalid");
  }
  const contextValid =
    Number.isSafeInteger(contextTokens) && contextTokens >= 1 && contextTokens <= contextWindow;
  if (!contextValid) {
    throw new SeptError("Provider context usage is outside the active model window");
  }
  const growthValid =
    growthTokens.length <= GROWTH_HISTORY_LIMIT &&
    growthTokens.every((value) => Number.isSafeInteger(value) && value > 0);
  if (!growthValid) {
    throw new SeptError("Durable positive context-growth evidence is invalid");
  }
}

function confidenceFor(growthCount: number): RolloverDecision["confidence"] {
  if (growthCount >= 2) {
    return "high";
  }
  return growthCount === 1 ? "medium" : "low";
}

function decisionReason(
  rotate: boolean,
  headroomTokens: number,
  contextWindow: number,
): RolloverDecision["reason"] {
  if (headroomTokens >= contextWindow) {
    return "reserve_exceeds_window";
  }
  return rotate ? "required_headroom_reached" : "sufficient_headroom";
}

function clampProportion(contextWindow: number, proportion: number): number {
  return Math.min(65_536, Math.max(8_192, Math.ceil(contextWindow * proportion)));
}

/** Compute adaptive rotation headroom from finalized usage without cumulative spend or text guesses. */
export function decideRollover(
  contextTokens: number,
  contextWindow: number,
  growthTokens: readonly number[],
): RolloverDecision {
  assertDecisionInput(contextTokens, contextWindow, growthTokens);
  const confidence = confidenceFor(growthTokens.length);
  const recentGrowthTokens = growthTokens.length === 0 ? 0 : Math.max(...growthTokens);
  const handoverReserveTokens = clampProportion(contextWindow, 0.08);
  const ordinaryTurnFloorTokens = clampProportion(contextWindow, 0.06);
  const nextTurnReserveTokens = Math.max(
    ordinaryTurnFloorTokens,
    Math.ceil(1.5 * recentGrowthTokens),
  );
  const mediumOrHighMargin = confidence === "medium" ? 0.05 : 0.03;
  const confidenceProportion = confidence === "low" ? 0.08 : mediumOrHighMargin;
  const confidenceMarginTokens = Math.ceil(contextWindow * confidenceProportion);
  const headroomTokens = handoverReserveTokens + nextTurnReserveTokens + confidenceMarginTokens;
  const rotateAtTokens = Math.max(0, contextWindow - headroomTokens);
  const rotate = contextTokens + headroomTokens >= contextWindow;
  return {
    rotate,
    reason: decisionReason(rotate, headroomTokens, contextWindow),
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
