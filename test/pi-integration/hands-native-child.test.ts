/** Supporting facade/codec regressions; installed Pi callback execution is qualified on the patched image. */
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { HandsNativeChild, spawnHandsNativeChild } from "../../src/execution/hands-native-child.js";
import {
  assertHandsCommand,
  commandExecutable,
} from "../../src/execution/hands-command-authority.js";
import type {
  HandsCommandStart,
  HandsRequest,
  HandsCommandExecutor,
  HandsCommandExit,
} from "../../src/execution/contracts.js";

const EXIT: HandsCommandExit = { code: 0, signal: null, termination: "exit" };
const STDIO = { stdio: ["ignore", "pipe", "pipe"] } as const;
void test("spawnHandsNativeChild permits only fixed image executables/stdio and an active owner", async () => {
  const execute: HandsCommandExecutor = (command) => {
    assert.deepEqual(command, {
      program: "rg",
      argv: ["--", "needle", "/workspace"],
      cwd: "/workspace",
    });
    return Promise.resolve(EXIT);
  };
  const child = spawnHandsNativeChild(
    execute,
    "/workspace",
    "/usr/local/libexec/sept/rg",
    ["--", "needle", "/workspace"],
    { stdio: [...STDIO.stdio] },
  );
  await once(child, "close");
  assert.equal(child.kill(), false);
  assertSpawnRefusals(execute);
});
function assertSpawnRefusals(execute: HandsCommandExecutor): void {
  for (const path of ["/bin/sh", "/tmp/rg", "rg"]) {
    assert.throws(
      () => spawnHandsNativeChild(execute, "/workspace", path, [], { stdio: [...STDIO.stdio] }),
      SeptError,
    );
  }
  assert.throws(
    () =>
      spawnHandsNativeChild(undefined, "/workspace", "/home/sept-hands/.pi/agent/bin/fd", [], {
        stdio: [...STDIO.stdio],
      }),
    SeptError,
  );
  const injected = { stdio: [...STDIO.stdio], env: {} };
  assert.throws(
    () =>
      spawnHandsNativeChild(execute, "/workspace", "/usr/local/libexec/sept/rg", [], {
        ...injected,
        stdio: [...STDIO.stdio],
      }),
    SeptError,
  );
}

void test("HandsNativeChild preserves separate streams and emits close only after executor join and stream drain", async () => {
  let join: (exit: HandsCommandExit) => void = () => undefined;
  const joined = new Promise<HandsCommandExit>((resolve) => {
    join = resolve;
  });
  const execute: HandsCommandExecutor = (_command, output) => {
    output(Buffer.from("stdout 🐟\n"), "stdout");
    output(Buffer.from("stderr €\n"), "stderr");
    return joined;
  };
  const child = new HandsNativeChild(execute, "rg", [], "/workspace");
  const output = observeChild(child);
  let closed = false;
  child.on("close", () => {
    closed = true;
  });
  const close = once(child, "close");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  join(EXIT);
  await close;
  assert.deepEqual(output, { stdout: "stdout 🐟\n", stderr: "stderr €\n", errors: [] });
  assert.equal(child.stdout.readableEnded, true);
  assert.equal(child.stderr.readableEnded, true);
});
function observeChild(child: HandsNativeChild): {
  stdout: string;
  stderr: string;
  errors: Error[];
} {
  const output: { stdout: string; stderr: string; errors: Error[] } = {
    stdout: "",
    stderr: "",
    errors: [],
  };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString("utf8");
  });
  child.on("error", (error: Error) => {
    output.errors.push(error);
  });
  return output;
}

void test("HandsNativeChild native kill uses registered cancellation and keeps native limit close semantics", async () => {
  let cancelled = false;
  const execute: HandsCommandExecutor = (_command, output, signal) => {
    assert.ok(signal);
    const result = new Promise<HandsCommandExit>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          resolve({ ...EXIT, code: 137, termination: "aborted" });
        },
        { once: true },
      );
    });
    output(Buffer.from("first match\n"), "stdout");
    return result;
  };
  const child = new HandsNativeChild(execute, "rg", [], "/workspace");
  const output = observeChild(child);
  child.stdout.on("data", () => {
    assert.equal(child.kill(), true);
  });
  await once(child, "close");
  assert.equal(cancelled, true);
  assert.equal(child.kill(), false);
  assert.equal(output.errors.length, 0);
});

