/** Five-method facade over existing stable-ID webhooks and authoritative task HTTP routes. */
import type {
  CancelResult,
  ConversationOptions,
  ConversationPage,
  CreateTaskInput,
  MessageAdmission,
  RequestOptions,
  SendMessageInput,
  TaskAdmission,
  TaskClient,
  TaskClientOptions,
  TaskProjection,
} from "./contracts.js";
import {
  clientConfiguration,
  conversationQuery,
  encodeEnvelope,
  requestSignal,
  runIdentifier,
  type ClientConfiguration,
} from "./request-codecs.js";
import {
  cancelResult,
  conversationPage,
  messageAdmission,
  taskAdmission,
  taskProjection,
} from "./response-codecs.js";
import { requestJson } from "./transport.js";
import { TaskClientError } from "./errors.js";

function taskBody(input: CreateTaskInput): string {
  try {
    return encodeEnvelope(input, {
      version: 1,
      source: input.source,
      eventId: input.eventId,
      kind: "task",
      task: input.task,
    });
  } catch {
    throw new TaskClientError("configuration");
  }
}

function messageBody(input: SendMessageInput): { runId: string; body: string } {
  try {
    const runId = runIdentifier(input.runId);
    const body = encodeEnvelope(input, {
      version: 1,
      source: input.source,
      eventId: input.eventId,
      kind: "operator_message",
      runId,
      message: input.message,
    });
    return { runId, body };
  } catch {
    throw new TaskClientError("configuration");
  }
}

async function createTask(
  configuration: ClientConfiguration,
  input: CreateTaskInput,
  options?: RequestOptions,
): Promise<TaskAdmission> {
  const body = taskBody(input);
  const response = await requestJson(
    configuration,
    "/v1/webhooks",
    "POST",
    body,
    requestSignal(options),
  );
  return taskAdmission(response.body, response.status);
}

async function sendMessage(
  configuration: ClientConfiguration,
  input: SendMessageInput,
  options?: RequestOptions,
): Promise<MessageAdmission> {
  const { runId, body } = messageBody(input);
  const response = await requestJson(
    configuration,
    "/v1/webhooks",
    "POST",
    body,
    requestSignal(options),
  );
  return messageAdmission(response.body, response.status, runId);
}

async function getTask(
  configuration: ClientConfiguration,
  input: string,
  options?: RequestOptions,
): Promise<TaskProjection> {
  const runId = runIdentifier(input);
  const response = await requestJson(
    configuration,
    `/v1/tasks/${runId}`,
    "GET",
    undefined,
    requestSignal(options),
  );
  return taskProjection(response.body, response.status, runId);
}

async function getConversation(
  configuration: ClientConfiguration,
  input: string,
  options?: ConversationOptions,
): Promise<ConversationPage> {
  const runId = runIdentifier(input);
  const { after, limit } = conversationQuery(options);
  const path = `/v1/tasks/${runId}/conversation?after=${String(after)}&limit=${String(limit)}`;
  const response = await requestJson(
    configuration,
    path,
    "GET",
    undefined,
    requestSignal(options),
    "conversation",
  );
  return conversationPage(response.body, response.status, after, limit);
}

async function cancel(
  configuration: ClientConfiguration,
  input: string,
  options?: RequestOptions,
): Promise<CancelResult> {
  const runId = runIdentifier(input);
  const response = await requestJson(
    configuration,
    `/v1/tasks/${runId}/cancel`,
    "POST",
    undefined,
    requestSignal(options),
  );
  return cancelResult(response.body, response.status, runId);
}

/** Create an import-safe HTTP client with explicit worker authority and no retry/polling state. */
export function createTaskClient(options: TaskClientOptions): TaskClient {
  const configuration = clientConfiguration(options);
  return {
    createTask: (input, options) => createTask(configuration, input, options),
    sendMessage: (input, options) => sendMessage(configuration, input, options),
    getTask: (runId, options) => getTask(configuration, runId, options),
    getConversation: (runId, options) => getConversation(configuration, runId, options),
    cancel: (runId, options) => cancel(configuration, runId, options),
  };
}

export { TaskClientError } from "./errors.js";
