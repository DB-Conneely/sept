import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { environment } from "./process.mjs";
import { sameIntegrity } from "./release-contract.mjs";

/** Public registry reads are finite, credential-free, and distinguish missing from real failures. */
export function npmView(specification, field, record, timeoutMs = 15_000) {
  const args = [
    "view",
    specification,
    field,
    "--json",
    "--registry=https://registry.npmjs.org",
    "--prefer-online",
    "--fetch-retries=0",
    "--fetch-timeout=10000",
  ];
  const started = new Date().toISOString();
  const result = spawnSync("npm", args, {
    env: environment(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  record({
    command: ["npm", ...args],
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
  assert.equal(result.error, undefined, "npm registry read failed or timed out");
  assert.equal(result.signal, null);
  return registryValue(result.status, result.stdout);
}

/** Only a structured E404 is pending; authentication, malformed data and other errors fail closed. */
export function registryValue(status, text) {
  const result = JSON.parse(text);
  if (status === 0) {
    assert.equal(typeof result, "string", "Malformed npm registry field");
    assert.ok(result.length > 0 && result.length <= 512);
    return result;
  }
  assert.equal(status, 1);
  assert.equal(result.error?.code, "E404", "npm registry rejected the read; inspect its receipt");
  return undefined;
}

/** Accepted uploads can remain invisible during scanning; wait at most 20 minutes without republishing. */
export async function waitForIntegrity({
  read,
  expected,
  record,
  timeoutMs = 1_200_000,
  intervalMs = 15_000,
  now = () => performance.now(),
  pause = delay,
}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1_200_000);
  assert.ok(Number.isFinite(intervalMs) && intervalMs > 0);
  const started = now();
  const deadline = started + timeoutMs;
  for (let attempt = 1; attempt <= 81; attempt += 1) {
    const remaining = deadline - now();
    if (remaining < 1) {
      break;
    }
    const actual = read(Math.floor(Math.min(15_000, remaining)));
    record({
      attempt,
      elapsedMs: now() - started,
      state: actual === undefined ? "pending" : "visible",
    });
    if (actual !== undefined) {
      sameIntegrity(expected, actual);
      return actual;
    }
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  assert.fail(
    "npm version remains unavailable after the bounded scanning wait; do not republish it. Re-run failed jobs with the retained submission receipt, or inspect the npm package/account status.",
  );
}

/** Restore only this run's exact artifact identity; an uncertain accepted submission is never repeated. */
export function priorSubmission(root, binding) {
  const attempts = readdirSync(root)
    .filter((name) => /^sept-publication-attempt[1-9]\d*$/.test(name))
    .sort((a, b) => Number(a.split("attempt")[1]) - Number(b.split("attempt")[1]));
  const flat = existsSync(join(root, "npm-submission.json"));
  assert.ok(!(flat && attempts.length), "Ambiguous submission receipt layouts");
  let previous;
  for (const name of flat ? [""] : attempts) {
    const path = join(root, name, "npm-submission.json");
    if (!existsSync(path)) {
      continue;
    }
    assert.ok(statSync(path).size <= 8192, "Submission receipt exceeds its bound");
    const value = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(
      value.binding,
      binding,
      "Restored submission belongs to another source/run/artifact",
    );
    assert.ok(["submitted", "accepted", "rejected-auth"].includes(value.state));
    previous = value;
  }
  return previous;
}

/** Only definite pre-acceptance auth codes permit another submission; ambiguous failures retain ownership. */
export function submissionState(code, stdout) {
  if (code === 0) {
    return "accepted";
  }
  let failure;
  try {
    failure = JSON.parse(stdout);
  } catch {
    return "submitted";
  }
  return ["E401", "ENEEDAUTH", "EOTP"].includes(failure.error?.code)
    ? "rejected-auth"
    : "submitted";
}

/** A retry without a durable submission receipt cannot prove that repeating an upload is safe. */
export function shouldSubmit(previous, attempt) {
  assert.match(attempt, /^[1-9]\d*$/);
  assert.ok(
    attempt === "1" || previous,
    "Retry has no submission receipt and npm is unavailable; do not guess whether an upload was accepted. Inspect the prior run and npm status, then use a new main push/version if necessary.",
  );
  return !previous || previous.state === "rejected-auth";
}
