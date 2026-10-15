/** Real upgraded sockets exercise tagged attachment pressure; installed Engine proof remains separate. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type ClientRequest, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { EngineControlError } from "../../src/execution/contracts.js";
import { HandsAttachment } from "../../src/execution/hands-processes.js";
import { engineFrame } from "./backend-support.js";

interface AttachmentConnection {
  attachment: HandsAttachment;
  socket: Socket;
  request: ClientRequest;
  requestClosed: () => boolean;
}
interface AttachmentFixture extends AttachmentConnection {
  peer: Duplex;
  close: () => Promise<void>;
}

void test(
  "HandsAttachment pauses at tagged pressure and resumes without losing separate next-frame bytes",
  { timeout: 5000 },
  async (context) => {
    const fixture = await attachmentFixture();
    context.after(fixture.close);
    let inputEvents = 0;
    fixture.socket.on("data", () => {
      inputEvents += 1;
    });
    await holdAtPressure(fixture);
    await writeFrame(fixture.peer, engineFrame(2, "second stderr €\n"));
    assert.equal(fixture.socket.isPaused(), true);
    assert.equal(inputEvents, 1);
    const resumed = once(fixture.socket, "resume");
    const output = collectTagged(fixture.attachment.output);
    await resumed;
    fixture.peer.end();
    assert.deepEqual(await output, [
      { stream: "stdout", text: "first stdout 🐟\n" },
      { stream: "stderr", text: "second stderr €\n" },
    ]);
    await fixture.attachment.close();
    fixture.attachment.assertJoined();
    assert.equal(fixture.socket.closed, true);
    assert.equal(fixture.requestClosed(), true);
  },
);

void test(
  "HandsAttachment abort while tagged output is paused joins its exact socket and request",
  { timeout: 5000 },
  async (context) => {
    const fixture = await attachmentFixture();
    context.after(fixture.close);
    await holdAtPressure(fixture);
    await writeFrame(fixture.peer, engineFrame(2, "queued but unconsumed\n"));
    const peerClosed = socketClosed(fixture.peer);
    await fixture.attachment.abort(EngineControlError.at("closed-owner", Date.now()));
    fixture.peer.destroy();
    await peerClosed;
    assert.equal(fixture.socket.closed, true);
    assert.equal(fixture.requestClosed(), true);
    assert.throws(
      () => {
        fixture.attachment.assertJoined();
      },
      (error: unknown) => {
        assert.ok(error instanceof EngineControlError);
        assert.equal(error.facts.requestJoined, true);
        assert.equal(error.facts.attachmentClosed, true);
        assert.equal(error.facts.connectionsReleased, true);
        return true;
      },
    );
  },
);

async function holdAtPressure(fixture: AttachmentFixture): Promise<void> {
  const paused = once(fixture.socket, "pause");
  fixture.peer.write(engineFrame(1, "first stdout 🐟\n"));
  await paused;
  assert.equal(fixture.socket.isPaused(), true);
  // One separately delivered object reaches the threshold; coalesced frames may exceed a high-water mark.
  assert.equal(fixture.attachment.output.readableLength, 1);
  assert.equal(fixture.attachment.output.writableNeedDrain, true);
}

async function collectTagged(output: PassThrough): Promise<{ stream: string; text: string }[]> {
  const result: { stream: string; text: string }[] = [];
  const chunks: AsyncIterable<unknown> = output;
  for await (const chunk of chunks) {
    assert.ok(typeof chunk === "object" && chunk !== null && "data" in chunk && "stream" in chunk);
    assert.ok(Buffer.isBuffer(chunk.data));
    assert.ok(chunk.stream === "stdout" || chunk.stream === "stderr");
    result.push({ stream: chunk.stream, text: chunk.data.toString("utf8") });
  }
  return result;
}

async function attachmentFixture(): Promise<AttachmentFixture> {
  const server = createServer();
  const accepted = new Promise<Duplex>((resolve) => {
    server.once("upgrade", (_request, socket) => {
      socket.allowHalfOpen = true;
      socket.on("error", () => socket.destroy());
      socket.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      socket.resume();
      resolve(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connection = await openFixtureAttachment(server);
  const peer = await accepted;
  return {
    ...connection,
    peer,
    close: async (): Promise<void> => {
      connection.request.destroy();
      connection.socket.destroy();
      peer.destroy();
      await Promise.all([
        connection.attachment.joined,
        socketClosed(connection.socket),
        socketClosed(peer),
      ]);
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

function openFixtureAttachment(server: Server): Promise<AttachmentConnection> {
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const control = request({
    host: "127.0.0.1",
    port: address.port,
    method: "POST",
    headers: { Connection: "Upgrade", Upgrade: "tcp" },
  });
  const closure = requestClosure(control);
  return new Promise((resolve, reject) => {
    control.once("error", reject);
    control.once("upgrade", (_response, socket, head) => {
      const attachment = new HandsAttachment(
        "b".repeat(64),
        "a".repeat(64),
        socket,
        head,
        closure.joined,
        new AbortController().signal,
        { command: [], commandOutput: true },
      );
      resolve({ attachment, socket, request: control, requestClosed: closure.closed });
    });
    control.end();
  });
}

function requestClosure(control: ClientRequest): { joined: Promise<void>; closed: () => boolean } {
  let requestClosed = false;
  const joined = new Promise<void>((resolve) => {
    control.once("close", () => {
      requestClosed = true;
      resolve();
    });
  });
  return { joined, closed: () => requestClosed };
}

function writeFrame(peer: Duplex, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    peer.write(frame, (error: Error | null | undefined) => {
      if (error !== null && error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function socketClosed(socket: Duplex): Promise<void> {
  return socket.closed
    ? Promise.resolve()
    : new Promise((resolve) => socket.once("close", resolve));
}
