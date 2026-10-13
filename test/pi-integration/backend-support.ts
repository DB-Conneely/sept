/** Explicit local test double for native lifecycle regressions; it establishes no confinement claim. */

import { AssertionError } from "node:assert";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  createBashTool,
  DefaultResourceLoader,
  SettingsManager,
  formatSkillsForPrompt,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ExecutionBackend, HandsRequest } from "../../src/execution/index.js";
import { PiSessionHost } from "../../src/pi-integration/index.js";
import type { HostFactory } from "../../src/runtime/index.js";
import { executeHandsRequest } from "../../src/execution/hands-entry.js";

/** Deliberately injected fixture port, isolated to generated test directories. Installed security proof uses Docker. */
export class FixtureExecutionBackend implements ExecutionBackend {
  public readonly id = "generated-fixture";
  public readonly generation = randomUUID();
  public readonly shell = true;
  public readonly resourceProjectionDirectory: string;
  public readonly resourceProjectionReceipt: string;
  public constructor(
    public readonly cwd: string,
    root = dirname(cwd),
  ) {
    this.resourceProjectionDirectory = join(root, "resources");
    this.resourceProjectionReceipt = join(root, "projection-receipt.json");
    mkdirSync(this.resourceProjectionDirectory, { recursive: true });
  }

  public async invoke(request: HandsRequest, context: Context): Promise<unknown> {
    if (request.kind === "tool" && request.name === "bash") {
      assertFixtureCommand(request.arguments.command);
      return createBashTool(this.cwd).execute(
        request.callId,
        { command: request.arguments.command },
        context.abortSignal,
      );
    }
    if (request.kind !== "resources") {
      return executeHandsRequest(request, this.cwd);
    }
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: this.resourceProjectionDirectory,
      settingsManager: SettingsManager.create(this.cwd, this.resourceProjectionDirectory, {
        projectTrusted: false,
      }),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      additionalSkillPaths: [
        join(this.resourceProjectionDirectory, "skills"),
        resolve(this.cwd, ".pi/skills"),
      ],
    });
    await loader.reload();
    return {
      system: loader.getSystemPrompt() ?? "",
      append: loader.getAppendSystemPrompt().join("\n\n"),
      instructions: loader
        .getAgentsFiles()
        .agentsFiles.map((file) => file.content)
        .join("\n\n"),
      skills: formatSkillsForPrompt(loader.getSkills().skills, "read"),
    };
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

function assertFixtureCommand(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new AssertionError({ message: "Fixture command must be text" });
  }
}

const fixtureRoots = new WeakMap<ModelRuntime, string>();

/** Register the generated root explicitly without inspecting credential storage or values. */
export function registerFixtureBackend(models: ModelRuntime, agentDir: string): void {
  fixtureRoots.set(models, dirname(agentDir));
}

/** Build an explicitly injected port, never a production ambient fallback. */
export function fixtureBackend(models: ModelRuntime): FixtureExecutionBackend {
  const root = fixtureRoots.get(models);
  if (root === undefined) {
    throw new AssertionError({ message: "Fixture backend root is missing" });
  }
  return new FixtureExecutionBackend(join(root, "workspace"));
}

/** The same explicit local port is reused only by native lifecycle supporting fixtures. */
export function fixtureHostFactory(models: ModelRuntime): HostFactory {
  return (manifest, store, agent, existing, telemetry) =>
    PiSessionHost.create(manifest, store, agent, existing, telemetry, {
      modelRuntime: models,
      executionBackend: fixtureBackend(models),
    });
}
