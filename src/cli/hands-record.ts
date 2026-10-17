/** Private ownership receipts for the optional local hands setup commands. */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite, SeptError } from "../durable/index.js";

/** Fixed paths returned directly as existing createWorker options; no credential is generated. */
export interface HandsPaths {
  stateRoot: string;
  agentDir: string;
  workspaceRoot: string;
  handsConfigurationPath: string;
}

/** Durable exclusive setup identity survives partial creation and never grants task authority. */
export interface HandsReceipt {
  version: 1;
  owner: string;
  engineSocket: string;
  socketIdentity: string;
  daemonId: string;
  image: string;
  containerId?: string;
  generation?: string;
  phase: "prepared" | "creating" | "running" | "ready" | "failed" | "finished";
}

/** Derive the sole supported fresh-instance layout. */
export function handsPaths(root: string): HandsPaths {
  return {
    stateRoot: join(root, "state"),
    agentDir: join(root, "agent"),
    workspaceRoot: join(root, "workspace"),
    handsConfigurationPath: join(root, "hands.json"),
  };
}

/** Refuse lexical aliases and mutable ancestors before creating or reading ownership. */
export function trustedHandsRoot(value: string | undefined, fresh = false): string {
  if (
    value === undefined ||
    !isAbsolute(value) ||
    value.length > 4096 ||
    /[\x00-\x1f,]/.test(value)
  ) {
    throw new SeptError(
      "hands requires a canonical absolute --root without control characters or commas",
    );
  }
  const existing = fresh ? dirname(value) : value;
  if (realpathSync(existing) !== existing || normalize(value) !== value) {
    throw new SeptError("Hands root must be canonical");
  }
  validateAncestors(existing);
  return value;
}

function validateAncestors(existing: string): void {
  for (let path = existing; ; path = dirname(path)) {
    const stat = lstatSync(path);
    const owner = stat.uid === 0 || stat.uid === process.getuid?.();
    const sticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !owner || ((stat.mode & 0o022) !== 0 && !sticky)) {
      throw new SeptError("Hands root ancestry is not trusted");
    }
    if (path === dirname(path)) {
      return;
    }
  }
}

/** Create only a new root: a failed or foreign instance is never overwritten or adopted by init. */
export function createHandsRoot(root: string): HandsPaths {
  mkdirSync(root, { mode: 0o755 });
  chmodSync(root, 0o755);
  const paths = handsPaths(root);
  for (const directory of [
    paths.stateRoot,
    paths.agentDir,
    paths.workspaceRoot,
    join(root, "evidence"),
    join(root, "docker-cli"),
  ]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  mkdirSync(join(root, "resources"), { mode: 0o755 });
  chmodSync(join(root, "resources"), 0o755);
  syncSetupDirectory(root);
  syncSetupDirectory(dirname(root));
  return paths;
}

function syncSetupDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Persist recovery ownership before creating a container and after every identity transition. */
export function writeHandsReceipt(root: string, receipt: HandsReceipt): void {
  atomicWrite(join(root, "evidence", "setup.json"), receipt);
}

/** Read bounded private ownership, refusing edited schema, symlinks, hardlinks or broad permissions. */
export function readHandsReceipt(root: string): HandsReceipt {
  const path = join(root, "evidence", "setup.json");
  const raw = readHandsMetadata(path, 16 * 1024);
  if (!isRecord(raw)) {
    throw new SeptError("Hands setup ownership is malformed");
  }
  return decodeReceipt(raw);
}

/** Read private bounded setup metadata without presenting hostile JSON or filesystem diagnostics. */
export function readHandsMetadata(path: string, maximum: number): unknown {
  try {
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid?.() ||
      (file.mode & 0o077) !== 0 ||
      file.size > maximum
    ) {
      throw new SeptError("Hands metadata must be a bounded private owned regular file");
    }
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return raw;
  } catch (error: unknown) {
    throw new SeptError("Hands setup metadata is unavailable or malformed", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeReceipt(raw: Record<string, unknown>): HandsReceipt {
  const keys = [
    "version",
    "owner",
    "engineSocket",
    "socketIdentity",
    "daemonId",
    "image",
    "containerId",
    "generation",
    "phase",
  ];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || raw.version !== 1) {
    throw new SeptError("Hands setup ownership is malformed");
  }
  const containerId =
    raw.containerId === undefined ? undefined : text(raw.containerId, /^[a-f0-9]{64}$/);
  const generation = raw.generation === undefined ? undefined : text(raw.generation);
  return {
    version: 1,
    owner: text(raw.owner, /^[a-f0-9-]{36}$/),
    engineSocket: text(raw.engineSocket),
    socketIdentity: text(raw.socketIdentity),
    daemonId: text(raw.daemonId),
    image: text(raw.image, /^sha256:[a-f0-9]{64}$/),
    phase: receiptPhase(raw.phase),
    ...(containerId === undefined ? {} : { containerId }),
    ...(generation === undefined ? {} : { generation }),
  };
}

function text(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new SeptError("Hands setup ownership text is malformed");
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new SeptError("Hands setup ownership identity is malformed");
  }
  return value;
}

function receiptPhase(value: unknown): HandsReceipt["phase"] {
  switch (value) {
    case "prepared":
    case "creating":
    case "running":
    case "ready":
    case "failed":
    case "finished":
      return value;
    default:
      throw new SeptError("Hands setup phase is malformed");
  }
}

/** Generate the unguessable container ownership label before any Engine effect. */
export function newHandsOwner(): string {
  return randomUUID();
}
