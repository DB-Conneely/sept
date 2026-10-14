/** Stateless bounded Engine wire helpers; DockerEngineControl remains the sole control owner. */
import { request, type Agent, type ClientRequest, type IncomingMessage } from "node:http";
import { SeptError } from "../durable/index.js";
import { EngineControlError, type EngineExec } from "./contracts.js";
import { parseEngineJson, collectEngineMetadata } from "./protocol.js";
import { HandsAttachment } from "./hands-processes.js";
function control(
  socketPath: string,
  path: string,
  method: "GET" | "POST",
  input: string,
  agent?: Agent,
  signal?: AbortSignal,
  upgrade = false,
): ClientRequest {
  return request({
    socketPath,
    path,
    method,
    agent: agent ?? false,
    maxHeaderSize: 8192,
    signal,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(input),
      ...(upgrade ? { Connection: "Upgrade", Upgrade: "tcp" } : {}),
    },
  });
}
/** Fixed bounded Unix metadata exchange; its calling Engine owner retains the socket and daemon authority. */
export function engineExchange(
  socketPath: string,
  agent: Agent | undefined,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const input = body === undefined ? "" : JSON.stringify(body);
  if (Buffer.byteLength(input) > 512 * 1024) {
    throw new SeptError("Hands Engine request exceeds its bound");
  }
  const request = control(socketPath, path, method, input, agent, signal);
  return exchangeMetadata(request, input, () => agent === undefined || signal?.aborted === true);
}
function exchangeMetadata(
  request: ClientRequest,
  input: string,
  released: () => boolean,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let failure: EngineControlError | undefined;
    let output: Buffer | undefined;
    let completed = Promise.resolve();
    const fail = (error: EngineControlError): void => {
      failure ??= error;
      request.destroy();
    };
    const timer = setTimeout(() => {
      fail(EngineControlError.at("http", started, { timeout: true }));
    }, 30_000);
    request.once("response", (response) => {
      completed = receiveMetadata(response, started, fail, (result) => {
        output = result;
      });
    });
    request.once("error", () => {
      fail(EngineControlError.at("http", started));
    });
    request.once("close", () => {
      clearTimeout(timer);
      void completed.then(() => {
        settleMetadata(output, failure, released(), resolve, reject);
      });
    });
    request.end(input);
  });
}
function receiveMetadata(
  response: IncomingMessage,
  started: number,
  fail: (error: EngineControlError) => void,
  complete: (output: Buffer) => void,
): Promise<void> {
  return collectEngineMetadata(response, started)
    .then(complete)
    .catch((error: unknown) => {
      response.destroy();
      fail(error instanceof EngineControlError ? error : EngineControlError.at("http", Date.now()));
    });
}
function settleMetadata(
  output: Buffer | undefined,
  failure: EngineControlError | undefined,
  released: boolean,
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
): void {
  if (failure !== undefined || output === undefined) {
    reject(
      (failure ?? EngineControlError.at("http-lost", Date.now())).joined({
        attachmentClosed: false,
        connectionsReleased: released,
      }),
    );
    return;
  }
  try {
    resolve(parseEngineJson(output));
  } catch (error: unknown) {
    reject(error instanceof Error ? error : new SeptError("Hands Engine metadata is malformed"));
  }
}
/** Internal immutable wire specification, selected only by DockerEngineControl. */
export interface EngineAttachmentRequest {
  socketPath: string;
  path: string;
  execId: string;
  containerId: string;
  execution: EngineExec;
  signal: AbortSignal;
}
/** Open only the Engine-created fixed exec; the calling Engine owns every returned attachment until closure. */
export function openEngineAttachment(
  specification: EngineAttachmentRequest,
): Promise<HandsAttachment> {
  const { socketPath, path, execId, containerId, execution, signal } = specification;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const body = JSON.stringify({ Detach: false, Tty: false });
    const request = control(socketPath, path, "POST", body, undefined, signal, true);
    const joined = new Promise<void>((resolve) => request.once("close", resolve));
    const fail = (status: number | null = null, timeout = false): void => {
      clearTimeout(timer);
      request.destroy();
      void joined.then(() => {
        reject(
          EngineControlError.at("exec-upgrade", started, {
            status,
            timeout,
            requestJoined: true,
            attachmentClosed: true,
            connectionsReleased: true,
          }),
        );
      });
    };
    const timer = setTimeout(() => {
      fail(null, true);
    }, 10_000);
    request.once("upgrade", (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 101) {
        socket.destroy();
        fail(response.statusCode ?? null);
        return;
      }
      resolve(new HandsAttachment(execId, containerId, socket, head, joined, signal, execution));
    });
    observeUpgradeFailure(request, timer, fail);
    request.end(body);
  });
}

/** Collect fixed trusted helper output only after joined EOF; native bodies use resident RPC instead. */
export async function collectHandsAttachment(
  attachment: HandsAttachment,
  execution: EngineExec,
): Promise<string> {
  const started = Date.now();
  const output: Buffer[] = [];
  let bytes = 0;
  const collect = async (): Promise<void> => {
    for await (const chunk of attachment.stdout) {
      if (!Buffer.isBuffer(chunk)) {
        throw new SeptError("Hands output is not a byte stream");
      }
      const buffer = chunk;
      bytes += buffer.length;
      if (bytes > (execution.maximum ?? 4 * 1024 * 1024)) {
        throw EngineControlError.at("exec-stream", started, { overflow: true });
      }
      output.push(buffer);
    }
  };
  const collecting = collect();
  if (execution.confirm === undefined) {
    await attachment.end(execution.input ?? "");
  }
  try {
    await collecting;
    await attachment.joined;
    attachment.assertJoined();
  } finally {
    await attachment.abort();
  }
  return Buffer.concat(output).toString("utf8");
}

function observeUpgradeFailure(
  request: ClientRequest,
  timer: NodeJS.Timeout,
  fail: (status?: number | null) => void,
): void {
  request.once("response", (response) => {
    response.destroy();
    fail(response.statusCode ?? null);
  });
  request.once("error", () => {
    clearTimeout(timer);
    fail();
  });
}
