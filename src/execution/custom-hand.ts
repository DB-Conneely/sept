import { handsRecord } from "./protocol.js";
import type { CustomHand } from "./contracts.js";
/** Executes one operator-registered untrusted program as a clean bounded child outside the protected entry. */
import { createHash } from "node:crypto";
import { SeptError } from "../durable/index.js";
import type { HandsRequest, HandsToolResult, HandsCommandExecutor } from "./contracts.js";
import type { HandsFiles } from "./hands-files.js";

/** Read/hash once through anchored regular-file authority; execute the exact bytes, never reopen a path. */
export async function executeCustomHand(
  request: Extract<HandsRequest, { kind: "custom" }>,
  files: HandsFiles | undefined,
  cwd: string,
  command: HandsCommandExecutor | undefined,
  signal?: AbortSignal,
): Promise<HandsToolResult> {
  if (request.hand === undefined || files === undefined || command === undefined) {
    throw new SeptError("Custom hand registration or anchored code authority is absent");
  }
  const code = await files.read(request.hand.path, 64 * 1024);
  if (
    code.byteLength > 64 * 1024 ||
    createHash("sha256").update(code).digest("hex") !== request.hand.sha256
  ) {
    throw new SeptError("Custom hand code changed or exceeded its bound");
  }
  let output = "";
  const exit = await command(
    { program: "custom", command: code.toString("utf8"), input: request.arguments.text, cwd },
    (chunk, stream) => {
      if (stream === "stdout") {
        output += chunk.toString("utf8");
      }
    },
    signal,
  );
  return {
    content: [{ type: "text", text: output }],
    ...(exit.code !== 0 || exit.termination !== "exit" ? { isError: true } : {}),
  };
}

function customRegistration(value: unknown): CustomHand {
  const input = handsRecord(value);
  if (
    typeof input.path !== "string" ||
    !/^\/selected\/[A-Za-z0-9_-]+\/[^\x00-\x1f]+$/.test(input.path) ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    (input.replay !== "safe" && input.replay !== "unsafe")
  ) {
    throw new SeptError("Custom hand registration is malformed");
  }
  return { path: input.path, sha256: input.sha256, replay: input.replay };
}

/** Validate the closed custom registration/argument payload before its parent can acquire effect authority. */
export function parseCustomRequest(
  input: Record<string, unknown>,
  granted: Extract<HandsRequest, { kind: "custom" }>["grants"],
): HandsRequest {
  const args = handsRecord(input.arguments);
  if (
    Object.keys(args).some((key) => key !== "text" && key !== "network") ||
    (args.network !== undefined && typeof args.network !== "boolean")
  ) {
    throw new SeptError("Custom hand arguments are malformed");
  }
  return {
    kind: "custom",
    callId: customText(input.callId, 256),
    ...(input.taskKey === undefined ? {} : { taskKey: customText(input.taskKey, 64) }),
    arguments: {
      text: customText(args.text, 1024),
      ...(args.network === undefined ? {} : { network: args.network }),
    },
    ...(input.hand === undefined ? {} : { hand: customRegistration(input.hand) }),
    ...(granted === undefined ? {} : { grants: granted }),
  };
}

function customText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) {
    throw new SeptError("Custom hand protocol text exceeds its bound");
  }
  return value;
}
