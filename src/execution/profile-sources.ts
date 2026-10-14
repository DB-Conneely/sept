/** Stateless bounded source provenance checks; live anchored/immutable-kernel owners still enforce actual effects. */
import { realpathSync, lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { SeptError } from "../durable/index.js";
/** Lexical canonical containment; callers separately pin or validate real filesystem identity. */
export function beneath(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function inspectSourceDirectory(
  directory: string,
  root: string,
  pending: string[],
  remaining: number,
): number {
  const stream = opendirSync(directory);
  let count = 0;
  try {
    for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
      count += 1;
      if (count > remaining) {
        throw new SeptError("Hands mount provenance discovery exceeds its bound");
      }
      inspectSourceEntry(join(directory, entry.name), root, pending);
    }
    return count;
  } finally {
    stream.closeSync();
  }
}

/** Preserve the existing bounded RO provenance scan; mutable individual effects use their anchored owner. */
export function assertSourceTree(root: string): void {
  const pending = [root];
  const seen = new Set<string>();
  let count = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    const canonical = realpathSync(directory);
    if (!beneath(canonical, root)) {
      throw new SeptError("Hands mount symlink escapes its declared source");
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    count += inspectSourceDirectory(directory, root, pending, 4096 - count);
  }
}

function inspectSourceEntry(path: string, root: string, pending: string[]): void {
  const real = realpathSync(path);
  if (!beneath(real, root)) {
    throw new SeptError("Hands mount alias escapes its declared source");
  }
  const stat = lstatSync(real);
  if (stat.isDirectory()) {
    pending.push(real);
  } else if (!stat.isFile() || stat.nlink !== 1) {
    throw new SeptError("Hands mount contains a service channel, special file or hardlink alias");
  }
}
