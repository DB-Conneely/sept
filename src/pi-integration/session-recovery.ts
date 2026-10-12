/**
 * Projects native Pi messages into bounded text and recognizes already-durable rotation progress on
 * restart. It reads session history but never mutates it; invocation orchestration owns any follow-up
 * prompt or steer, so recovery cannot accidentally duplicate native session authority.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ROTATION_STEER } from "./prompts.js";

/** Rotation markers and predecessor text recovered from one native Pi session history. */
export interface RotationRecovery {
  recoveredRotation: boolean;
  rotationMarker: number;
  rotationSteerRecorded: boolean;
  preRotationText: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

/** Extract only textual content from a native Pi message, ignoring tool and unknown content parts. */
export function sessionMessageText(message: unknown): string {
  if (!isRecord(message)) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}

/** Identify a previously recorded rotation steer and its immediately preceding assistant text. */
export function rotationRecovery(
  session: AgentSession,
  rotationRequired: boolean,
): RotationRecovery {
  const messages = [...session.messages];
  const rotationMarker = messages.findLastIndex(
    (message) => message.role === "user" && sessionMessageText(message) === ROTATION_STEER,
  );
  const previousAssistant = messages
    .slice(0, rotationMarker)
    .findLast((message) => message.role === "assistant");
  return {
    recoveredRotation: rotationRequired,
    rotationMarker,
    rotationSteerRecorded: rotationRequired && rotationMarker >= 0,
    preRotationText: sessionMessageText(previousAssistant) || undefined,
  };
}

/** Return whether a native Pi message is a completed, nonempty assistant handover candidate. */
export function isFinalAssistantMessage(message: unknown): boolean {
  if (!isRecord(message) || message.role !== "assistant") {
    return false;
  }
  if (sessionMessageText(message).length === 0) {
    return false;
  }
  return message.stopReason !== "aborted" && message.stopReason !== "error";
}
