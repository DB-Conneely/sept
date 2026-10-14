/** Stateless bounded startup codec; WarmHandsChannel and Engine retain attachment/lifetime ownership. */
import { authenticateHandsHello, EngineControlError } from "./contracts.js";
import { SeptError } from "../durable/index.js";
import type { HandsAttachment } from "./hands-processes.js";
import {
  HandsFrameDecoder,
  HANDS_REQUEST_BYTES,
  type HandsFrame,
  type HandsCorrelation,
} from "./protocol.js";
/** Authenticate and join one bounded guarded startup before any resident operation is admitted. */
export async function warmHandsHandshake(
  attachment: HandsAttachment,
  correlation: HandsCorrelation,
  challenge: string,
): Promise<Extract<HandsFrame, { kind: "hello" }>> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let hello: HandsFrame | undefined;
    const fail = (error: Error): void => {
      releaseHelloListener(attachment, decoder, timer, consume);
      reject(error);
    };
    const decoder = helloDecoder((frame) => {
      if (hello !== undefined) {
        throw new SeptError("Hands duplicate handshake was refused");
      }
      hello = frame;
    }, fail);
    const consume = (chunk: Buffer): void => {
      try {
        decoder.write(chunk);
        if (hello !== undefined) {
          decoder.finish();
          attachment.stdout.pause();
          releaseHelloListener(attachment, decoder, timer, consume);
          resolve(authenticateHandsHello(hello, correlation, challenge));
        }
      } catch (error: unknown) {
        fail(error instanceof Error ? error : new SeptError("Hands handshake failed"));
      }
    };
    const timer = setTimeout(() => {
      fail(EngineControlError.at("rpc-handshake", started, { timeout: true }));
    }, 10_000);
    attachment.stdout.on("data", consume);
    void attachment.joined.then(() => {
      joinedHelloFailure(attachment, started, fail);
    });
  });
}

function helloDecoder(
  accept: (frame: HandsFrame) => void,
  fail: (error: Error) => void,
): HandsFrameDecoder {
  return new HandsFrameDecoder(HANDS_REQUEST_BYTES, accept, fail);
}

function releaseHelloListener(
  attachment: HandsAttachment,
  decoder: HandsFrameDecoder,
  timer: NodeJS.Timeout,
  consume: (chunk: Buffer) => void,
): void {
  clearTimeout(timer);
  attachment.stdout.removeListener("data", consume);
  try {
    decoder.finish();
  } catch {
    /* The opening failure already owns the framing classification. */
  }
}

function joinedHelloFailure(
  attachment: HandsAttachment,
  started: number,
  fail: (error: Error) => void,
): void {
  try {
    attachment.assertJoined();
    fail(
      EngineControlError.at("rpc-handshake-lost", started, {
        requestJoined: true,
        attachmentClosed: true,
        connectionsReleased: true,
      }),
    );
  } catch (error: unknown) {
    fail(error instanceof Error ? error : new SeptError("Hands handshake attachment failed"));
  }
}
