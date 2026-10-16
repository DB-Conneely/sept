/** Installed package identity is read only when requested, independent of the caller's cwd. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SeptError } from "./durable/index.js";

interface PackageMetadata {
  piVersion: string;
  septVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the installed package and Pi versions without starting CLI or worker behavior. */
export function packageMetadata(): PackageMetadata {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const dependencies = isRecord(parsed) ? parsed.dependencies : undefined;
    const piVersion = isRecord(dependencies)
      ? dependencies["@earendil-works/pi-coding-agent"]
      : undefined;
    if (!isRecord(parsed) || typeof parsed.version !== "string" || typeof piVersion !== "string") {
      throw new SeptError("SEPT package metadata is invalid");
    }
    return { piVersion, septVersion: parsed.version };
  } catch (error: unknown) {
    throw new SeptError("SEPT package metadata is invalid", { cause: error });
  }
}
