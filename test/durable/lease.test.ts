/** Exercises the real platform mutex, process death and competing public lease acquisitions. */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { acquireStateRootLease, adaptSqliteNotice, SeptError } from "../../src/durable/index.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";

function fixture(): { root: string; lease: string; lock: string } {
  const root = mkdtempSync(join(tmpdir(), "sept-lease-mutex-"));
  const lease = join(root, "worker.lease");
  const lock = `${lease}.lock`;
  writeFileSync(lock, "", { mode: 0o600 });
  return { root, lease, lock };
}

await test("shared SQLite notice adapter restores the exact warning owner", () => {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Compared by identity only, never invoked unbound.
  const original = process.emitWarning;
  const restore = adaptSqliteNotice(NOOP_TELEMETRY);
  try {
    assert.equal(process.emitWarning === original, false);
  } finally {
    restore();
  }
  assert.equal(process.emitWarning === original, true);
});

function deadOwner(path: string, age = 6_000): string {
  assert.throws(() => process.kill(999_999, 0));
  const stale = new Date(Date.now() - age);
  const body = JSON.stringify({
    ownerId: "dead-local",
    pid: 999_999,
    hostname: hostname(),
    processStartedAt: 1,
    heartbeatAt: stale.toISOString(),
  });
  writeFileSync(path, body, { mode: 0o600 });
  utimesSync(path, stale, stale);
  return body;
}

function childScript(root: string, lock: boolean): string {
  const facade = pathToFileURL(resolve("dist/src/durable/index.js")).href;
  return `import { acquireStateRootLease } from ${JSON.stringify(facade)};
import { DatabaseSync } from "node:sqlite";
let release;
let mutex;
const guard = setTimeout(() => { release?.(); mutex?.close(); process.exit(1); }, 10000);
process.on("message", message => {
  if (message === "acquire") {
    try {
      ${lock ? `mutex = new DatabaseSync(${JSON.stringify(join(root, "worker.lease.lock"))}); mutex.exec("BEGIN EXCLUSIVE");` : `release = acquireStateRootLease(${JSON.stringify(root)});`}
      process.send({ acquired: true, pid: process.pid });
    } catch {
      process.send({ acquired: false, pid: process.pid });
    }
  } else {
    release?.(); mutex?.close(); clearTimeout(guard); process.disconnect();
  }
});
process.send("ready");`;
}

async function competitor(root: string, lock = false): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", childScript(root, lock)],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH },
    },
  );
  const ready: unknown[] = await once(child, "message");
  assert.equal(ready[0], "ready");
  return child;
}

async function acquire(child: ChildProcess): Promise<boolean> {
  const reply = once(child, "message");
  child.send("acquire");
  const values: unknown[] = await reply;
  const value = values[0];
  assert.ok(typeof value === "object" && value !== null && "acquired" in value);
  assert.equal(typeof value.acquired, "boolean");
  return value.acquired === true;
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, "close");
  child.send("release");
  await closed;
  assert.equal(child.exitCode, 0);
}

await test("stale reclaim and claim refuse a held mutex, then preserve its private stable inode", async () => {
  const { root, lease, lock } = fixture();
  const before = deadOwner(lease);
  const inode = statSync(lock).ino;
  const mutex = new DatabaseSync(lock);
  mutex.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => acquireStateRootLease(root), /recent ownership lease/);
    assert.equal(readFileSync(lease, "utf8"), before);
    const child = await competitor(root, true);
    try {
      assert.equal(await acquire(child), false, "refusal must retain the actual kernel lock");
    } finally {
      await closeChild(child);
    }
  } finally {
    mutex.close();
  }
  const release = acquireStateRootLease(root);
  assert.notEqual(readFileSync(lease, "utf8"), before);
  release();
  release();
  assert.equal(statSync(lock).ino, inode);
  assert.equal(statSync(lock).size, 0);
  assert.equal(statSync(lock).mode & 0o777, 0o600);
});

await test("recent dead owners and nonprivate mutexes refuse takeover without altering evidence", () => {
  const { root, lease, lock } = fixture();
  const before = deadOwner(lease, 0);
  assert.throws(() => acquireStateRootLease(root), /recent ownership lease/);
  assert.equal(readFileSync(lease, "utf8"), before);
  chmodSync(lock, 0o644);
  assert.throws(() => acquireStateRootLease(root), SeptError);
  assert.equal(readFileSync(lease, "utf8"), before);
});

await test("process death releases the mutex without replacing its inode", async () => {
  const { root, lock } = fixture();
  const inode = statSync(lock).ino;
  const child = await competitor(root, true);
  try {
    assert.equal(await acquire(child), true);
    assert.throws(() => acquireStateRootLease(root), /recent ownership lease/);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    const release = acquireStateRootLease(root);
    release();
    assert.equal(statSync(lock).ino, inode);
  } finally {
    await closeChild(child);
  }
});

await test("competing normal stale acquisitions return one authoritative live owner", async () => {
  const { root, lease } = fixture();
  deadOwner(lease);
  const children: ChildProcess[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      children.push(await competitor(root));
    }
    const acquired = await Promise.all(children.map((child) => acquire(child)));
    assert.equal(acquired.filter(Boolean).length, 1);
    const winner = children[acquired.indexOf(true)];
    assert.ok(winner);
    const owner: unknown = JSON.parse(readFileSync(lease, "utf8"));
    assert.ok(typeof owner === "object" && owner !== null && "pid" in owner);
    assert.equal(owner.pid, winner.pid);
    assert.throws(() => acquireStateRootLease(root), /already owned by pid/);
  } finally {
    for (const child of children) {
      await closeChild(child);
    }
  }
  const release = acquireStateRootLease(root);
  release();
});
