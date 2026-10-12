/**
 * Owns private filesystem creation, atomic replacement, fsync ordering, and bounded JSONL scanning.
 * Higher durable stores supply validated domain records; this lowest layer makes file contents and
 * authority-bearing directory entries recoverable without interpreting business lifecycle state.
 */

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { SeptError } from "./errors.js";
import { MAX_JSONL_RECORD_BYTES } from "./limits.js";

/** Return an ISO timestamp suitable for durable evidence. */
export function now(): string {
  return new Date().toISOString();
}

/** Return the errno code carried by a narrowed Node filesystem failure. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** Fsync a directory after changing an authority-bearing directory entry. */
function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Create a private directory tree and durably publish each new entry. */
function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    return;
  }
  const parent = dirname(path);
  if (parent === path) {
    throw new SeptError(`Cannot create durable directory ${path}`);
  }
  ensureDirectory(parent);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  syncDirectory(parent);
}

function serializedBody(value: unknown): string {
  const body = typeof value === "string" ? value : `${JSON.stringify(value, undefined, 2)}\n`;
  return body.endsWith("\n") ? body : `${body}\n`;
}

function writeExclusiveFile(path: string, body: string): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    writeSync(descriptor, body);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Atomically replace a durable file and fsync its containing directory. */
export function atomicWrite(path: string, value: unknown): void {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeExclusiveFile(temporaryPath, serializedBody(value));
  renameSync(temporaryPath, path);
  syncDirectory(directory);
}

/** Atomically create a durable file without replacing an existing authority record. */
export function atomicCreate(path: string, value: unknown): boolean {
  const directory = dirname(path);
  ensureDirectory(directory);
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeExclusiveFile(temporaryPath, serializedBody(value));
  try {
    linkSync(temporaryPath, path);
    syncDirectory(directory);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(temporaryPath);
  }
}

/** Append and fsync one bounded JSONL record before returning to its caller. */
function appendSynced(path: string, value: unknown): void {
  const directory = dirname(path);
  ensureDirectory(directory);
  const created = !existsSync(path);
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_JSONL_RECORD_BYTES) {
    throw new SeptError(`Durable JSONL record exceeds the configured limit in ${path}`);
  }
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY,
    0o600,
  );
  try {
    writeSync(descriptor, body);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  // The first record is not recoverable unless its new directory entry is also durable.
  if (created) {
    syncDirectory(directory);
  }
}

/** Parse one durable JSON file as hostile unknown input. */
function readJson(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed;
  } catch (error: unknown) {
    throw new SeptError(`Invalid durable JSON ${path}`, { cause: error });
  }
}

function parseRecord(record: Buffer, path: string, line: number): unknown {
  if (record.byteLength > MAX_JSONL_RECORD_BYTES) {
    throw new SeptError(
      `Durable JSONL record exceeds the configured limit in ${path}:${String(line)}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(record.toString("utf8"));
    return parsed;
  } catch (error: unknown) {
    throw new SeptError(`Invalid durable JSONL ${path}:${String(line)}`, { cause: error });
  }
}

interface RecordScanResult {
  buffered: Buffer;
  line: number;
  stopped: boolean;
}

function visitCompleteRecords(
  input: Buffer,
  path: string,
  firstLine: number,
  visit: (value: unknown, line: number) => boolean | undefined,
): RecordScanResult {
  let buffered = input;
  let line = firstLine;
  let newline = buffered.indexOf(10);
  while (newline >= 0) {
    const record = buffered.subarray(0, newline);
    buffered = buffered.subarray(newline + 1);
    line += 1;
    if (record.byteLength > 0 && visit(parseRecord(record, path, line), line) === false) {
      return { buffered, line, stopped: true };
    }
    newline = buffered.indexOf(10);
  }
  return { buffered, line, stopped: false };
}

/** Stream-scan bounded durable JSONL input without materializing its full history. */
function scanJsonLines(
  path: string,
  visit: (value: unknown, line: number) => boolean | undefined,
): void {
  if (!existsSync(path)) {
    return;
  }
  const descriptor = openSync(path, constants.O_RDONLY);
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let scan: RecordScanResult = { buffered: Buffer.alloc(0), line: 0, stopped: false };
  try {
    while (!scan.stopped) {
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) {
        break;
      }
      scan = visitCompleteRecords(
        Buffer.concat([scan.buffered, chunk.subarray(0, count)]),
        path,
        scan.line,
        visit,
      );
      if (scan.buffered.byteLength > MAX_JSONL_RECORD_BYTES) {
        throw new SeptError(`Durable JSONL record exceeds the configured limit in ${path}`);
      }
    }
    if (!scan.stopped && scan.buffered.byteLength > 0) {
      visit(parseRecord(scan.buffered, path, scan.line + 1), scan.line + 1);
    }
  } finally {
    closeSync(descriptor);
  }
}

export { appendSynced, ensureDirectory, errorCode, readJson, scanJsonLines, syncDirectory };
