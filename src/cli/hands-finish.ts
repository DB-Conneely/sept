/** Export before stopping one exclusively owned hands generation; never extract archive bytes on host. */
import { existsSync, lstatSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireStateRootLease, atomicWrite, SeptError } from "../durable/index.js";
import {
  handsPaths,
  readHandsReceipt,
  readHandsMetadata,
  trustedHandsRoot,
  writeHandsReceipt,
  type HandsReceipt,
} from "./hands-record.js";
import { exportHandsWorkspace } from "./hands-docker.js";
import { inspectHandsOwner, openHandsEngine, stopHandsOwner } from "./hands-owner.js";
/** Refuse a live worker, serialize setup ownership, then independently finalize export and stop. */
export async function finishHands(options: Record<string, string>): Promise<unknown> {
  if (Object.keys(options).some((key) => key !== "root")) {
    throw new SeptError("hands finish accepts only --root");
  }
  const root = trustedHandsRoot(options.root);
  assertSetupLayout(root);
  // Preflight schema grants no authority; the owner is re-read after serialized lease acquisition.
  readHandsReceipt(root);
  const releaseSetup = acquireStateRootLease(join(root, "evidence"));
  try {
    const releaseWorker = acquireStateRootLease(handsPaths(root).stateRoot);
    try {
      return await finishOwned(root, readHandsReceipt(root));
    } finally {
      releaseWorker();
    }
  } finally {
    releaseSetup();
  }
}

function assertSetupLayout(root: string): void {
  try {
    // Lease acquisition creates lock files: prove a setup-owned layout before any such mutation.
    for (const name of ["state", "evidence"]) {
      const directory = lstatSync(join(root, name));
      if (
        !directory.isDirectory() ||
        directory.uid !== process.getuid?.() ||
        (directory.mode & 0o077) !== 0
      ) {
        throw new SeptError("Hands setup directories must be private and owned");
      }
    }
    assertSetupReceipt(root);
  } catch (error: unknown) {
    throw new SeptError("Hands finish requires an existing private owned setup layout", {
      cause: error,
    });
  }
}

function assertSetupReceipt(root: string): void {
  const receipt = lstatSync(join(root, "evidence", "setup.json"));
  if (
    !receipt.isFile() ||
    receipt.nlink !== 1 ||
    receipt.uid !== process.getuid?.() ||
    (receipt.mode & 0o077) !== 0 ||
    receipt.size > 16 * 1024
  ) {
    throw new SeptError("Hands setup receipt must be private and owned");
  }
}

async function finishOwned(root: string, receipt: HandsReceipt): Promise<unknown> {
  const previous = reusableExport(root);
  const engine = await openHandsEngine(receipt);
  const archive = join(root, "evidence", `workspace-${randomUUID()}.tar`);
  let exported = previous !== undefined;
  let stopped = false;
  try {
    const state = await inspectHandsOwner(root, receipt, engine);
    if (receipt.phase === "finished") {
      return verifiedFinalization(root, state, previous);
    }
    exported ||= await tryExport(root, receipt, archive, state.Running === true);
    await stopHandsOwner(root, receipt, engine);
    stopped = true;
  } finally {
    await engine.close();
    if (receipt.phase !== "finished") {
      atomicWrite(join(root, "evidence", "finish.json"), {
        exported,
        stopped,
        archive: previous ?? (existsSync(archive) ? archive : null),
      });
    }
  }
  if (!exported) {
    throw new SeptError(
      "Hands workspace export failed or unavailable; stop verified; inspect evidence/finish.json",
    );
  }
  receipt.phase = "finished";
  writeHandsReceipt(root, receipt);
  return readFinalization(root);
}

function verifiedFinalization(
  root: string,
  state: Record<string, unknown>,
  previous: string | undefined,
): Finalization {
  if (state.Running !== false || state.Pid !== 0 || previous === undefined) {
    throw new SeptError(
      "Previously finished hands has no verified stopped namespace and retained archive",
    );
  }
  const result = readFinalization(root);
  if (!result.exported || !result.stopped) {
    throw new SeptError("Hands finished receipt has no verified successful outcomes");
  }
  return result;
}

interface Finalization {
  exported: boolean;
  stopped: boolean;
  archive: string | null;
}

function readFinalization(root: string): Finalization {
  const result = readHandsMetadata(join(root, "evidence", "finish.json"), 1024);
  if (
    typeof result !== "object" ||
    result === null ||
    !("exported" in result) ||
    !("stopped" in result) ||
    !("archive" in result)
  ) {
    throw new SeptError("Hands finalization receipt is malformed");
  }
  if (
    typeof result.exported !== "boolean" ||
    typeof result.stopped !== "boolean" ||
    (typeof result.archive !== "string" && result.archive !== null)
  ) {
    throw new SeptError("Hands finalization outcomes are malformed");
  }
  return { exported: result.exported, stopped: result.stopped, archive: result.archive };
}

function reusableExport(root: string): string | undefined {
  try {
    return previousExport(root);
  } catch {
    // Invalid export evidence grants no reuse, but cannot skip independently owned namespace shutdown.
    return undefined;
  }
}

function previousExport(root: string): string | undefined {
  if (!existsSync(join(root, "evidence", "finish.json"))) {
    return undefined;
  }
  const previous = readFinalization(root);
  if (!previous.exported || previous.archive === null) {
    return undefined;
  }
  if (
    dirname(previous.archive) !== join(root, "evidence") ||
    !/^workspace-[a-f0-9-]{36}\.tar$/.test(basename(previous.archive))
  ) {
    throw new SeptError("Hands archive receipt escapes the owned evidence directory");
  }
  assertArchive(previous.archive);
  return previous.archive;
}

function assertArchive(path: string): void {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0
  ) {
    throw new SeptError("Hands retained archive ownership is malformed");
  }
}

async function tryExport(
  root: string,
  receipt: HandsReceipt,
  archive: string,
  running: boolean,
): Promise<boolean> {
  if (!running || receipt.generation === undefined) {
    return false;
  }
  try {
    await exportHandsWorkspace(root, receipt, archive);
    return true;
  } catch {
    return false;
  }
}
