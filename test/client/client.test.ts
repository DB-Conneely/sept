/** Real HTTP method/envelope tests and production ingress/durable-receipt integration. */
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskClient, TaskClientError } from "../../src/client/index.js";
import {
  GateHost,
  ResultHost,
  serviceEnvironment,
  sessionResponse,
  startService,
  waitFor,
} from "../runtime/support.js";
import { RunStore } from "../../src/durable/index.js";
import { join } from "node:path";
import {
  clientFailure,
  conversationEvent,
  jsonReply,
  loopback,
  projection,
  requestBody,
  TOKEN,
} from "./support.js";

const EXPECTED_REQUESTS = [
  {
    method: "POST",
    url: "/v1/webhooks",
    body: {
      version: 1,
      source: "app",
      eventId: "task-id",
      kind: "task",
      task: { task: "  preserve\n" },
    },
  },
  {
    method: "POST",
    url: "/v1/webhooks",
    body: {
      version: 1,
      source: "app",
      eventId: "message-id",
      kind: "operator_message",
      runId: "run-1",
      message: " exact later evidence\n",
    },
  },
  { method: "GET", url: "/v1/tasks/run-1", body: undefined },
  { method: "GET", url: "/v1/tasks/run-1/conversation?after=1&limit=2", body: undefined },
  { method: "POST", url: "/v1/tasks/run-1/cancel", body: undefined },
];

void test("all five client methods reach real HTTP with exact version-one envelopes and an empty cancel body", async () => {
  const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
  const fixture = await loopback((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    const collected =
      request.method === "POST" && request.url === "/v1/webhooks"
        ? requestBody(request)
        : Promise.resolve(undefined);
    void collected.then((body) => {
      requests.push({ method: request.method, url: request.url, body });
      methodReply(response, request.url, body);
    });
  });
  try {
    const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN });
    await assertFiveMethods(client);
    assert.deepEqual(requests, EXPECTED_REQUESTS);
  } finally {
    await fixture.close();
  }
});

async function assertFiveMethods(
  client: import("../../src/client/index.js").TaskClient,
): Promise<void> {
  assert.equal(
    (
      await client.createTask({
        source: "app",
        eventId: "task-id",
        task: { task: "  preserve\n" },
      })
    ).runId,
    "run-1",
  );
  assert.equal(
    (
      await client.sendMessage({
        source: "app",
        eventId: "message-id",
        runId: "run-1",
        message: " exact later evidence\n",
      })
    ).messageId,
    "message-1",
  );
  assert.equal((await client.getTask("run-1")).state.status, "waiting");
  assert.equal((await client.getConversation("run-1", { after: 1, limit: 2 })).nextCursor, 2);
  assert.deepEqual(await client.cancel("run-1"), {
    runId: "run-1",
    status: "cancelling",
    cancelled: true,
  });
}

function methodReply(
  response: import("node:http").ServerResponse,
  url: string | undefined,
  body: unknown,
): void {
  if (url === "/v1/webhooks") {
    assert.ok(typeof body === "object" && body !== null && "kind" in body);
    if (body.kind === "task") {
      jsonReply(
        response,
        { kind: "task", runId: "run-1", status: "active", duplicate: false },
        202,
      );
    } else {
      jsonReply(
        response,
        { kind: "operator_message", runId: "run-1", messageId: "message-1", duplicate: false },
        202,
      );
    }
  } else if (url?.endsWith("/cancel")) {
    jsonReply(response, { runId: "run-1", status: "cancelling", cancelled: true }, 202);
  } else if (url?.includes("/conversation")) {
    jsonReply(response, {
      events: [conversationEvent(2)],
      retainedFrom: 1,
      nextCursor: 2,
      terminal: null,
    });
  } else {
    jsonReply(response, projection());
  }
}

async function receiptFixture() {
  const environment = serviceEnvironment();
  const host = new ResultHost([
    sessionResponse("waiting", "Need later evidence."),
    sessionResponse("complete", "Evidence accepted."),
  ]);
  const started = await startService(environment.root, environment.stateRoot, () =>
    Promise.resolve(host),
  );
  const client = createTaskClient({ baseUrl: started.base, token: "part1-token" });
  return { environment, started, client };
}

