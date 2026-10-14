import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import type { EngineFixture } from "./backend-support.js";
import { HandsFrameDecoder } from "../../src/execution/protocol.js";
import { encodeHandsFrame, handsRecord, type HandsFrame } from "../../src/execution/protocol.js";
/** Supporting daemon attachment speaks the installed codec without pretending to execute kernel effects. */
export function attachWarmFixture(socket: Duplex, facts: EngineFixture): void {
  const hello = warmHello(facts);
  const send = (frame: HandsFrame): void => {
    socket.write(engineFrame(1, encodeHandsFrame(facts.warmReply?.(frame) ?? frame)));
  };
  const decoder = new HandsFrameDecoder(512 * 1024, warmReceiver(send), () => {
    socket.destroy();
  });
  socket.on("data", (chunk: Buffer) => {
    try {
      decoder.write(chunk);
    } catch {
      socket.destroy();
    }
  });
  socket.once("end", () => {
    facts.resident = false;
    try {
      decoder.finish();
    } finally {
      socket.end();
    }
  });
  send(hello);
}
function warmHello(facts: EngineFixture): HandsFrame {
  const command = handsRecord(facts.command).Cmd;
  assert.ok(Array.isArray(command));
  const raw: unknown = JSON.parse(String(command.at(-1)));
  const bootstrap = handsRecord(raw);
  return {
    version: 1,
    generation: String(bootstrap.generation),
    configuration: String(bootstrap.configuration),
    session: String(bootstrap.session),
    sequence: 0,
    kind: "hello",
    payload: {
      challenge: String(bootstrap.challenge),
      pid: 42,
      start: "123",
      guard: 2,
      network: "denied",
    },
  };
}
function warmReceiver(send: (frame: HandsFrame) => void): (frame: HandsFrame) => void {
  let pending: Extract<HandsFrame, { kind: "operation" }> | undefined;
  return (frame) => {
    if (frame.kind === "operation") {
      pending = frame;
      send({
        ...frame,
        kind: "effect-check",
        payload: { effect: 1, right: "operation", path: "" },
      });
    } else if (frame.kind === "ack" && pending !== undefined) {
      const request = pending.payload;
      send({
        ...pending,
        kind: "result",
        payload:
          request.kind === "file"
            ? { ok: true, value: "bounded result" }
            : { content: [{ type: "text", text: "bounded result" }] },
      });
      pending = undefined;
    }
  };
}

/** Exact Docker stream framing for supporting decoder capacity fixtures. */
export function engineFrame(stream: number, content: string | Buffer): Buffer {
  const body = typeof content === "string" ? Buffer.from(content) : content;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/** Fixed trusted command fixtures never interpret model arguments as process authority. */
export function fixtureOutput(command: string): string {
  if (command.includes("/app/hands-process-control")) {
    return command.includes("--capture")
      ? JSON.stringify({ idle: { pid: 2, start: "122" } })
      : JSON.stringify({ joined: true, remaining: 0, signaled: 0 });
  }
  if (command.includes("process.kill(1")) {
    return "pinned\n";
  }
  if (command.includes("function lifetime()")) {
    return JSON.stringify({ pidNamespace: "pid:[42]", initStart: "123" });
  }
  return "bounded result";
}
