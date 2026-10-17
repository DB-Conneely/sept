/** Setup-only Docker CLI calls use one explicit socket and no ambient Docker context or credentials. */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, fsyncSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SeptError } from "../durable/index.js";
import { guardedCommand, parseNamespaceLifetime } from "../execution/index.js";
import { readHandsMetadata, type HandsReceipt } from "./hands-record.js";

// Lifetime is checked inside the exec: a replacement namespace can never emit an archive.
const ARCHIVE_ENTRY = `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const stat = fs.readFileSync('/proc/1/stat', 'utf8');
if (stat.length > 16384) process.exit(126);
const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
if (fs.readlinkSync('/proc/self/ns/pid') !== process.argv[1] || start !== process.argv[2]) process.exit(126);
const result = spawnSync('/bin/tar', ['-C', '/workspace', '-cf', '-', '.'], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' }, timeout: 25000 });
process.exit(result.status === 0 && result.signal === null ? 0 : 126);`;

const MAX_ARCHIVE_BYTES = 134217728 + 32768 * 2048;

function commandArguments(root: string, receipt: HandsReceipt, arguments_: string[]): string[] {
  return [
    "--config",
    join(root, "docker-cli"),
    "--host",
    `unix://${receipt.engineSocket}`,
    ...arguments_,
  ];
}

/** Bounded setup controls never invoke a shell, pull an image, or read the user's Docker config. */
export function handsDocker(root: string, receipt: HandsReceipt, arguments_: string[]): string {
  const result = spawnSync("docker", commandArguments(root, receipt, arguments_), {
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024,
  });
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new SeptError("Hands setup Docker command failed; retained receipt requires inspection", {
      cause: result.error,
    });
  }
  return result.stdout.trim();
}

/** The sole supported offline, file-only profile uses existing finite kernel limits. */
export function createHandsArguments(root: string, receipt: HandsReceipt): string[] {
  return [
    "create",
    "--pull",
    "never",
    "--name",
    `sept-hands-${receipt.owner}`,
    "--label",
    `sept.setup.owner=${receipt.owner}`,
    "--init",
    "--no-healthcheck",
    "--entrypoint",
    "",
    "--user",
    "10002:10002",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "1g",
    "--cpus",
    "2",
    "--network",
    "none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
    "--tmpfs",
    "/workspace:rw,nosuid,nodev,noexec,size=134217728,nr_inodes=32768,mode=2770,uid=10002,gid=10002",
    "--mount",
    `type=bind,src=${join(root, "resources")},dst=/resources,readonly`,
    receipt.image,
    "sleep",
    "infinity",
  ];
}

/** Stream a bounded tar archive to a new private file; hostile archive paths are never extracted. */
export async function exportHandsWorkspace(
  root: string,
  receipt: HandsReceipt,
  path: string,
): Promise<void> {
  if (receipt.containerId === undefined) {
    throw new SeptError("Hands export requires captured container ownership");
  }
  const child = archiveChild(root, receipt);
  const completion = childCompletion(child);
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 30_000);
  try {
    await archivePipeline(child.stdout, path);
    await completion;
    syncArchive(path);
  } catch (error: unknown) {
    child.kill("SIGKILL");
    await completion.catch(() => undefined);
    throw new SeptError("Hands workspace export failed; partial archive retained", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function archiveChild(
  root: string,
  receipt: HandsReceipt,
): import("node:child_process").ChildProcessWithoutNullStreams {
  if (receipt.containerId === undefined) {
    throw new SeptError("Hands export requires captured container ownership");
  }
  const child = spawn(
    "docker",
    commandArguments(root, receipt, [
      "exec",
      "--user",
      "10002:10002",
      receipt.containerId,
      ...archiveCommand(root),
    ]),
    {
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 16 * 1024) {
      child.kill("SIGKILL");
    }
  });
  return child;
}

function archiveCommand(root: string): string[] {
  const path = join(root, "evidence", "lifetime.json");
  const raw = readHandsMetadata(path, 1024);
  const lifetime = parseNamespaceLifetime(raw);
  return guardedCommand(["--eval", ARCHIVE_ENTRY, lifetime.pidNamespace, lifetime.initStart]);
}

function childCompletion(child: import("node:child_process").ChildProcess): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", () => {
      reject(new SeptError("Hands archive process could not start"));
    });
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new SeptError("Hands archive process failed"));
      }
    });
  });
  // Attach a rejection owner immediately: an Engine failure may arrive before stream finalization.
  void completed.catch(() => undefined);
  return completed;
}

async function archivePipeline(source: NodeJS.ReadableStream, path: string): Promise<void> {
  let bytes = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new SeptError("Hands workspace archive exceeds its fixed capacity"));
      } else {
        callback(null, chunk);
      }
    },
  });
  await pipeline(source, bound, createWriteStream(path, { flags: "wx", mode: 0o600 }));
}

function syncArchive(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
