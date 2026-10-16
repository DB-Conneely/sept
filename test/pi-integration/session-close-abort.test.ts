/** Native abort must join an already closing host instead of addressing a stopped Harness. */
import assert from "node:assert/strict";
import test from "node:test";
import { SeptError } from "../../src/durable/index.js";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import { fixtureBackend, type FixtureExecutionBackend } from "./backend-support.js";
import {
  AbortProviderStream,
  PiFixtureError,
  assistant,
  fixtureDirectories,
  fixtureModelRuntime,
  fixtureStore,
  fixtureStream,
  registerFixtureProvider,
  streamOf,
} from "./support.js";

function boundary(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function nativeHost(
  started?: () => void,
): Promise<{ host: PiSessionHost; backend: FixtureExecutionBackend }> {
  const directories = fixtureDirectories("sept-pi-close-abort-");
  const runtime = await fixtureModelRuntime(directories.agentDir);
  registerFixtureProvider(runtime, "close-abort", (_model, _context, options) =>
    started === undefined
      ? streamOf(assistant([{ type: "text", text: "complete" }], 10, "stop"))
      : fixtureStream(new AbortProviderStream(options?.signal, started)),
  );
  const store = fixtureStore(directories, "close-abort", "join cancellation");
  const backend = fixtureBackend(runtime);
  const host = await PiSessionHost.create(
    store.manifest(),
    store,
    directories.agentDir,
    undefined,
    NOOP_TELEMETRY,
    { modelRuntime: runtime, executionBackend: backend },
  );
  return { host, backend };
}

void test("PiSessionHost abort after a closed host reuses the completed close join", async () => {
  const { host } = await nativeHost();
  try {
    const closing = host.close();
    await closing;
    const aborting = host.abort();
    await assert.doesNotReject(aborting);
    assert.equal(aborting, closing);
  } finally {
    await host.close();
  }
});

void test("PiSessionHost late abort retains an in-flight failed close join", async () => {
  const { host, backend } = await nativeHost();
  const entered = boundary();
  const release = boundary();
  const failure = new PiFixtureError("expected backend close refusal");
  backend.close = async (): Promise<void> => {
    entered.release();
    await release.promise;
    throw failure;
  };
  const closing = host.close();
  const closed = assert.rejects(closing, (error: unknown) => error === failure);
  try {
    await entered.promise;
    const aborting = host.abort();
    const aborted = assert.rejects(aborting, (error: unknown) => error === failure);
    assert.equal(aborting, closing);
    release.release();
    await Promise.all([closed, aborted]);
    await assert.rejects(host.close(), (error: unknown) => error === failure);
  } finally {
    release.release();
    await closed;
  }
});

void test("PiSessionHost close joins a native abort started before closure", async () => {
  const started = boundary();
  const { host } = await nativeHost(started.release);
  const running = assert.rejects(host.run("wait for cancellation"), SeptError);
  try {
    await started.promise;
    const aborting = host.abort();
    const closing = host.close();
    await Promise.all([aborting, closing, running]);
    assert.equal(host.abort(), closing);
  } finally {
    await host.close();
    await running;
  }
});
