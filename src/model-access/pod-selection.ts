/**
 * Owns the credential-free Pod default provider/model pair in the Pi agent directory. Admission
 * rereads this atomic record rather than caching authority; only validated identifiers are persisted,
 * and authentication material is never accepted into selection state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite, SeptError } from "../durable/index.js";
import type { ModelSelection } from "./contracts.js";
import { isUnknownRecord } from "./input.js";
import { safeModelIdentifier } from "./model-metadata.js";

const SELECTION_FILE = "sept-model.json";

function selectionRecord(value: unknown): Record<string, unknown> {
  if (!isUnknownRecord(value)) {
    throw new SeptError("model selection must be an object");
  }
  return value;
}

function parseSelection(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error: unknown) {
    throw new SeptError("model selection must contain valid JSON", { cause: error });
  }
}

function validateSelection(value: unknown): ModelSelection {
  const input = selectionRecord(value);
  const expected = ["formatVersion", "model", "provider"];
  const exactFields = Object.keys(input).sort().join() === expected.sort().join();
  if (!exactFields || input.formatVersion !== 1) {
    throw new SeptError("model selection has invalid fields");
  }
  return {
    provider: safeModelIdentifier(input.provider, "selected provider"),
    model: safeModelIdentifier(input.model, "selected model"),
  };
}

/** Read and validate the credential-free Pod default on every admission. */
export function readPodDefault(agentDir: string): ModelSelection | undefined {
  const path = join(resolve(agentDir), SELECTION_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  return validateSelection(parseSelection(readFileSync(path, "utf8")));
}

/** Atomically persist only a validated provider/model pair with mode 0600. */
export function writePodDefault(agentDir: string, selection: ModelSelection): void {
  const validated = validateSelection({
    formatVersion: 1,
    provider: selection.provider,
    model: selection.model,
  });
  // The selection file is authority only for future admission and must contain no Pi credentials.
  atomicWrite(join(resolve(agentDir), SELECTION_FILE), {
    formatVersion: 1,
    provider: validated.provider,
    model: validated.model,
  });
}
