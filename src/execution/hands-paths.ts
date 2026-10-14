/** Stateless internal alias resolution and MIME capture; descriptor ownership stays with HandsFiles. */
import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { SeptError, type CapabilityGrant } from "../durable/index.js";

/** Missing anchored components remain distinguishable from denied links/types without inspecting messages. */
export class HandsPathMissingError extends SeptError {}

/** Only absence is optional during resource/native ancestor discovery; denied aliases and types remain refusals. */
export function handsPathMissing(error: unknown): boolean {
  return (
    error instanceof HandsPathMissingError ||
    (error instanceof Error && "code" in error && error.code === "ENOENT")
  );
}

/** Physical executor-private capture paths are reserved even from same-UID ordinary tool callbacks. */
export function privateHandsPath(path: string): boolean {
  return /^\/tmp\/sept-hands-(epoch|mime)-[^/]+(?:\/|$)/.test(posix.resolve(path));
}

/** Resolve only internal resource links, then let the anchored opener recheck every component without following links. */
export function resolveResourceAlias(
  path: string,
  roots: readonly { grant: CapabilityGrant; descriptor: number }[],
): string {
  let absolute = posix.resolve(path);
  const root = roots.find(
    ({ grant }) => absolute === grant.root || absolute.startsWith(`${grant.root}/`),
  );
  if (!root?.grant.read) {
    throw new SeptError("Hands resource root was denied");
  }
  for (let links = 0; links < 32; links += 1) {
    const rewritten = followResourceLink(absolute, root);
    if (rewritten === absolute) {
      return absolute;
    }
    if (rewritten !== root.grant.root && !rewritten.startsWith(`${root.grant.root}/`)) {
      throw new SeptError("Hands resource alias escapes its granted root");
    }
    absolute = rewritten;
  }
  throw new SeptError("Hands resource alias depth exceeds its bound");
}

function followResourceLink(
  path: string,
  root: { grant: CapabilityGrant; descriptor: number },
): string {
  const parts = path.slice(root.grant.root.length).split("/").filter(Boolean);
  let descriptor = openSync(
    `/proc/self/fd/${String(root.descriptor)}`,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  let prefix = root.grant.root;
  try {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) {
        throw new SeptError("Hands resource path is invalid");
      }
      const target = `/proc/self/fd/${String(descriptor)}/${part}`;
      if (lstatSync(target).isSymbolicLink()) {
        return posix.resolve(prefix, readlinkSync(target), ...parts.slice(index + 1));
      }
      if (index < parts.length - 1) {
        const next = openResourceDirectory(target);
        closeSync(descriptor);
        descriptor = next;
        prefix = posix.join(prefix, part);
      }
    }
    return path;
  } finally {
    closeSync(descriptor);
  }
}

function openResourceDirectory(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

/** Native MIME sniffing consumes an executor-private copy made synchronously from the validated source inode. */
export async function sniffCapturedMime(
  bytes: Buffer,
  sniff: (path: string) => Promise<string | null>,
): Promise<string | null> {
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "sept-hands-mime-"));
    const path = join(directory, "image");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return await sniff(path);
  } catch (error: unknown) {
    // Native tool error formatting must never disclose physical private capture paths.
    throw new SeptError("Hands captured MIME could not be inspected", { cause: error });
  } finally {
    if (directory !== undefined) {
      removeMimeCapture(directory);
    }
  }
}

function removeMimeCapture(directory: string): void {
  try {
    rmSync(directory, { recursive: true });
  } catch (error: unknown) {
    throw new SeptError("Hands captured MIME cleanup is unverified", { cause: error });
  }
}

/** The existing HandsFiles owner retains and closes these roots; partial opens close before refusal. */
export interface HandsRoot {
  grant: CapabilityGrant;
  descriptor: number;
}
/** Open only parent-admitted roots and current private aliases; no request chooses a physical epoch path. */
export function openHandsRoots(
  grants: readonly CapabilityGrant[],
  aliases: readonly { alias: string; descriptor: number }[],
): HandsRoot[] {
  const roots: HandsRoot[] = [];
  try {
    for (const grant of grants) {
      roots.push({
        grant,
        descriptor: openSync(
          grant.root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ),
      });
    }
    for (const alias of aliases) {
      roots.unshift({
        grant: { root: alias.alias, read: true, write: false },
        descriptor: openSync(
          `/proc/self/fd/${String(alias.descriptor)}`,
          constants.O_RDONLY | constants.O_DIRECTORY,
        ),
      });
    }
    return roots;
  } catch (error: unknown) {
    for (const root of roots) {
      closeSync(root.descriptor);
    }
    throw new SeptError("Hands file roots are unavailable", { cause: error });
  }
}

/** Enumerate a retained directory under an explicit entry bound; the caller continues owning its descriptor. */
export function readHandsDirectory(descriptor: number, capacity: number): string[] {
  const directory = opendirSync(`/proc/self/fd/${String(descriptor)}`);
  const entries: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (entries.length >= capacity) {
        throw new SeptError("Hands directory exceeds its bound");
      }
      entries.push(entry.name);
    }
    return entries;
  } finally {
    directory.closeSync();
  }
}
