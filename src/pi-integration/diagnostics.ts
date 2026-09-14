import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";

export { getAgentDir };

export async function inspectPi(agentDir: string, provider: string): Promise<{ provider: string; authenticated: boolean; subscription: boolean }> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
  });
  return {
    provider,
    authenticated: runtime.hasConfiguredAuth(provider),
    subscription: runtime.isUsingSubscription(provider),
  };
}
