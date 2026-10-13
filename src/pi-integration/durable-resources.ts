/** Projects operator-owned text/image resources; all workspace discovery executes in hands. */

import {
  existsSync,
  mkdirSync,
  chmodSync,
  copyFileSync,
  writeFileSync,
  constants,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  opendirSync,
  type Dirent,
  realpathSync,
  rmSync,
  statSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { section, type PromptSection } from "@earendil-works/pi-durable";
import { atomicWrite, SeptError, type Manifest } from "../durable/index.js";
import { parseHandsResources, type ExecutionBackend } from "../execution/index.js";

interface ProjectionBudget {
  files: number;
  bytes: number;
}

function boundedEntries(directory: string, capacity: number): Dirent[] {
  const stream = opendirSync(directory);
  const entries: Dirent[] = [];
  try {
    for (let entry = stream.readSync(); entry !== null; entry = stream.readSync()) {
      if (entries.length >= capacity) {
        throw new SeptError("Resource directory discovery exceeds its bound");
      }
      entries.push(entry);
    }
    return entries;
  } finally {
    stream.closeSync();
  }
}

function directoryEmpty(directory: string): boolean {
  const stream = opendirSync(directory);
  try {
    return stream.readSync() === null;
  } finally {
    stream.closeSync();
  }
}

function readableText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o644 });
    syncFile(temporary);
    renameSync(temporary, path);
    syncFile(dirname(path));
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyResource(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    chmodSync(temporary, 0o644);
    syncFile(temporary);
    renameSync(temporary, destination);
    syncFile(dirname(destination));
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function projectFile(
  source: string,
  destination: string,
  root: string,
  budget: ProjectionBudget,
): void {
  const canonical = realpathSync(source);
  const child = relative(root, canonical);
  if (child === ".." || child.startsWith(`..${sep}`)) {
    throw new SeptError("Trusted resource symlink escapes its declared skill directory");
  }
  const stat = statSync(canonical);
  budget.files += 1;
  budget.bytes += stat.size;
  if (
    !stat.isFile() ||
    budget.files > 256 ||
    budget.bytes > 8 * 1024 * 1024 ||
    stat.size > 1024 * 1024
  ) {
    throw new SeptError("Trusted resource projection exceeds its bound or contains a special file");
  }
  copyResource(canonical, destination);
}

function projectDirectory(
  source: string,
  destination: string,
  root: string,
  budget: ProjectionBudget,
): void {
  const entries = boundedEntries(source, 256 - budget.files);
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      budget.files += 1;
      projectDirectory(from, to, root, budget);
    } else if (/\.(md|txt|png|jpe?g|gif|webp|bmp)$/i.test(entry.name)) {
      projectFile(from, to, root, budget);
    }
  }
}

function projectionSnapshot(root: string): Record<string, string> {
  const files = new Map<string, string>();
  snapshotProjection(root, root, files);
  return Object.fromEntries(files);
}

function snapshotProjection(root: string, directory: string, files: Map<string, string>): void {
  const names = boundedEntries(directory, 512 - files.size)
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (files.size >= 512 || stat.isSymbolicLink()) {
      throw new SeptError("Resource projection ownership exceeds its bound or includes an alias");
    }
    const key = relative(root, path);
    if (stat.isDirectory()) {
      files.set(key, "directory");
      snapshotProjection(root, path, files);
    } else if (stat.isFile() && stat.size <= 1024 * 1024) {
      files.set(key, createHash("sha256").update(readFileSync(path)).digest("hex"));
    } else {
      throw new SeptError("Resource projection includes an unsupported file");
    }
  }
}

