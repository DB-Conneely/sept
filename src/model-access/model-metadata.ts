import { DEFAULTS, SeptError } from "../durable/index.js";
import type { ModelSelection } from "./contracts.js";

const MAX_CONTEXT_WINDOW = 10_000_000;
const MIN_CONTEXT_WINDOW = 4_096;
const SAFE_MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

interface RolloverModelMetadata {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
}

/** Validate one provider or model identifier before Pi lookup or persistence. */
export function safeModelIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_MODEL_IDENTIFIER.test(value)) {
    throw new SeptError(`${name} is invalid`);
  }
  return value;
}

/** Require trustworthy Pi context and output limits before execution or rollover. */
export function assertModelMetadata(model: RolloverModelMetadata): void {
  const validContextWindow =
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow >= MIN_CONTEXT_WINDOW &&
    model.contextWindow <= MAX_CONTEXT_WINDOW;
  if (!validContextWindow) {
    throw new SeptError(
      `Pi model ${model.provider}/${model.id} has missing or invalid context-window metadata`,
    );
  }
  const validOutput =
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens >= 1 &&
    model.maxTokens <= model.contextWindow;
  if (!validOutput) {
    throw new SeptError(
      `Pi model ${model.provider}/${model.id} has missing or invalid maximum-output metadata`,
    );
  }
}

/** Return the built-in pair only after callers perform ordinary Pi preflight. */
export function builtInDefault(): ModelSelection {
  return { provider: DEFAULTS.provider, model: DEFAULTS.model };
}

/** Smallest context window accepted as explicit rollover authority. */
export const MIN_MODEL_CONTEXT_WINDOW = MIN_CONTEXT_WINDOW;

/** Largest context window accepted as bounded rollover authority. */
export const MAX_MODEL_CONTEXT_WINDOW = MAX_CONTEXT_WINDOW;
