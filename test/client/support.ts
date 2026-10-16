/** Used loopback fixtures: own listeners/sockets and preserve strict response/request assertions. */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TaskClientError } from "../../src/client/index.js";
import type { TaskClientErrorKind } from "../../src/client/contracts.js";

/** Non-secret fixture credential whose absence in hostile errors is asserted. */
export const TOKEN = "CLIENT-TOKEN-CANARY-NEVER-EXPOSE";

/** Valid projected immutable manifest and lifecycle snapshot. */
export function projection(runId = "run-1"): object {
  return {
    manifest: {
      formatVersion: 3,
      runId,
      createdAt: "2026-10-16T00:00:00.000Z",
      task: "bounded task",
      role: "",
      workspace: "/workspace/child",
      provider: "fixture",
      model: "fixture",
      thinking: "off",
      maxInvocations: 3,
      maxEpochs: 2,
      timeoutSeconds: 60,
      piVersion: "1.1.0",
    },
    state: {
      status: "waiting",
      phase: "waiting",
      epoch: 1,
      invocations: 1,
      activeMilliseconds: 1,
      activeSessionId: "session-1",
      activeSessionFile: "<pi-session>/session.jsonl",
      startedAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.001Z",
    },
  };
}

/** A valid bounded event can accompany current metadata from a later reopened lifecycle. */
export function conversationEvent(cursor = 1): object {
  return {
    formatVersion: 1,
    cursor,
    id: `event-${String(cursor)}`,
    at: "2026-10-16T00:00:00.000Z",
    type: "message",
    role: "assistant",
    text: "bounded output",
  };
}

/** Verify classification and that no hostile body, token, URL secret or abort reason escaped. */
export function clientFailure(
  kind: TaskClientErrorKind,
  status?: number,
  retainedFrom?: number,
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof TaskClientError);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    assert.equal(error.retainedFrom, retainedFrom);
    assert.ok(error.message.length < 128);
    assert.doesNotMatch(
      `${String(error)} ${JSON.stringify(error)} ${error.stack ?? ""}`,
      /CANARY|hostile-secret|url-secret|abort-secret/,
    );
    return true;
  };
}

/** Own one real loopback HTTP listener and forcibly join its sockets even after failed assertions. */
export async function loopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

/** Consume a fixture request as unknown JSON; the production client remains the request author. */
export async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value;
}

/** Send controlled fixture bytes without replacing any production HTTP decoder. */
export function jsonReply(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
