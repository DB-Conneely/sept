import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PiModelAccess, type SafeAuthStatus } from "./models.js";

export { getAgentDir };

export async function inspectPi(agentDir: string, provider: string): Promise<{ provider: string; authenticated: boolean; subscription: boolean; authentication: SafeAuthStatus }> {
  const access = await PiModelAccess.create(agentDir);
  const authentication = await access.authStatus(provider, true, AbortSignal.timeout(15_000));
  return { provider, authenticated: authentication.state === "configured", subscription: authentication.subscription, authentication };
}
