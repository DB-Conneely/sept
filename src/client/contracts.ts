/** Public transport contracts; callers own delivery identities, retry decisions and worker lifetime. */
import type {
  ConversationEvent,
  Manifest,
  RunSnapshot,
  RunStatus,
  TaskRequest,
} from "../durable/index.js";

/** One authenticated worker origin; timeout bounds each complete HTTP exchange. */
export interface TaskClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/** Caller cancellation cannot retract a task or message already accepted durably. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Stable source/eventId identify a replay-safe task delivery; the caller supplies both. */
export interface CreateTaskInput {
  source: string;
  eventId: string;
  task: TaskRequest;
}

/** Stable delivery identity accompanies exact operator text for one existing run. */
export interface SendMessageInput {
  source: string;
  eventId: string;
  runId: string;
  message: string;
}

/** Original admission receipt, including active on replay after a later terminal transition. */
export interface TaskAdmission {
  kind: "task";
  runId: string;
  status: "active";
  duplicate: boolean;
}

/** Original message receipt; duplicate delivery retains the same message identity. */
export interface MessageAdmission {
  kind: "operator_message";
  runId: string;
  messageId: string;
  duplicate: boolean;
}

/** Authoritative current state with public workspace/session path projections. */
export interface TaskProjection {
  manifest: Manifest;
  state: RunSnapshot;
}

/** Explicit bounded retained-history position; defaults are after zero and limit one hundred. */
export interface ConversationOptions extends RequestOptions {
  after?: number;
  limit?: number;
}

/** Current terminal metadata can differ from historical terminal events after a reopen. */
export type TerminalStatus = "cancelled" | "complete" | "blocked" | "failed";

/** A strictly ordered retained page; expiry requires a visible caller-owned recovery decision. */
export interface ConversationPage {
  events: ConversationEvent[];
  nextCursor: number;
  retainedFrom: number;
  terminal: { status: TerminalStatus } | null;
}

/** A true result may still be cancelling; getTask reports subsequent authoritative settlement. */
export interface CancelResult {
  runId: string;
  status: RunStatus;
  cancelled: boolean;
}

/** Five bounded HTTP operations; no automatic IDs, retry, polling or streaming ownership. */
export interface TaskClient {
  createTask(input: CreateTaskInput, options?: RequestOptions): Promise<TaskAdmission>;
  sendMessage(input: SendMessageInput, options?: RequestOptions): Promise<MessageAdmission>;
  getTask(runId: string, options?: RequestOptions): Promise<TaskProjection>;
  getConversation(runId: string, options?: ConversationOptions): Promise<ConversationPage>;
  cancel(runId: string, options?: RequestOptions): Promise<CancelResult>;
}

/** Stable failure classification; response bodies and credential-bearing cause text stay private. */
export type TaskClientErrorKind =
  | "configuration"
  | "aborted"
  | "timeout"
  | "transport"
  | "http"
  | "protocol";
