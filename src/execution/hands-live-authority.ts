/** Bounded live namespace qualification; opening alone owns recursive input provenance and immutable image facts. */
import type { DockerHandsConfiguration, HandsRequest } from "./contracts.js";
import type { DockerEngineControl } from "./docker-engine.js";
import { inspect } from "./docker-control.js";
import { validateDockerProfile, verifyKernelBinding } from "./profile.js";
import { validateNetworkEnforcement } from "./network-enforcement.js";

/** Exact generation/mount/caps/topology are live; only a true command network intent owns privileged filter probes. */
export async function validateLiveHands(
  configuration: DockerHandsConfiguration,
  engine: DockerEngineControl,
  request: HandsRequest,
  owner: {
    workspace: string;
    brainRoots: readonly string[];
    policyPath: string;
    controlEndpoint?: { address: string; port: number };
  },
): Promise<void> {
  const inspected = await inspect(configuration, engine);
  validateDockerProfile(configuration, inspected, owner.workspace, owner.brainRoots, {
    qualification: "live",
  });
  verifyKernelBinding(configuration, inspected, owner.policyPath);
  // Default-denied resident/helper effects cannot open sockets; warm connection lifetime cannot cache a network grant.
  const command = request.kind === "custom" || (request.kind === "tool" && request.name === "bash");
  if (command && request.arguments.network === true) {
    await validateNetworkEnforcement(configuration, inspected, owner.controlEndpoint, engine);
  }
}
