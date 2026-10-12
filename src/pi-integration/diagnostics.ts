/**
 * Exposes bounded, credential-blind Pi installation diagnostics to CLI composition. Model access
 * retains authentication authority and credential storage; this adapter returns only normalized
 * provider status and never reads or projects credential values.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelAccessService, type AuthenticationStatus } from "../model-access/index.js";

export { getAgentDir };

/** Inspect one Pi provider through model access with a fixed timeout and secret-free projection. */
export async function inspectPi(
  agentDir: string,
  provider: string,
): Promise<{
  provider: string;
  authenticated: boolean;
  subscription: boolean;
  authentication: AuthenticationStatus;
}> {
  const access = await ModelAccessService.create(agentDir);
  const authentication = await access.authenticationStatus(provider, AbortSignal.timeout(15_000));
  return {
    provider,
    authenticated: authentication.state === "authenticated",
    subscription: authentication.method === "subscription",
    authentication,
  };
}
