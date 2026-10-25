/** Installed package identity is read only when requested, independent of the caller's cwd. */
import { readFileSync } from "node:fs";
import { SeptError } from "./durable/index.js";

interface PackageMetadata {
  piVersion: string;
  septVersion: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageVersion(path: URL, name: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.name !== name || typeof parsed.version !== "string") {
    throw new SeptError("SEPT package metadata is invalid");
  }
  return parsed.version;
}

/** Resolve installed versions without importing Pi or starting CLI or worker behavior. */
export function packageMetadata(): PackageMetadata {
  try {
    const septVersion = packageVersion(
      new URL("../../package.json", import.meta.url),
      "sept-agent",
    );
    // A dependency spec can be a sealed file archive; only the installed manifest owns its version.
    const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const piVersion = packageVersion(
      new URL("../package.json", piEntry),
      "@earendil-works/pi-coding-agent",
    );
    return { piVersion, septVersion };
  } catch (error: unknown) {
    throw new SeptError("SEPT package metadata is invalid", { cause: error });
  }
}
