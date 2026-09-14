import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(projectRoot, "dist");
if (dirname(output) !== projectRoot) throw new Error("Refusing to clean outside the project root");
rmSync(output, { recursive: true, force: true });
