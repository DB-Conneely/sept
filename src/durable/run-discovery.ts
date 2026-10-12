/**
 * Discovers restart-adoptable runs beneath one state root. Worker recovery owns adoption decisions;
 * discovery ignores reserved or legacy directories but fails closed when current-format authority is
 * partial, malformed, or inconsistent with its directory identity.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SeptError } from "./errors.js";
import { readJson } from "./filesystem.js";
import { RunStore } from "./run-store.js";

function durableFormatVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return "formatVersion" in value ? value.formatVersion : undefined;
}

function discoveredRun(root: string, name: string): RunStore | undefined {
  const runDirectory = resolve(root, name);
  const manifestPath = join(runDirectory, "manifest.json");
  const snapshotPath = join(runDirectory, "state.json");
  const hasManifest = existsSync(manifestPath);
  const hasSnapshot = existsSync(snapshotPath);
  if (!hasManifest) {
    if (hasSnapshot) {
      throw new SeptError(`Partial durable v2 run ${name} is missing manifest.json`);
    }
    return undefined;
  }
  const formatVersion = durableFormatVersion(readJson(manifestPath));
  if (formatVersion !== 2 && formatVersion !== 3) {
    if (!hasSnapshot) {
      return undefined;
    }
    throw new SeptError(`Unsupported or partial durable run ${name}`);
  }
  if (!hasSnapshot) {
    throw new SeptError(`Partial durable v2 run ${name} is missing state.json`);
  }
  const store = new RunStore(runDirectory);
  store.manifest();
  store.snapshot();
  return store;
}

/** Discover complete current-format runs while failing closed on partial durable authority. */
export function listRuns(root: string): RunStore[] {
  if (!existsSync(root)) {
    return [];
  }
  const stores: RunStore[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const ignored =
      !entry.isDirectory() || entry.name.startsWith(".") || entry.name === "webhook-receipts";
    if (ignored) {
      continue;
    }
    const store = discoveredRun(root, entry.name);
    if (store !== undefined) {
      stores.push(store);
    }
  }
  return stores;
}
