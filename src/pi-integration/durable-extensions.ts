/** Loads only operator-owned native extension modules; repository content grants no code authority. */

import { existsSync, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { SeptError } from "../durable/index.js";

const MAX_EXTENSIONS = 64;
const MODULE_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".ts"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extensionPaths(agentDir: string): string[] {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    return [];
  }
  if (statSync(settingsPath).size > 64 * 1024) {
    throw new SeptError("Pi operator settings exceed the extension-loading bound");
  }
  const value: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!isRecord(value)) {
    throw new SeptError("Pi operator settings must be an object");
  }
  if (value.extensions === undefined) {
    return [];
  }
  if (!Array.isArray(value.extensions) || value.extensions.length > MAX_EXTENSIONS) {
    throw new SeptError("Pi operator extension paths exceed their bound");
  }
  return value.extensions.map((path: unknown) => {
    if (
      typeof path !== "string" ||
      path.length < 1 ||
      path.length > 4096 ||
      /[\x00-\x1f]/.test(path)
    ) {
      throw new SeptError("Pi operator extension path is invalid");
    }
    return path;
  });
}

function trustedModule(agentDir: string, path: string): string {
  const root = realpathSync(agentDir);
  const resolved = realpathSync(resolve(root, path));
  const within = relative(root, resolved);
  // An instruction file, workspace path or symlink cannot promote repository code to brain authority.
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new SeptError("Pi native extension must be inside the trusted agent directory");
  }
  const file = statSync(resolved);
  if (!file.isFile() || file.size > 1024 * 1024 || !MODULE_SUFFIXES.has(extname(resolved))) {
    throw new SeptError("Pi native extension must be a bounded JavaScript or TypeScript module");
  }
  return resolved;
}

function boundedMembers(extension: Record<string, unknown>, key: string): unknown[] {
  const value = extension[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_EXTENSIONS) {
    throw new SeptError("Pi native extension registrations exceed their bound");
  }
  return value;
}

function validTool(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.parameters) &&
    typeof value.execute === "function"
  );
}

function validSection(value: Record<string, unknown>): boolean {
  return (
    typeof value.key === "string" &&
    typeof value.render === "function" &&
    (value.tag === undefined || typeof value.tag === "boolean")
  );
}

function validHook(value: Record<string, unknown>): boolean {
  return (
    typeof value.task === "string" &&
    isRecord(value.handlers) &&
    Object.values(value.handlers).every((handler) => typeof handler === "function")
  );
}

function validWrap(value: Record<string, unknown>): boolean {
  return (
    (typeof value.tool === "string" || typeof value.section === "string") &&
    typeof value.wrap === "function"
  );
}

function validTask(value: Record<string, unknown>): boolean {
  const definition = value.definition;
  if (!isRecord(definition)) {
    return false;
  }
  return (
    typeof definition.name === "string" &&
    Number.isSafeInteger(definition.version) &&
    typeof definition.initial === "function" &&
    typeof definition.abort === "function" &&
    isRecord(definition.phases) &&
    Object.values(definition.phases).every((handler) => typeof handler === "function")
  );
}

function validRegistration(value: unknown, key: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  switch (key) {
    case "tools":
      return validTool(value);
    case "sections":
      return validSection(value);
    case "hooks":
      return validHook(value);
    case "wraps":
      return validWrap(value);
    case "tasks":
      return validTask(value);
    default:
      return false;
  }
}

function validateExtension(value: unknown): Extension {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value.name)
  ) {
    throw new SeptError(
      "Pi native extension must export a named declarative object; port legacy ExtensionAPI factories",
    );
  }
  if (value.name === "sept" || value.name === "sept-tools") {
    throw new SeptError("Pi native extension cannot replace SEPT's runtime registrations");
  }
  const keys = ["tools", "sections", "hooks", "wraps", "tasks"];
  if (Object.keys(value).some((key) => key !== "name" && !keys.includes(key))) {
    throw new SeptError("Pi native extension has unsupported fields");
  }
  for (const key of keys) {
    if (!boundedMembers(value, key).every((registration) => validRegistration(registration, key))) {
      throw new SeptError("Pi native extension contains a malformed registration");
    }
  }
  // CAST: All registration shapes/functions are validated; trusted code owns schema/task semantics.
  return value as unknown as Extension;
}

function discoveredModules(agentDir: string): string[] {
  const path = join(agentDir, "extensions");
  if (!existsSync(path)) {
    return [];
  }
  const directory = opendirSync(path);
  const modules: string[] = [];
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      entries += 1;
      if (entries > MAX_EXTENSIONS) {
        throw new SeptError("Pi native extension directory exceeds its discovery bound");
      }
      if (MODULE_SUFFIXES.has(extname(entry.name))) {
        modules.push(join(path, entry.name));
      }
    }
    return modules;
  } finally {
    directory.closeSync();
  }
}

/** Import at most 64 local native objects from trusted settings paths and agent-dir/extensions. */
export async function loadTrustedExtensions(agentDir: string): Promise<Extension[]> {
  try {
    const paths = [
      ...new Set(
        [...extensionPaths(agentDir), ...discoveredModules(agentDir)].map((path) =>
          trustedModule(agentDir, path),
        ),
      ),
    ];
    if (paths.length > MAX_EXTENSIONS) {
      throw new SeptError("Pi native extension count exceeds its bound");
    }
    const extensions: Extension[] = [];
    for (const path of paths.sort()) {
      const module: unknown = await import(pathToFileURL(path).href);
      if (!isRecord(module)) {
        throw new SeptError("Pi native extension module is invalid");
      }
      const extension = validateExtension(module.default ?? module.extension);
      if (extensions.some((loaded) => loaded.name === extension.name)) {
        throw new SeptError("Pi native extension names must be unique");
      }
      extensions.push(extension);
    }
    return extensions;
  } catch (error: unknown) {
    if (error instanceof SeptError) {
      throw error;
    }
    throw new SeptError("Pi trusted native extension could not be loaded", { cause: error });
  }
}
