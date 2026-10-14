/** Native discovery bodies retain only immutable schemas; operation-local anchored callbacks are rebound each call. */
import { createGrepTool, createFindTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import type { HandsFiles } from "./hands-files.js";
import type { HandsResourceEpoch } from "./hands-resources.js";
import { posix } from "node:path";
import type { HandsRequest } from "./contracts.js";
import { handsPathMissing } from "./hands-paths.js";

/** Validate native find's ancestor .git metadata in the same acknowledged uniformly readable private domain. */
export async function validateHandsFind(
  request: Extract<HandsRequest, { kind: "tool" }>,
  cwd: string,
  files: HandsFiles,
): Promise<void> {
  const path = posix.resolve(
    cwd,
    typeof request.arguments.path === "string" ? request.arguments.path : ".",
  );
  await files.stat(path);
  const root = request.grants?.find(
    (grant) => path === grant.root || path.startsWith(`${grant.root}/`),
  );
  if (root === undefined) {
    throw new SeptError("Hands find root is unavailable");
  }
  // Native find later performs ambient existence checks; no hostile alias may reach those checks.
  // This metadata batch is synchronous after its live read acknowledgment; outside writers are excluded for discovery.
  let ancestor = path;
  while (ancestor === root.root || ancestor.startsWith(`${root.root}/`)) {
    try {
      files.resourceStat(posix.join(ancestor, ".git"), { internalAliases: false });
    } catch (error: unknown) {
      if (!handsPathMissing(error)) {
        throw error;
      }
    }
    if (ancestor === root.root) {
      return;
    }
    ancestor = posix.dirname(ancestor);
  }
}

/** The resident owns current file/epoch identity; body callbacks never retain previous grants. */
export interface HandsBodies {
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  files: HandsFiles | undefined;
  epoch: HandsResourceEpoch | undefined;
}

/** Missing operation binding is a refusal, never an ambient filesystem fallback. */
export function requireHandsFiles(bodies: HandsBodies): HandsFiles {
  if (bodies.files === undefined) {
    throw new SeptError("Hands discovery has no active file owner");
  }
  return bodies.files;
}

/** Keep existing Pi rg/fd bodies; image-owned helper wrappers separately enforce read-domain confinement. */
export function createHandsBodies(cwd: string): HandsBodies {
  const files = (): HandsFiles => requireHandsFiles(bodies);
  const bodies: HandsBodies = {
    files: undefined,
    epoch: undefined,
    grep: createGrepTool(cwd, {
      operations: {
        isDirectory: async (path) => (await files().stat(path)).isDirectory(),
        readFile: async (path) => (await files().read(path)).toString("utf8"),
      },
    }),
    find: createFindTool(cwd),
    ls: createLsTool(cwd, {
      operations: {
        exists: async (path) => {
          await files().stat(path);
          return true;
        },
        stat: (path) => files().stat(path),
        readdir: (path) => files().entries(path, 16384),
      },
    }),
  };
  return bodies;
}
