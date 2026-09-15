import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelAccessService, type AuthenticationStatus } from "../model-access/index.js";

export { getAgentDir };

export async function inspectPi(agentDir: string, provider: string): Promise<{ provider: string; authenticated: boolean; subscription: boolean; authentication: AuthenticationStatus }> {
  const access = await ModelAccessService.create(agentDir);
  const authentication = await access.authenticationStatus(provider, AbortSignal.timeout(15_000));
  return { provider, authenticated: authentication.state === "authenticated", subscription: authentication.method === "subscription", authentication };
}