void test("HandsNativeChild never turns enclosing cancellation, timeout, overflow or loss into native partial success", async () => {
  for (const termination of ["aborted", "timeout", "overflow"] as const) {
    await assertNativeFailure((_command, output) => {
      output(Buffer.from("partial\n"), "stdout");
      return Promise.resolve({ ...EXIT, termination });
    });
  }
  await assertNativeFailure(() => Promise.reject(new SeptError("control lost")));
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Deliberately hostile external rejection proves normalization, never a production failure convention.
  await assertNativeFailure(() => Promise.reject(undefined));
  await assertNativeFailure((_command, output) => {
    output(Buffer.alloc(4 * 1024 * 1024), "stdout");
    output(Buffer.from("x"), "stderr");
    return Promise.resolve(EXIT);
  });
});
async function assertNativeFailure(execute: HandsCommandExecutor): Promise<void> {
  const child = new HandsNativeChild(execute, "fd", [], "/workspace");
  const output = observeChild(child);
  await new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  assert.equal(output.errors.length, 1);
  assert.ok(output.errors[0] instanceof SeptError);
  assert.equal(child.stdout.readableEnded, true);
  assert.equal(child.stderr.readableEnded, true);
}

const SEARCH_REQUEST: Extract<HandsRequest, { kind: "tool" }> = {
  kind: "tool",
  name: "grep",
  callId: "search",
  arguments: { pattern: "a.*b", literal: true, ignoreCase: true, glob: "*.ts", path: "src" },
  grants: [{ root: "/workspace", read: true, write: false }],
};
const SEARCH_COMMAND: HandsCommandStart = {
  commandId: 1,
  program: "rg",
  cwd: "/workspace",
  argv: [
    "--json",
    "--line-number",
    "--color=never",
    "--hidden",
    "--ignore-case",
    "--fixed-strings",
    "--glob",
    "*.ts",
    "--",
    "a.*b",
    "/workspace/src",
  ],
};

void test("assertHandsCommand keeps native rg/fd argv parent-bound without consuming Bash authority", () => {
  const request = SEARCH_REQUEST;
  const command = SEARCH_COMMAND;
  assert.deepEqual(assertHandsCommand(request, command, "/workspace"), { network: false });
  for (const args of [
    command.argv.slice(1),
    [...command.argv, "--follow"],
    [...command.argv.slice(0, -1), "/proc"],
  ]) {
    assert.throws(
      () => assertHandsCommand(request, { ...command, argv: args }, "/workspace"),
      SeptError,
    );
  }
  for (const parent of [
    { ...request, name: "bash" as const },
    { ...request, grants: [{ root: "/workspace", read: false, write: true }] },
    {
      ...request,
      arguments: { ...request.arguments, path: "/tmp/sept-hands-epoch-canary" },
      grants: [{ root: "/tmp", read: true, write: false }],
    },
    { kind: "resources" as const },
  ]) {
    assert.throws(() => assertHandsCommand(parent, command, "/workspace"), SeptError);
  }
  assertFindArgv(request);
  assert.deepEqual(commandExecutable(command, false).slice(-command.argv.length - 2), [
    "/usr/local/libexec/sept/hands-command",
    "rg",
    ...command.argv,
  ]);
});
function assertFindArgv(parent: Extract<HandsRequest, { kind: "tool" }>): void {
  const request = {
    ...parent,
    name: "find" as const,
    arguments: { pattern: "src/**/*.ts", limit: 7 },
  };
  const argv = [
    "--glob",
    "--color=never",
    "--hidden",
    "--max-results",
    "7",
    "--full-path",
    "--",
    "**/src/**/*.ts",
    "/workspace",
  ];
  const command: HandsCommandStart = { commandId: 1, program: "fd", argv, cwd: "/workspace" };
  assert.deepEqual(assertHandsCommand(request, command, "/workspace"), { network: false });
  assert.deepEqual(
    assertHandsCommand(
      request,
      { ...command, argv: [...argv.slice(0, 3), "--no-require-git", ...argv.slice(3)] },
      "/workspace",
    ),
    { network: false },
  );
  assert.throws(
    () => assertHandsCommand(request, { ...command, argv: [...argv, "--no-ignore"] }, "/workspace"),
    SeptError,
  );
}
