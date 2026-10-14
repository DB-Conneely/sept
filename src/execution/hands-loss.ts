/** Bounded loss facts describe observed authority and closure without retaining hostile diagnostics. */
import { EngineControlError } from "./engine-failure.js";
import { SeptError } from "../durable/index.js";
import type { EngineFailureFacts, HandsRequest } from "./contracts.js";

/** The backend owns stage/elapsed/cancel/effect facts; namespace closure is asserted only after exact stop. */
export interface HandsLossFacts {
  stage: "admission" | "dispatch" | "effect" | "result" | "channel" | "shutdown";
  operation: HandsRequest["kind"] | "idle";
  elapsedMs: number;
  cancelled: boolean;
  authorityLost: true;
  effectsUncertain: boolean;
  namespaceStopped: boolean;
  engine?: EngineFailureFacts;
}

/** Lost transport/identity seals native work; a typed observed closure never implies an effect did not happen. */
export class HandsBackendUnavailableError extends SeptError {
  public readonly facts: HandsLossFacts | undefined;
  public constructor(message: string, options?: ErrorOptions & { facts?: HandsLossFacts }) {
    super(message, options);
    this.facts = options?.facts;
  }
}

/** Synchronous admission seal retains observed loss facts while an asynchronous namespace stop remains pending. */
export function assertHandsAvailable(owner: {
  unavailable: boolean;
  cancelled: boolean;
  namespaceStopped: boolean;
  loss: Error | undefined;
}): void {
  if (!owner.unavailable && !owner.cancelled) {
    return;
  }
  throw new HandsBackendUnavailableError(
    "Hands operation was interrupted; effects may be uncertain",
    {
      cause: owner.loss,
      facts: {
        stage: "admission",
        operation: "idle",
        elapsedMs: 0,
        cancelled: owner.cancelled,
        authorityLost: true,
        effectsUncertain: false,
        namespaceStopped: owner.namespaceStopped,
        ...(owner.loss instanceof EngineControlError ? { engine: owner.loss.facts } : {}),
      },
    },
  );
}