void test("client stable task/message receipts survive later state, with collision and wrong bearer classified", async () => {
  const { environment, started, client } = await receiptFixture();
  try {
    const input = {
      source: "client-test",
      eventId: "task-stable",
      task: { task: "preserve task receipt", workspace: environment.workspace },
    };
    const receipt = await client.createTask(input);
    assert.equal(receipt.duplicate, false);
    await waitFor(
      () =>
        new RunStore(join(environment.stateRoot, receipt.runId)).snapshot().status === "waiting",
    );
    assert.equal((await client.getTask(receipt.runId)).state.status, "waiting");
    assert.deepEqual(await client.createTask(input), { ...receipt, duplicate: true });
    await assert.rejects(
      client.createTask({ ...input, task: { ...input.task, task: "collision" } }),
      clientFailure("http", 409),
    );
    const message = {
      source: "client-test",
      eventId: "message-stable",
      runId: receipt.runId,
      message: " exact accepted evidence\n",
    };
    const accepted = await client.sendMessage(message);
    await waitFor(
      () =>
        new RunStore(join(environment.stateRoot, receipt.runId)).snapshot().status === "complete",
    );
    await assertSettledReceipts(client, input, receipt, message, accepted);
    await assert.rejects(
      createTaskClient({ baseUrl: started.base, token: TOKEN }).getTask(receipt.runId),
      clientFailure("http", 401),
    );
  } finally {
    await started.service.stop();
  }
});

async function assertSettledReceipts(
  client: import("../../src/client/index.js").TaskClient,
  input: import("../../src/client/index.js").CreateTaskInput,
  receipt: import("../../src/client/index.js").TaskAdmission,
  message: import("../../src/client/index.js").SendMessageInput,
  accepted: import("../../src/client/index.js").MessageAdmission,
): Promise<void> {
  assert.deepEqual(await client.sendMessage(message), { ...accepted, duplicate: true });
  await assert.rejects(
    client.sendMessage({ ...message, message: "collision" }),
    clientFailure("http", 409),
  );
  assert.equal((await client.createTask(input)).status, "active");
  const page = await client.getConversation(receipt.runId);
  assert.equal(page.terminal?.status, "complete");
  assert.ok(
    page.events.some((event) => event.type === "message" && event.text === message.message),
  );
  assert.equal((await client.cancel(receipt.runId)).cancelled, false);
}

void test("client targeted cancellation and occupied slot reach actual ingress/runtime settlement", async () => {
  const environment = serviceEnvironment();
  const host = new GateHost();
  const started = await startService(environment.root, environment.stateRoot, () =>
    Promise.resolve(host),
  );
  const client = createTaskClient({ baseUrl: started.base, token: "part1-token" });
  try {
    const input = {
      source: "client-test",
      eventId: "cancel-stable",
      task: { task: "cancel the correct run", workspace: environment.workspace },
    };
    const receipt = await client.createTask(input);
    await waitFor(() => host.prompts.length === 1);
    await assert.rejects(
      client.createTask({ ...input, eventId: "occupied-slot" }),
      clientFailure("http", 409),
    );
    await assert.rejects(client.cancel("unknown-run"), clientFailure("http", 404));
    const result = await client.cancel(receipt.runId);
    assert.equal(result.cancelled, true);
    assert.ok(result.status === "cancelling" || result.status === "cancelled");
    await waitFor(
      () =>
        new RunStore(join(environment.stateRoot, receipt.runId)).snapshot().status === "cancelled",
    );
    assert.equal((await client.getTask(receipt.runId)).state.status, "cancelled");
    assert.equal((await client.cancel(receipt.runId)).status, "cancelled");
    assert.equal(host.aborted, 1);
  } finally {
    await started.service.stop();
  }
});

void test("client malformed success envelopes are protocol failures through loopback transport", async () => {
  let status = 200;
  let body: unknown = projection();
  const fixture = await loopback((request, response) => {
    request.resume();
    jsonReply(response, body, status);
  });
  const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN });
  try {
    for (const invalid of [
      null,
      { ...projection(), extra: "hostile-secret" },
      projection("wrong-run"),
    ]) {
      body = invalid;
      await assert.rejects(client.getTask("run-1"), clientFailure("protocol"));
    }
    body = projection();
    status = 202;
    await assert.rejects(client.getTask("run-1"), clientFailure("protocol"));
    body = { kind: "task", runId: "run-1", status: "active", duplicate: false };
    status = 200;
    await assert.rejects(
      client.createTask({ source: "app", eventId: "id", task: { task: "x" } }),
      clientFailure("protocol"),
    );
    assert.ok(new TaskClientError("protocol") instanceof TaskClientError);
  } finally {
    await fixture.close();
  }
});
