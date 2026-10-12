/** Ports operator instructions and skills through Pi's native loader with repository trust disabled. */

import {
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import { section, type PromptSection } from "@earendil-works/pi-durable";
import { SeptError, type Manifest } from "../durable/index.js";

/** Native sections retain SYSTEM/APPEND_SYSTEM/AGENTS and trusted operator skills. */
export async function loadDurableSections(
  manifest: Manifest,
  agentDir: string,
): Promise<PromptSection[]> {
  const settingsManager = SettingsManager.create(manifest.workspace, agentDir, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: manifest.workspace,
    agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const skills = loader.getSkills();
  if (skills.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new SeptError("Pi trusted skills could not be loaded");
  }
  return [
    section("system", () => loader.getSystemPrompt() ?? "You are SEPT, a durable coding worker.", {
      tag: false,
    }),
    section("append-system", () => loader.getAppendSystemPrompt().join("\n\n"), { tag: false }),
    section("repository-instructions", () =>
      loader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.content)
        .join("\n\n"),
    ),
    section("skills", () => formatSkillsForPrompt(skills.skills, "read")),
  ];
}
