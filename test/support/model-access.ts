import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelAccessService } from "../../src/model-access/index.js";

/** Credential-isolated Pi runtime for tests whose injected session host does not perform model work. */
export async function testModelAccess(): Promise<ModelAccessService> {
  const agentDir = mkdtempSync(join(tmpdir(), "sept-model-access-fixture-"));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("openai-codex", {
    baseUrl: "http://127.0.0.1.invalid/v1",
    apiKey: "deterministic-test-placeholder",
    api: "openai-completions",
    models: [{ id: "gpt-5.6-sol", name: "deterministic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 16_384 }],
  });
  const access = await ModelAccessService.create(agentDir, { runtime });
  const status = await access.authenticationStatus("openai-codex");
  if (status.state !== "authenticated" || status.method !== "api_key") throw new Error("deterministic model-access fixture is not credential-isolated");
  return access;
}
