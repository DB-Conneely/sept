import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Keep release credentials out of builds, tests and installed consumer processes. */
export function environment(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, OTEL_SDK_DISABLED: "true", ...extra };
}

/** Join a bounded command and record its actual result before interpreting success. */
export function command(cwd, program, args, record, options = {}) {
  const started = new Date().toISOString();
  const { rawOutput = false, ...executionOptions } = options;
  const result = spawnSync(program, args, {
    cwd,
    env: environment(),
    encoding: "utf8",
    timeout: 1_800_000,
    maxBuffer: 16 * 1024 * 1024,
    ...executionOptions,
  });
  record({
    command: [program, ...args],
    cwd,
    pid: result.pid,
    started,
    finished: new Date().toISOString(),
    code: result.status,
    signal: result.signal,
    joined: true,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.code,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(
    { code: result.status, signal: result.signal },
    { code: 0, signal: null },
    result.stderr,
  );
  return rawOutput ? result.stdout : result.stdout.trim();
}

/** Capture a finite installed worker; a hard deadline remains a failed proof. */
export function managed(cwd, args, env, record) {
  const child = spawn(args[0], args.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const item = {
    command: args,
    cwd,
    pid: child.pid,
    started: new Date().toISOString(),
    stdout: "",
    stderr: "",
    joined: false,
  };
  const capture = (key, chunk) => {
    if (Buffer.byteLength(item[key]) + chunk.length > 1024 * 1024) {
      item.overflow = true;
      child.kill("SIGKILL");
      return;
    }
    item[key] += chunk.toString();
  };
  child.stdout.on("data", (chunk) => capture("stdout", chunk));
  child.stderr.on("data", (chunk) => capture("stderr", chunk));
  child.once("error", (error) => {
    item.error = error.code;
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const joined = new Promise((resolveJoin) =>
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      Object.assign(item, { code, signal, joined: true, finished: new Date().toISOString() });
      record(item);
      resolveJoin(item);
    }),
  );
  return { child, item, joined };
}

/** Read the actual bound listener address with a finite startup budget. */
export async function ready(worker) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const match = worker.item.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) {
      return `http://127.0.0.1:${match[1]}`;
    }
    assert.equal(worker.item.joined, false, worker.item.stderr);
    await delay(100);
  }
  assert.fail("Installed worker readiness budget exhausted");
}

/** Signal and await the owned process, preserving failed or forced exits. */
export async function stop(worker, signal = () => worker.child.kill("SIGTERM")) {
  if (!worker.item.joined) {
    signal();
  }
  const result = await worker.joined;
  assert.equal(result.error, undefined);
  assert.equal(result.overflow, undefined);
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    result.stderr,
  );
}
