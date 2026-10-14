/** Stateless immutable-entry/guard bootstrap codec; a startup receipt grants no operation rights. */
import { readFileSync } from "node:fs";
import { SeptError } from "../durable/index.js";
import { handsRecord, parseHandsFrame, type HandsFrame } from "./protocol.js";
/** Require immutable denied guard/UID and bind the resident PID start to the trusted bootstrap before input. */
export function residentHandshake(): Extract<HandsFrame, { kind: "hello" }> {
  // A denied immutable constructor receipt is required before any bytes/operation are consumed.
  if (
    process.env.SEPT_HANDS_PROCESS_GUARD !== "2" ||
    process.env.SEPT_HANDS_NETWORK_GUARD !== "denied" ||
    process.getuid?.() !== 10002
  ) {
    throw new SeptError("Hands resident guard or identity is unavailable");
  }
  const raw = process.argv[2] ?? "";
  if (Buffer.byteLength(raw) > 4096) {
    throw new SeptError("Hands bootstrap exceeds its bound");
  }
  const bootstrap = handsRecord(JSON.parse(raw));
  const stat = requireResidentStat();
  const frame = parseHandsFrame({
    version: bootstrap.version,
    generation: bootstrap.generation,
    configuration: bootstrap.configuration,
    session: bootstrap.session,
    sequence: bootstrap.sequence,
    kind: "hello",
    payload: {
      challenge: bootstrap.challenge,
      pid: process.pid,
      start: stat,
      guard: 2,
      network: "denied",
    },
  });
  if (frame.kind !== "hello" || frame.sequence !== 0) {
    throw new SeptError("Hands bootstrap is malformed");
  }
  delete process.env.SEPT_HANDS_NETWORK;
  delete process.env.SEPT_HANDS_NETWORK_GUARD;
  delete process.env.SEPT_HANDS_PROCESS_GUARD;
  delete process.env.LD_PRELOAD;
  return frame;
}
function requireResidentStat(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  if (stat.length > 16384 || start === undefined || !/^\d{1,20}$/.test(start)) {
    throw new SeptError("Hands resident lifetime is unavailable");
  }
  return start;
}
