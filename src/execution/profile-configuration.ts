/** Owns bounded local operator configuration parsing; kernel facts belong to profile.ts. */
import { realpathSync, readFileSync, statSync } from "node:fs";
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import { handsRecord } from "./protocol.js";
/** Validate bounded trusted configuration text, never task arguments. */
export function configuredText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new SeptError("Hands configuration text is invalid");
  }
  return value;
}

function directory(value: unknown): string {
  const path = realpathSync(configuredText(value));
  if (!statSync(path).isDirectory()) {
    throw new SeptError("Hands configuration requires a directory");
  }
  return path;
}

function parseMount(value: unknown): DockerHandsConfiguration["readOnlyMounts"][number] {
  const mount = handsRecord(value);
  const destination = configuredText(mount.destination);
  if (!/^\/selected\/[A-Za-z0-9_-]+$/.test(destination)) {
    throw new SeptError("Selected mount alias must be below /selected");
  }
  return { source: directory(mount.source), destination };
}

function selectedMounts(value: unknown): DockerHandsConfiguration["readOnlyMounts"] {
  const mounts = value ?? [];
  if (!Array.isArray(mounts) || mounts.length > 8) {
    throw new SeptError("Hands selected mounts exceed their bound");
  }
  return mounts.map((mount: unknown) => parseMount(mount));
}

function mountConfiguration(input: Record<string, unknown>) {
  const mounts = selectedMounts(input.readOnlyMounts);
  const writable = selectedMounts(input.readWriteMounts);
  if (
    mounts.length + writable.length > 8 ||
    new Set([...mounts, ...writable].map((entry) => entry.destination)).size !==
      mounts.length + writable.length
  ) {
    throw new SeptError("Selected mount aliases exceed their bound or collide");
  }
  if (input.shell && writable.length > 0) {
    throw new SeptError("Arbitrary execution with persistent selected RW mounts is unsupported");
  }
  return { mounts, writable };
}

/** Read only trusted local operator configuration; task text cannot choose a backend. */
export function loadHandsConfiguration(path: string | undefined): DockerHandsConfiguration {
  try {
    if (path === undefined || statSync(path).size > 16 * 1024) {
      throw new SeptError("A supported supplied hands configuration is required");
    }
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const input = handsRecord(value);
    if (input.profile !== "docker-linux-v1" || typeof input.shell !== "boolean") {
      throw new SeptError("Hands profile is unsupported");
    }
    const containerId = configuredText(input.containerId);
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      throw new SeptError("Hands container identity must be immutable");
    }
    const { mounts, writable } = mountConfiguration(input);
    return {
      profile: input.profile,
      containerId,
      generation: configuredText(input.generation),
      workspace: directory(input.workspace),
      resources: directory(input.resources),
      shell: input.shell,
      readOnlyMounts: mounts,
      ...(writable.length === 0 ? {} : { readWriteMounts: writable }),
    };
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Supplied hands configuration is unavailable", { cause: error });
  }
}
