/** Supporting policy/helper seam race; B3 installed cases own real namespace/descendant confinement. */
import assert from "node:assert/strict";
import { once } from "node:events";
import type { FSWatcher } from "node:fs";
import test from "node:test";
import {
  CapabilityPolicyStore,
  type CapabilityPolicy,
  SeptError,
} from "../../src/durable/index.js";
import {
  capabilityBinding,
  defaultCapabilities,
} from "../../src/execution/capability-admission.js";
import { verifyHandsPolicy, watchHandsPolicy } from "../../src/execution/capability-requests.js";
import type { DockerHandsConfiguration, HandsCommandExit } from "../../src/execution/contracts.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { HandsNativeChild } from "../../src/execution/hands-native-child.js";
import { HandsProcessOwner } from "../../src/execution/hands-process-owner.js";
import { suppliedEngine, engineFrame } from "./backend-support.js";

type RaceOrder = "deny-before-start" | "start-before-deny";
interface Barrier {
  promise: Promise<void>;
  release: () => void;
}

void test(
  "selected helper rechecks durable denial before start and refuses partial success after start",
  { timeout: 10_000 },
  async () => {
    for (const order of ["deny-before-start", "start-before-deny"] as const) {
      await exerciseRevocation(order);
    }
  },
);

function barrier(): Barrier {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function configuration(
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
): DockerHandsConfiguration {
  return {
    profile: "docker-linux-warm-v1",
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    shell: false,
    readOnlyMounts: [],
    imageSelected: [{ alias: "baked" }],
  };
}

interface RevocationFixture {
  fixture: Awaited<ReturnType<typeof suppliedEngine>>;
  engine: DockerEngineControl;
  configured: DockerHandsConfiguration;
  store: CapabilityPolicyStore;
  policy: CapabilityPolicy;
  stopped: AbortController;
  entered: Barrier;
  proceed: Barrier;
  denied: Barrier;
  watcher: FSWatcher;
}

async function openRevocationFixture(): Promise<RevocationFixture> {
  const fixture = await suppliedEngine();
  const engine = await DockerEngineControl.open(fixture.path);
  const configured = configuration(fixture);
  const store = new CapabilityPolicyStore(fixture.root);
  const policy = activatePolicy(store, configured);
  const stopped = new AbortController();
  const denied = barrier();
  const watcher = watchHandsPolicy(
    store.path,
    () => verifyHandsPolicy(configured, store, policy),
    () => {
      stopped.abort();
      denied.release();
      return Promise.resolve();
    },
  );
  return {
    fixture,
    engine,
    configured,
    store,
    policy,
    stopped,
    denied,
    watcher,
    entered: barrier(),
    proceed: barrier(),
  };
}

async function exerciseRevocation(order: RaceOrder): Promise<void> {
  const race = await openRevocationFixture();
  try {
    const owner = await HandsProcessOwner.open(race.configured, race.engine, {
      pid: 42,
      start: "123",
    });
    const observed = observeOwnership(race.engine);
    const pending = startHelper(owner, race, order);
    await waitFor(race.entered.promise);
    assert.equal(observed.starts(), order === "deny-before-start" ? 0 : 1);
    race.store.revoke(race.policy.revision);
    assert.equal(race.store.read()?.denied, true);
    await waitFor(race.denied.promise);
    race.proceed.release();
    await waitFor(pending.closed);
    assertSettlement(pending, order);
    observed.assertJoined();
    await assertNoFutureStart(owner, race.configured, race.store, race.policy, observed.starts);
  } finally {
    race.proceed.release();
    race.watcher.close();
    try {
      await race.engine.close();
    } finally {
      await race.fixture.close();
    }
  }
}

function startHelper(
  owner: HandsProcessOwner,
  race: RevocationFixture,
  order: RaceOrder,
): {
  child: HandsNativeChild;
  errors: Error[];
  exits: HandsCommandExit[];
  output: string[];
  closed: Promise<void>;
} {
  const exits: HandsCommandExit[] = [];
  const output: string[] = [];
  race.fixture.facts.commandChunks = [engineFrame(1, "partial match\n")];
  const child = helper(
    owner,
    race.stopped.signal,
    exits,
    () => authorizeRace(race, order),
    () => holdOutput(race, order),
  );
  const errors: Error[] = [];
  child.on("error", (error: Error) => errors.push(error));
  child.stdout.on("data", (bytes: Buffer) => output.push(bytes.toString()));
  child.stderr.resume();
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  return { child, errors, exits, output, closed };
}

async function authorizeRace(race: RevocationFixture, order: RaceOrder): Promise<void> {
  if (order === "deny-before-start") {
    race.entered.release();
    await race.proceed.promise;
  }
  verifyHandsPolicy(race.configured, race.store, race.policy);
}

async function holdOutput(race: RevocationFixture, order: RaceOrder): Promise<void> {
  if (order === "start-before-deny") {
    race.entered.release();
    await race.proceed.promise;
  }
}

function assertSettlement(pending: ReturnType<typeof startHelper>, order: RaceOrder): void {
  assert.equal(pending.errors.length, 1);
  assert.ok(pending.errors[0] instanceof SeptError);
  assert.equal(pending.child.killed, false);
  assert.equal(pending.child.stdout.readableEnded, true);
  assert.equal(pending.child.stderr.readableEnded, true);
  assert.deepEqual(pending.output, order === "deny-before-start" ? [] : ["partial match\n"]);
  assert.equal(
    pending.exits[0]?.termination,
    order === "deny-before-start" ? undefined : "aborted",
  );
}

function activatePolicy(
  store: CapabilityPolicyStore,
  configured: DockerHandsConfiguration,
): CapabilityPolicy {
  store.initialize(
    {
      ...defaultCapabilities(),
      workspace: { read: true, write: false },
      selected: [{ root: "/selected/baked", read: true, write: false }],
    },
    capabilityBinding(configured),
  );
  const policy = store.read();
  assert.ok(policy);
  return policy;
}

function helper(
  owner: HandsProcessOwner,
  stop: AbortSignal,
  exits: HandsCommandExit[],
  authorize: () => Promise<void>,
  hold: () => Promise<void>,
): HandsNativeChild {
  return new HandsNativeChild(
    async (command, output, signal) => {
      assert.ok(signal);
      const exit = await owner.execute(
        { ...command, commandId: 1 },
        { network: false, signal: AbortSignal.any([signal, stop]), authorize },
        async (text, stream) => {
          output(Buffer.from(text), stream);
          await hold();
        },
      );
      exits.push(exit);
      return exit;
    },
    "rg",
    ["--", "needle", "/selected/baked"],
    "/workspace",
  );
}

function observeOwnership(engine: DockerEngineControl): {
  starts: () => number;
  assertJoined: () => void;
} {
  const attach = engine.attach.bind(engine);
  const exec = engine.exec.bind(engine);
  let starts = 0;
  let attachments = 0;
  let joins = 0;
  engine.attach = async (id, execution) => {
    const attachment = await attach(id, execution);
    if (execution.commandOutput === true) {
      starts += 1;
      void attachment.joined.then(() => {
        attachments += 1;
      });
    }
    return attachment;
  };
  engine.exec = (id, execution) => {
    if (execution.command.includes("--join")) {
      joins += 1;
    }
    return exec(id, execution);
  };
  return {
    starts: () => starts,
    assertJoined: () => {
      assert.equal(attachments, starts);
      assert.equal(joins, 1);
    },
  };
}

async function assertNoFutureStart(
  owner: HandsProcessOwner,
  configured: DockerHandsConfiguration,
  store: CapabilityPolicyStore,
  policy: CapabilityPolicy,
  starts: () => number,
): Promise<void> {
  const before = starts();
  const child = helper(
    owner,
    new AbortController().signal,
    [],
    () =>
      Promise.resolve().then(() => {
        verifyHandsPolicy(configured, store, policy);
      }),
    () => Promise.resolve(),
  );
  const failure = once(child, "error");
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  child.stdout.resume();
  child.stderr.resume();
  await failure;
  await waitFor(closed);
  assert.equal(starts(), before);
}

async function waitFor(promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new assert.AssertionError({ message: "Helper race barrier did not settle" }));
        }, 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
