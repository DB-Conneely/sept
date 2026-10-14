/** Safe classifications for the sole local Engine owner; peer diagnostics never enter these facts. */
import { SeptError } from "../durable/index.js";

/** Sanitized control facts exclude peer payloads, command text, diagnostics and endpoint paths. */
export interface EngineFailureFacts {
  stage:
    | "http"
    | "http-lost"
    | "closed-owner"
    | "exec-upgrade"
    | "exec-stream"
    | "exec-exit"
    | "exec-write"
    | "exec-shutdown"
    | "exec-partial-frame"
    | "stop-handshake"
    | "rpc-lost"
    | "rpc-handshake"
    | "rpc-handshake-lost"
    | "rpc-partial-frame"
    | "rpc-frame-size"
    | "rpc-frame-count"
    | "rpc-payload-size"
    | "rpc-truncated"
    | "rpc-protocol";
  elapsedMs: number;
  code: number | null;
  signal: null;
  status: number | null;
  timeout: boolean;
  overflow: boolean;
  /** The owning request/attachment has settled; this does not release retained Agent connections. */
  requestJoined: boolean;
  attachmentClosed: boolean;
  connectionsReleased: boolean;
}
/** Engine loss retains observable exit facts; an unknown signal is never fabricated from a code. */
export class EngineControlError extends SeptError {
  /** Facts start unjoined; only the owning finalizer may attest observed closure. */
  public static at(
    stage: EngineFailureFacts["stage"],
    started: number,
    details: Partial<EngineFailureFacts> = {},
  ): EngineControlError {
    return new EngineControlError({
      stage,
      elapsedMs: Math.max(0, Date.now() - started),
      code: null,
      signal: null,
      status: null,
      timeout: false,
      overflow: false,
      requestJoined: false,
      attachmentClosed: false,
      connectionsReleased: false,
      ...details,
    });
  }
  /** Called after observed request/socket closure, without confusing retained connections with join. */
  public joined(
    closure: Pick<EngineFailureFacts, "attachmentClosed" | "connectionsReleased">,
  ): EngineControlError {
    return new EngineControlError({ ...this.facts, requestJoined: true, ...closure });
  }
  public constructor(public readonly facts: EngineFailureFacts) {
    super(`Hands Engine control failed at ${facts.stage}`);
  }
}
