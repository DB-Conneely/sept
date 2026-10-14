/** Resident framing delegates native bodies without exposing stdout or retained authority to helper processes. */
import { residentHandshake } from "./hands-bootstrap.js";
import { assertHandsCorrelation, assertHandsActive, type HandsEffectCheck } from "./contracts.js";
import { SeptError } from "../durable/index.js";
import {
  HANDS_REQUEST_BYTES,
  encodeHandsFrame,
  HandsFrameDecoder,
  type HandsFrame,
} from "./protocol.js";
import { createHandsBodies, type HandsBodies } from "./hands-discovery.js";
import { closeHandsResourceEpoch } from "./hands-resources.js";
import { executeHandsRequest } from "./hands-entry.js";
import { ResidentHandsCommand } from "./hands-command-client.js";
interface ResidentOperation {
  sequence: number;
  abort: AbortController;
  acknowledged: { effect: number; resolve: () => void } | undefined;
  effect: number;
  completed: Promise<void>;
  command: ResidentHandsCommand;
}
interface ResidentState {
  active: ResidentOperation | undefined;
  sequence: number;
  resetBudget: () => void;
}
/** Own the single serial resident operation and its correlated live effect acknowledgments. */
export async function runHandsResident(): Promise<void> {
  const hello = residentHandshake();
  const send = process.stdout.write.bind(process.stdout);
  // Only this immutable writer carries RPC. Native library/child diagnostics remain a separate Engine stream.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const bodies = createHandsBodies(process.cwd());
  const state: ResidentState = { active: undefined, sequence: 0, resetBudget: () => undefined };
  const respond = (frame: HandsFrame): void => {
    send(encodeHandsFrame(frame));
  };
  const accept = (frame: HandsFrame): void => {
    receiveResident(frame, hello, state, respond, bodies);
  };
  const decoder = new HandsFrameDecoder(HANDS_REQUEST_BYTES, accept, () => {
    process.stdin.destroy();
  });
  state.resetBudget = () => {
    decoder.beginOperation();
  };
  respond(hello);
  await receiveHandsInput(decoder, state, bodies);
}
async function receiveHandsInput(
  decoder: HandsFrameDecoder,
  state: ResidentState,
  bodies: HandsBodies,
): Promise<void> {
  try {
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) {
        throw new SeptError("Hands input is not a byte stream");
      }
      decoder.write(chunk);
    }
    decoder.finish();
  } finally {
    state.active?.abort.abort();
    state.active?.command.close();
    state.active?.acknowledged?.resolve();
    try {
      await state.active?.completed;
    } finally {
      closeHandsResourceEpoch(bodies.epoch);
    }
  }
}

function receiveResident(
  frame: HandsFrame,
  hello: HandsFrame,
  state: ResidentState,
  respond: (frame: HandsFrame) => void,
  bodies: HandsBodies,
): void {
  assertHandsCorrelation(
    frame,
    hello,
    frame.kind === "operation" ? state.sequence + 1 : state.sequence,
  );
  if (receiveControl(frame, state)) {
    return;
  }
  if (frame.kind !== "operation" || state.active !== undefined) {
    throw new SeptError("Hands resident control order was refused");
  }
  state.sequence += 1;
  const operation: ResidentOperation = {
    sequence: state.sequence,
    abort: new AbortController(),
    acknowledged: undefined,
    effect: 0,
    completed: Promise.resolve(),
    command: new ResidentHandsCommand(frame, respond),
  };
  state.active = operation;
  operation.completed = runResidentOperation(frame, operation, respond, bodies).finally(() => {
    state.active = undefined;
    state.resetBudget();
  });
}
function receiveControl(frame: HandsFrame, state: ResidentState): boolean {
  if (frame.kind === "ack") {
    acknowledgeResident(frame, state);
    return true;
  }
  if (frame.kind === "command-data" || frame.kind === "command-exit") {
    if (state.active === undefined) {
      throw new SeptError("Hands command parent is absent");
    }
    state.active.command.receive(frame);
    return true;
  }
  if (frame.kind === "cancel" && state.active !== undefined) {
    state.active.abort.abort();
    return true;
  }
  return false;
}
function acknowledgeResident(
  frame: Extract<HandsFrame, { kind: "ack" }>,
  state: ResidentState,
): void {
  const operation = state.active;
  if (operation === undefined) {
    throw new SeptError("Hands effect parent is absent");
  }
  const acknowledged = operation.acknowledged;
  if (
    acknowledged === undefined ||
    !frame.payload.allowed ||
    frame.payload.effect !== acknowledged.effect
  ) {
    throw new SeptError("Hands effect acknowledgment was refused");
  }
  acknowledged.resolve();
  operation.acknowledged = undefined;
}
async function runResidentOperation(
  frame: Extract<HandsFrame, { kind: "operation" }>,
  operation: ResidentOperation,
  respond: (frame: HandsFrame) => void,
  bodies: HandsBodies,
): Promise<void> {
  const parent = frame;
  try {
    const authorize = residentAuthorizer(parent, operation, respond);
    await authorize("operation", "");
    const result = await executeHandsRequest(
      frame.payload,
      process.cwd(),
      authorize,
      operation.abort.signal,
      bodies,
      operation.command.execute,
    );
    assertHandsActive(operation.abort.signal);
    respond({ ...parent, kind: "result", payload: result });
  } catch {
    respond({ ...parent, kind: "error", payload: { stage: "operation" } });
  }
}

function residentAuthorizer(
  parent: Extract<HandsFrame, { kind: "operation" }>,
  operation: ResidentOperation,
  respond: (frame: HandsFrame) => void,
): HandsEffectCheck {
  return async (right, path) => {
    assertHandsActive(operation.abort.signal);
    operation.effect += 1;
    const acknowledged = new Promise<void>((resolve) => {
      operation.acknowledged = { effect: operation.effect, resolve };
    });
    respond({
      ...parent,
      kind: "effect-check",
      payload: { effect: operation.effect, right, path },
    });
    await acknowledged;
    assertHandsActive(operation.abort.signal);
  };
}