function prepareProjection(root: string, receipt: string, agentDir: string): void {
  if (directoryEmpty(root)) {
    return;
  }
  // A marker in consumer storage is not ownership. Only the private run receipt can
  // authorize refresh, and unknown/edited files are preserved by refusing before mutation.
  if (!existsSync(receipt) || statSync(receipt).size > 128 * 1024) {
    throw new SeptError("Hands resource projection must be dedicated and initially empty");
  }
  const value: unknown = JSON.parse(readFileSync(receipt, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SeptError("Resource projection ownership is invalid");
  }
  // CAST: The object guard excludes null/arrays; every used property is validated below.
  const owned = value as Record<string, unknown>;
  if (
    owned.root !== realpathSync(root) ||
    owned.agent !== realpathSync(agentDir) ||
    JSON.stringify(owned.files) !== JSON.stringify(projectionSnapshot(root))
  ) {
    throw new SeptError("Resource projection ownership differs; existing data was preserved");
  }
  rmSync(join(root, "skills"), { recursive: true, force: true });
}

function projectGlobalInstructions(agentDir: string, root: string): void {
  for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const path = join(agentDir, name);
    if (existsSync(path) && statSync(path).isFile()) {
      const budget: ProjectionBudget = { files: 0, bytes: 0 };
      projectFile(path, join(root, "AGENTS.md"), realpathSync(agentDir), budget);
      return;
    }
  }
  readableText(join(root, "AGENTS.md"), "");
}

function projectSkills(
  skills: ReturnType<DefaultResourceLoader["getSkills"]>["skills"],
  agentDir: string,
  root: string,
): void {
  const budget: ProjectionBudget = { files: 0, bytes: 0 };
  const paths: string[] = [];
  for (const skill of skills) {
    const base = realpathSync(skill.baseDir);
    if (base === realpathSync(agentDir) || relative(base, realpathSync(agentDir)) === "") {
      throw new SeptError("A skill cannot project the private Pi agent directory");
    }
    const brainRelative = relative(base, realpathSync(agentDir));
    if (brainRelative !== ".." && !brainRelative.startsWith(`..${sep}`)) {
      throw new SeptError("A skill cannot project a parent of the Pi agent directory");
    }
    const alias = createHash("sha256").update(skill.filePath).digest("hex").slice(0, 16);
    const destination = join(root, "skills", alias);
    projectDirectory(base, destination, base, budget);
    paths.push(`/resources/skills/${alias}/${basename(skill.filePath)}`);
    if (!existsSync(join(destination, basename(skill.filePath)))) {
      throw new SeptError("Trusted skill body is not projectable text");
    }
  }
  readableText(join(root, "settings.json"), JSON.stringify({ skills: paths }));
}

async function projectTrustedResources(agentDir: string, backend: ExecutionBackend): Promise<void> {
  const root = backend.resourceProjectionDirectory;
  prepareProjection(root, backend.resourceProjectionReceipt, agentDir);
  const loader = new DefaultResourceLoader({
    // Only operator-owned resource discovery is permitted in brain. Workspace/ancestors are hands-owned.
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir, { projectTrusted: false }),
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getSkills();
  if (
    loaded.diagnostics.some((diagnostic) => diagnostic.type === "error") ||
    loaded.skills.length > 64
  ) {
    throw new SeptError("Trusted skills could not be projected within their bound");
  }
  readableText(
    join(root, "SYSTEM.md"),
    loader.getSystemPrompt() ?? "You are SEPT, a durable coding worker.",
  );
  readableText(join(root, "APPEND_SYSTEM.md"), loader.getAppendSystemPrompt().join("\n\n"));
  projectGlobalInstructions(agentDir, root);
  projectSkills(loaded.skills, agentDir, root);
  atomicWrite(backend.resourceProjectionReceipt, {
    root: realpathSync(root),
    agent: realpathSync(agentDir),
    files: projectionSnapshot(root),
  });
}

/** Refresh hands-only instructions/skills and usable read-only operator projections at each epoch. */
export async function loadDurableSections(
  _manifest: Manifest,
  agentDir: string,
  backend: ExecutionBackend,
): Promise<PromptSection[]> {
  try {
    await projectTrustedResources(agentDir, backend);
  } catch (error: unknown) {
    throw new SeptError("Trusted resources could not be projected", { cause: error });
  }
  const resources = parseHandsResources(
    await backend.invoke({ kind: "resources" }, BACKGROUND_CONTEXT),
  );
  return [
    section("system", () => resources.system, { tag: false }),
    section("append-system", () => resources.append, { tag: false }),
    section("repository-instructions", () => resources.instructions),
    section("skills", () => resources.skills),
  ];
}
