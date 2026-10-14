/** Captures one bounded authorized resource epoch before native discovery can read workspace-controlled paths. */
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { basename } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { SeptError } from "../durable/index.js";
import type { HandsEffectCheck, HandsResources } from "./contracts.js";
import type { HandsFiles } from "./hands-files.js";
import { handsPathMissing } from "./hands-paths.js";

/** A private captured view is owned by the resident; only its work-visible alias is returned to Pi. */
export interface HandsResourceEpoch {
  resources: HandsResources;
  alias: string;
  descriptor: number;
  directory: string;
}
interface CapturedView {
  cwd: string;
  agent: string;
  skills: string[];
  instructions: { path: string; content: string }[];
}
interface CaptureBudget {
  entries: number;
  files: number;
  bytes: number;
}
const INSTRUCTIONS = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** Publish only a complete native-loaded epoch; failed capture removes its private derived data. */
export async function prepareHandsResourceEpoch(
  cwd: string,
  files: HandsFiles,
  authorize: HandsEffectCheck,
  workspaceRead: boolean,
): Promise<HandsResourceEpoch> {
  await authorize("resources", "");
  // Every hostile source lookup and byte copy below is synchronous after this live parent acknowledgment.
  const directory = mkdtempSync(join(tmpdir(), "sept-hands-epoch-"));
  const alias = `/resources/epochs/${basename(directory)}`;
  try {
    const view = captureEpoch(directory, cwd, files, workspaceRead);
    const resources = await loadEpoch(view, directory, alias);
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    return { resources, directory, alias, descriptor };
  } catch (error: unknown) {
    rmSync(directory, { recursive: true });
    throw new SeptError("Hands resource epoch was refused", { cause: error });
  }
}

function captureEpoch(
  directory: string,
  cwd: string,
  files: HandsFiles,
  workspaceRead: boolean,
): CapturedView {
  const budget: CaptureBudget = { entries: 0, files: 0, bytes: 0 };
  const agent = join(directory, "agent");
  captureDirectory(files, "/resources", agent, budget, 0);
  // Loader paths are executor-owned: operator descriptors have already been projected as bounded data.
  writeFileSync(join(agent, "settings.json"), "{}", { mode: 0o600 });
  const viewCwd = join(directory, "workspace", posix.relative("/workspace", cwd));
  mkdirSync(viewCwd, { recursive: true, mode: 0o700 });
  const skills = resourceExists(files, "/resources/skills") ? [join(agent, "skills")] : [];
  const instructions = capturedGlobalInstructions(agent);
  if (workspaceRead) {
    instructions.push(...captureInstructions(files, cwd, directory, budget));
    const source = posix.join(cwd, ".pi/skills");
    const destination = join(viewCwd, ".pi/skills");
    if (resourceExists(files, source)) {
      captureDirectory(files, source, destination, budget, 0);
      skills.push(destination);
    }
  }
  return { cwd: viewCwd, agent, skills, instructions };
}

function captureInstructions(
  files: HandsFiles,
  cwd: string,
  directory: string,
  budget: CaptureBudget,
): { path: string; content: string }[] {
  const instructions: { path: string; content: string }[] = [];
  let ancestor = cwd;
  while (ancestor === "/workspace" || ancestor.startsWith("/workspace/")) {
    for (const name of INSTRUCTIONS) {
      const source = posix.join(ancestor, name);
      if (resourceExists(files, source)) {
        const path = join(directory, "workspace", posix.relative("/workspace", source));
        captureFile(files, source, path, budget);
        instructions.unshift({ path, content: readFileSync(path, "utf8") });
        break;
      }
    }
    if (ancestor === "/workspace") {
      return instructions;
    }
    ancestor = posix.dirname(ancestor);
  }
  return instructions;
}

function capturedGlobalInstructions(agent: string): { path: string; content: string }[] {
  for (const name of INSTRUCTIONS) {
    const path = join(agent, name);
    try {
      return [{ path, content: readFileSync(path, "utf8") }];
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return [];
}

function resourceExists(files: HandsFiles, path: string): boolean {
  try {
    files.resourceStat(path);
    return true;
  } catch (error: unknown) {
    // Only an absent path is optional. Aliases, inaccessible data and malformed types fail closed.
    if (handsPathMissing(error)) {
      return false;
    }
    throw error;
  }
}

function captureDirectory(
  files: HandsFiles,
  source: string,
  destination: string,
  budget: CaptureBudget,
  depth: number,
): void {
  if (depth > 64 || !files.resourceStat(source).isDirectory()) {
    throw new SeptError("Hands resource directory or depth was refused");
  }
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of files.resourceEntries(source, 512 - budget.entries)) {
    budget.entries += 1;
    const path = posix.join(source, name);
    if (Buffer.byteLength(path) > 4096) {
      throw new SeptError("Hands resource path exceeds its bound");
    }
    const stat = files.resourceStat(path);
    if (stat.isDirectory()) {
      captureDirectory(files, path, join(destination, name), budget, depth + 1);
    } else if (
      /\.(md|txt|png|jpe?g|gif|webp|bmp)$/i.test(name) ||
      ["settings.json", ".gitignore", ".ignore", ".fdignore"].includes(name)
    ) {
      captureFile(files, path, join(destination, name), budget);
    }
  }
}

function captureFile(
  files: HandsFiles,
  source: string,
  destination: string,
  budget: CaptureBudget,
): void {
  const bytes = files.resource(source);
  budget.files += 1;
  budget.bytes += bytes.length;
  if (budget.files > 256 || budget.bytes > 8 * 1024 * 1024) {
    throw new SeptError("Hands resource epoch exceeds its bound");
  }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
}

async function loadEpoch(
  view: CapturedView,
  directory: string,
  alias: string,
): Promise<HandsResources> {
  const loader = new DefaultResourceLoader({
    cwd: view.cwd,
    agentDir: view.agent,
    settingsManager: SettingsManager.create(view.cwd, view.agent, { projectTrusted: false }),
    noExtensions: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: view.instructions }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: view.skills,
  });
  await loader.reload();
  const loaded = loader.getSkills();
  if (
    loaded.skills.length > 64 ||
    loaded.diagnostics.some((diagnostic) => diagnostic.type === "error")
  ) {
    throw new SeptError("Hands resources could not be loaded within their bound");
  }
  const skills = loaded.skills.map((skill) => ({
    ...skill,
    filePath: epochAlias(skill.filePath, directory, alias),
    baseDir: epochAlias(skill.baseDir, directory, alias),
  }));
  return {
    system: loader.getSystemPrompt() ?? "You are SEPT, a durable coding worker.",
    append: loader.getAppendSystemPrompt().join("\n\n"),
    instructions: loader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.content)
      .join("\n\n"),
    skills: formatSkillsForPrompt(skills, "read"),
  };
}

function epochAlias(path: string, directory: string, alias: string): string {
  const child = relative(directory, path);
  if (child === ".." || child.startsWith("../") || posix.isAbsolute(child)) {
    throw new SeptError("Hands resource descriptor escapes its epoch");
  }
  return posix.join(alias, child);
}

/** Close retained epoch identity before removing only the resident-owned derived view. */
export function closeHandsResourceEpoch(epoch: HandsResourceEpoch | undefined): void {
  if (epoch === undefined) {
    return;
  }
  try {
    closeSync(epoch.descriptor);
  } finally {
    rmSync(epoch.directory, { recursive: true });
  }
}
