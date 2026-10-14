/** Anchored file-only Pi operations. Every component is opened beneath a retained namespace root. */
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { posix } from "node:path";
import {
  detectSupportedImageMimeTypeFromFile,
  type ReadToolOptions,
  type WriteToolOptions,
  type EditToolOptions,
} from "@earendil-works/pi-coding-agent";
import { SeptError, type CapabilityGrant } from "../durable/index.js";

// One file body may allocate at most 16 MiB, including when a mutable inode grows after fstat.
const HANDS_FILE_BYTES = 16 * 1024 * 1024;
function boundedRead(descriptor: number, maximum: number): Buffer {
  const buffer = Buffer.allocUnsafe(maximum + 1);
  let count = 0;
  while (count <= maximum) {
    const read = readSync(descriptor, buffer, count, buffer.length - count, null);
    if (read === 0) {
      return buffer.subarray(0, count);
    }
    count += read;
  }
  throw new SeptError("Hands file read exceeds its bound");
}

function createDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o2770 });
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }
}

/** One entry owns its root descriptors until Pi's complete tool body settles. */
export class HandsFiles {
  private readonly roots: { grant: CapabilityGrant; descriptor: number }[] = [];
  public constructor(grants: readonly CapabilityGrant[]) {
    try {
      for (const grant of grants) {
        this.roots.push({
          grant,
          descriptor: openSync(
            grant.root,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          ),
        });
      }
    } catch (error: unknown) {
      this.close();
      throw new SeptError("Hands file roots are unavailable", { cause: error });
    }
  }
  private root(path: string, right: "read" | "write"): { descriptor: number; parts: string[] } {
    const absolute = posix.resolve(path);
    const selected = this.roots.find(
      ({ grant }) => absolute === grant.root || absolute.startsWith(`${grant.root}/`),
    );
    if (!selected?.grant[right]) {
      throw new SeptError("Hands file right was denied");
    }
    const relative = absolute.slice(selected.grant.root.length).replace(/^\//, "");
    return {
      descriptor: selected.descriptor,
      parts: relative.length === 0 ? [] : relative.split("/"),
    };
  }
  private parent(
    path: string,
    right: "read" | "write",
    create: boolean,
  ): { descriptor: number; name: string; owned: number[] } {
    const { descriptor, parts } = this.root(path, right);
    const name = parts.pop();
    if (name === undefined) {
      throw new SeptError("Hands operation requires a file");
    }
    const owned: number[] = [];
    let current = descriptor;
    try {
      for (const part of parts) {
        const target = `/proc/self/fd/${String(current)}/${part}`;
        if (create) {
          createDirectory(target);
        }
        current = openSync(
          target,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        owned.push(current);
      }
      return { descriptor: current, name, owned };
    } catch (error: unknown) {
      owned.reverse().forEach(closeSync);
      throw new SeptError("Hands anchored directory lookup was refused", { cause: error });
    }
  }
  private file(path: string, right: "read" | "write"): number {
    const parent = this.parent(path, right, right === "write");
    try {
      const flags = right === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT;
      // NONBLOCK avoids FIFO/device hangs. Validate inode/type before any truncation or content access.
      const descriptor = openSync(
        `/proc/self/fd/${String(parent.descriptor)}/${parent.name}`,
        flags | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o660,
      );
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > HANDS_FILE_BYTES) {
        closeSync(descriptor);
        throw new SeptError("Hands file type, alias or size was refused");
      }
      return descriptor;
    } finally {
      parent.owned.reverse().forEach(closeSync);
    }
  }
  /** Complete supported Pi operation seams preserve bodies and their image/edit behavior. */
  public readOptions(): ReadToolOptions {
    return {
      operations: {
        readFile: (path) => this.read(path),
        access: (path) => this.access(path),
        detectImageMimeType: (path) => this.mime(path),
      },
    };
  }
  /** Pi still owns mutation queue, text validation and exact output. */
  public writeOptions(): WriteToolOptions {
    return {
      operations: {
        writeFile: (path, content) => this.write(path, content),
        mkdir: (path) => this.mkdir(path),
      },
    };
  }
  /** Edit requires both rights through the same anchored file owner. */
  public editOptions(): EditToolOptions {
    return {
      operations: {
        readFile: (path) => this.read(path),
        writeFile: (path, content) => this.write(path, content),
        access: (path) => this.access(path, "edit"),
      },
    };
  }
  /** MIME detection reads the same pinned regular inode; Pi retains all image parsing/resizing. */
  public async mime(path: string): Promise<string | null> {
    const descriptor = this.file(path, "read");
    try {
      return await detectSupportedImageMimeTypeFromFile(`/proc/self/fd/${String(descriptor)}`);
    } finally {
      closeSync(descriptor);
    }
  }
  /** Read only from a validated retained inode, never a realpath followed by an ambient open. */
  public read(path: string, maximum = HANDS_FILE_BYTES): Promise<Buffer> {
    const descriptor = this.file(path, "read");
    try {
      return Promise.resolve(boundedRead(descriptor, maximum));
    } finally {
      closeSync(descriptor);
    }
  }
  /** Write-only needs no read; no truncation occurs until regular single-link identity is checked. */
  public write(path: string, content: string): Promise<void> {
    const descriptor = this.file(path, "write");
    try {
      ftruncateSync(descriptor, 0);
      writeFileSync(descriptor, content);
      return Promise.resolve();
    } finally {
      closeSync(descriptor);
    }
  }
  /** Pi owns recursive-write semantics; directory creation is performed during the anchored write. */
  public mkdir(_path: string): Promise<void> {
    return Promise.resolve();
  }
  /** Checking edit access requires both independent rights without reading or mutating content. */
  public access(path: string, required: "read" | "edit" = "read"): Promise<void> {
    closeSync(this.file(path, "read"));
    if (required === "edit") {
      closeSync(this.file(path, "write"));
    }
    return Promise.resolve();
  }
  /** Close all owned directory handles on success, refusal and partial initialization. */
  public close(): void {
    for (const root of this.roots.splice(0)) {
      closeSync(root.descriptor);
    }
  }
}
