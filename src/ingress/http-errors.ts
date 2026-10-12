/**
 * Maps classified mechanism failures to bounded public HTTP responses. Hostile cause text remains
 * private unless it already belongs to an expected SEPT domain error.
 */

import type { ServerResponse } from "node:http";
import { ConversationCursorExpiredError, QueueCapacityError, SeptError } from "../durable/index.js";
import { RunNotFoundError, WorkerConflictError } from "../runtime/index.js";
import { RequestError } from "./errors.js";
import { jsonResponse } from "./http.js";

/** Convert one caught request failure into its stable public status and body. */
export function respondWithError(response: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    jsonResponse(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof RunNotFoundError) {
    jsonResponse(response, 404, { error: "unknown run" });
    return;
  }
  if (error instanceof ConversationCursorExpiredError) {
    jsonResponse(response, 410, { error: error.message });
    return;
  }
  if (error instanceof WorkerConflictError) {
    jsonResponse(response, 409, { error: error.message });
    return;
  }
  if (error instanceof QueueCapacityError) {
    jsonResponse(response, 429, { error: error.message });
    return;
  }
  if (error instanceof SeptError) {
    jsonResponse(response, 400, { error: error.message });
    return;
  }
  if (error instanceof SyntaxError) {
    jsonResponse(response, 400, { error: "request body must be valid JSON" });
    return;
  }
  jsonResponse(response, 500, { error: "internal error" });
}
