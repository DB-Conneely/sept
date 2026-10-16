/** Sanitized classified failures at the HTTP client trust boundary. */
import { SeptError } from "../durable/index.js";
import type { TaskClientErrorKind } from "./contracts.js";

const MESSAGES: Readonly<Record<TaskClientErrorKind, string>> = {
  configuration: "Task client configuration or request is invalid",
  aborted: "Task client request was aborted; durable acceptance may have occurred",
  timeout: "Task client request timed out; durable acceptance may have occurred",
  transport: "Task client transport failed; durable acceptance may have occurred",
  http: "Task client received an HTTP error",
  protocol: "Task client received an invalid or oversized response",
};

/** Bounded credential-free failure, with HTTP status and validated conversation gap when available. */
export class TaskClientError extends SeptError {
  public constructor(
    public readonly kind: TaskClientErrorKind,
    public readonly status?: number,
    public readonly retainedFrom?: number,
  ) {
    super(MESSAGES[kind]);
  }
}
