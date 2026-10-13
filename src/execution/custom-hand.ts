/** Executes one operator-registered untrusted program as a clean bounded child outside the protected entry. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { SeptError } from "../durable/index.js";
import type { HandsRequest, HandsToolResult } from "./contracts.js";
import type { HandsFiles } from "./hands-files.js";

/** Read/hash once through anchored regular-file authority; execute the exact bytes, never reopen a path. */
export async function executeCustomHand(
  request: Extract<HandsRequest, { kind: "custom" }>,
  files: HandsFiles | undefined,
): Promise<HandsToolResult> {
  if (request.hand === undefined || files === undefined) {
    throw new SeptError("Custom hand registration or anchored code authority is absent");
  }
  const code = await files.read(request.hand.path, 64 * 1024);
  if (
    code.byteLength > 64 * 1024 ||
    createHash("sha256").update(code).digest("hex") !== request.hand.sha256
  ) {
    throw new SeptError("Custom hand code changed or exceeded its bound");
  }
  return {
    content: [{ type: "text", text: await child(code.toString("utf8"), request.arguments.text) }],
  };
}
function child(code: string, text: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const process_ = spawn(
      "/usr/local/bin/node",
      ["--disable-sigusr1", "--input-type=module", "--eval", code],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
      },
    );
    let output = "";
    let overflow = false;
    const timer = setTimeout(() => process_.kill("SIGKILL"), 5000);
    process_.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 4096) {
        overflow = true;
        process_.kill("SIGKILL");
      } else {
        output += chunk;
      }
    });
    process_.stderr.resume();
    process_.stdin.on("error", () => undefined);
    process_.once("error", (error: unknown) => {
      clearTimeout(timer);
      reject(new SeptError("Custom hand child could not start", { cause: error }));
    });
    process_.once("close", (status) => {
      clearTimeout(timer);
      if (status !== 0 || overflow) {
        reject(new SeptError("Custom hand failed or exceeded its bound"));
      } else {
        resolvePromise(output);
      }
    });
    process_.stdin.end(text);
  });
}
