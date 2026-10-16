/** Public task-client boundary; runtime composition is deliberately absent from this entry. */
export { createTaskClient, TaskClientError } from "./client.js";
export type {
  TaskClientOptions,
  RequestOptions,
  CreateTaskInput,
  SendMessageInput,
  TaskAdmission,
  MessageAdmission,
  TaskProjection,
  ConversationOptions,
  TerminalStatus,
  ConversationPage,
  CancelResult,
  TaskClient,
} from "./contracts.js";
export type {
  TaskRequest,
  RunStatus,
  Manifest,
  RunSnapshot,
  ConversationEvent,
} from "../durable/index.js";
