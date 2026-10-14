/** Stateless native operation options delegate every effect to the current anchored owner. */
import { resolve } from "node:path";
import type { ReadToolOptions } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import type { HandsRequest } from "./contracts.js";
import type { HandsFiles } from "./hands-files.js";
/** Refresh native image settings and anchored file callbacks for the current operation only. */
export function handsReadOptions(
  request: Extract<HandsRequest, { kind: "tool" }>,
  files: HandsFiles,
): ReadToolOptions {
  return {
    ...files.readOptions(),
    ...(request.resize === undefined ? {} : { resizeOptions: request.resize }),
  };
}
/** Execute the native text seam with operation-local retained roots; unsupported operations never widen authority. */
export async function executeHandsFile(
  request: Extract<HandsRequest, { kind: "file" }>,
  cwd: string,
  files: HandsFiles,
): Promise<unknown> {
  const path = resolve(cwd, request.path);
  if (request.method === "readTextFile") {
    return { ok: true, value: (await files.read(path)).toString("utf8") };
  }
  await files.write(path, requiredContent(request));
  return { ok: true };
}
function requiredContent(request: Extract<HandsRequest, { kind: "file" }>): string {
  if (request.content === undefined) {
    throw new SeptError("Hands write requires text");
  }
  return request.content;
}
