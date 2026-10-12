/**
 * Defines classifiable failures owned by durable storage. Runtime and ingress may map these classes
 * without parsing messages; errors carry bounded operational context and never credential values or
 * hostile durable payloads.
 */

/** Classified base error for bounded SEPT durability and lifecycle failures. */
export class SeptError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Indicates that durable operator input reached its configured capacity. */
export class QueueCapacityError extends SeptError {}

/** Native dispatch must stop once SEPT's durable active-time authority is exhausted. */
export class ExecutionTimeoutError extends SeptError {}

/** Indicates that a requested conversation cursor is older than retained evidence. */
export class ConversationCursorExpiredError extends SeptError {
  public constructor(public readonly retainedFrom: number) {
    super(`conversation cursor expired; earliest retained cursor is ${String(retainedFrom)}`);
  }
}
