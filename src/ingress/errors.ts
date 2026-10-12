/**
 * Defines transport-classified failures owned by ingress. Runtime and durability errors keep
 * their native types; this wrapper exists only when an HTTP status is part of the contract.
 */

import { SeptError } from "../durable/index.js";

/** Carries the safe HTTP status and public message selected by the ingress boundary. */
export class RequestError extends SeptError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Distinguishes webhook idempotency collisions without message-text control flow. */
export class WebhookCollisionError extends RequestError {
  public constructor() {
    super(409, "webhook event key collision");
  }
}
