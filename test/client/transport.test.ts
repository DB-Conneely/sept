/** Hostile real HTTP boundaries; no mocked fetch replaces streaming/cancellation behavior. */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createTaskClient } from "../../src/client/index.js";
import { requestJson } from "../../src/client/transport.js";
import { clientConfiguration } from "../../src/client/request-codecs.js";
import { clientFailure, jsonReply, loopback, projection, TOKEN } from "./support.js";

void test("requestJson refuses redirects without forwarding bearer and classifies transport failure", async () => {
  let redirected = 0;
  const target = await loopback((request, response) => {
    redirected += 1;
    request.resume();
    jsonReply(response, projection());
  });
  const fixture = await loopback((request, response) => {
    request.resume();
    response.writeHead(302, { Location: `${target.baseUrl}/url-secret` });
    response.end("hostile-secret");
  });
  const configuration = clientConfiguration({ baseUrl: fixture.baseUrl, token: TOKEN });
  try {
    await assert.rejects(
      requestJson(configuration, "/v1/tasks/run-1", "GET", undefined, undefined),
      clientFailure("transport"),
    );
    assert.equal(redirected, 0);
  } finally {
    await fixture.close();
    await target.close();
  }
  await assert.rejects(
    createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN }).getTask("run-1"),
    clientFailure("transport"),
  );
});

void test("HTTP errors discard hostile text and expose positive retainedFrom only on conversation410", async () => {
  let earliest: unknown = 5;
  let status = 410;
  const fixture = await loopback((request, response) => {
    request.resume();
    jsonReply(response, { error: `hostile-secret ${TOKEN}`, retainedFrom: earliest }, status);
  });
  const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN });
  try {
    await assert.rejects(client.getConversation("run-1"), clientFailure("http", 410, 5));
    await assert.rejects(client.getTask("run-1"), clientFailure("http", 410));
    await assert.rejects(client.cancel("run-1"), clientFailure("http", 410));
    for (earliest of [0, -1, 1.5, "5", Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(client.getConversation("run-1"), clientFailure("http", 410));
    }
    earliest = 5;
    status = 409;
    await assert.rejects(client.getConversation("run-1"), clientFailure("http", 409));
  } finally {
    await fixture.close();
  }
});

void test("streamed response exact5MiB succeeds and plus-one/invalidJSON/UTF8 fail without body disclosure", async () => {
  let body: Buffer = Buffer.from(JSON.stringify(projection()));
  const fixture = await loopback((request, response) => {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write(body.subarray(0, 127));
    response.end(body.subarray(127));
  });
  const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN });
  try {
    const valid = JSON.stringify(projection());
    body = Buffer.from(valid + " ".repeat(5 * 1024 * 1024 - Buffer.byteLength(valid)));
    assert.equal((await client.getTask("run-1")).manifest.runId, "run-1");
    body = Buffer.concat([body, Buffer.from(" ")]);
    await assert.rejects(client.getTask("run-1"), clientFailure("protocol"));
    for (const invalid of [
      Buffer.from(`hostile-secret ${TOKEN}`),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(""),
    ]) {
      body = invalid;
      await assert.rejects(client.getTask("run-1"), clientFailure("protocol"));
    }
  } finally {
    await fixture.close();
  }
});

void test("request exact256KiB transmits and UTF8 plus-one fails before an HTTP request", async () => {
  let count = 0;
  let observed = 0;
  const fixture = await loopback((request, response) => {
    count += 1;
    request.on("data", (chunk: Buffer) => {
      observed += chunk.byteLength;
    });
    request.on("end", () => {
      jsonReply(
        response,
        { kind: "task", runId: "run-1", status: "active", duplicate: false },
        202,
      );
    });
  });
  try {
    const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN });
    const input = { source: "app", eventId: "byte-boundary", task: { task: "" } };
    const overhead = Buffer.byteLength(
      JSON.stringify({
        version: 1,
        source: input.source,
        eventId: input.eventId,
        kind: "task",
        task: input.task,
      }),
    );
    input.task.task = `é${"x".repeat(256 * 1024 - overhead - 2)}`;
    await client.createTask(input);
    assert.equal(observed, 256 * 1024);
    input.task.task += "x";
    await assert.rejects(client.createTask(input), clientFailure("configuration"));
    assert.equal(count, 1);
  } finally {
    await fixture.close();
  }
});

void test("caller abort before and during fetch settles listeners, and first abort cause beats later timeout", async () => {
  let observed = 0;
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fixture = await loopback((request, response) => {
    observed += 1;
    request.resume();
    response.writeHead(200);
    response.write("{");
    started?.();
  });
  const controller = new AbortController();
  const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN, timeoutMs: 500 });
  try {
    const pre = new AbortController();
    pre.abort("abort-secret");
    await assert.rejects(client.getTask("run-1", { signal: pre.signal }), clientFailure("aborted"));
    assert.equal(observed, 0);
    assert.equal(getEventListeners(pre.signal, "abort").length, 0);
    const pending = client.getTask("run-1", { signal: controller.signal });
    await requestStarted;
    controller.abort("abort-secret");
    await assert.rejects(pending, clientFailure("aborted"));
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await fixture.close();
  }
});

void test("timeout before headers and during streaming is first cause even after later caller abort", async () => {
  let streaming = false;
  const fixture = await loopback((request, response) => {
    request.resume();
    if (streaming) {
      response.writeHead(200);
      response.write("{");
    }
  });
  try {
    for (const stream of [false, true]) {
      streaming = stream;
      const controller = new AbortController();
      const client = createTaskClient({ baseUrl: fixture.baseUrl, token: TOKEN, timeoutMs: 30 });
      await assert.rejects(
        client.getTask("run-1", { signal: controller.signal }),
        clientFailure("timeout"),
      );
      controller.abort("abort-secret");
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  } finally {
    await fixture.close();
  }
});
