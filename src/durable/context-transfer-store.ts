/**
 * Owns checkpoint and handover persistence below RunStore. Runtime supplies lifecycle decisions, while
 * this store guarantees recoverable evidence and message-consumption proof before session authority
 * advances; handover JSON, Markdown, event, and snapshot must be durable before replacement.
 */

import { basename, join, resolve } from "node:path";
import type {
  DurableHandover,
  Handover,
  OperatorMessage,
  RunEvent,
  RunSnapshot,
  WorkControl,
} from "./contracts.js";
import { renderHandover, validateDurableHandover } from "./control-codecs.js";
import { validateRunEvent } from "./evidence-codecs.js";
import { SeptError } from "./errors.js";
import { atomicWrite, now, readJson, scanJsonLines } from "./filesystem.js";

type RecordRunEvent = (type: string, fields?: Record<string, unknown>) => RunEvent;
type UpdateSnapshot = (patch: Partial<RunSnapshot>) => RunSnapshot;
type ConsumeMessages = (
  messages: OperatorMessage[],
  proofType: "work_checkpoint" | "handover_written",
) => void;

interface ContextTransferOptions {
  runDir: string;
  runId: string;
  eventsPath: string;
  recordRunEvent: RecordRunEvent;
  updateSnapshot: UpdateSnapshot;
  consumeMessages: ConsumeMessages;
}

/** Owns checkpoint and handover evidence that transfers authority across restarts and sessions. */
class ContextTransferStore {
  public constructor(private readonly options: ContextTransferOptions) {}

  /** Persist all handover artifacts and replacement authority before consuming input. */
  public persistHandover(
    epoch: number,
    predecessorSessionId: string,
    predecessorSessionFile: string | undefined,
    handover: Handover,
    messages: OperatorMessage[],
  ): DurableHandover {
    const value = this.handoverValue(
      epoch,
      predecessorSessionId,
      predecessorSessionFile,
      handover,
      messages,
    );
    const stem = `epoch-${String(epoch).padStart(4, "0")}`;
    const directory = join(this.options.runDir, "handovers");
    atomicWrite(join(directory, `${stem}.json`), value);
    atomicWrite(join(directory, `${stem}.md`), renderHandover(value));
    this.recordHandoverEvent(value, stem);
    // Replacement authority must be fsynced before input consumption or fresh-session creation.
    this.options.updateSnapshot(this.handoverSnapshotPatch(value));
    this.options.consumeMessages(messages, "handover_written");
    return value;
  }

  /** Return the latest validated handover selected by durable event order. */
  public latestHandover(): DurableHandover | undefined {
    let relativePath: string | undefined;
    scanJsonLines(this.options.eventsPath, (input) => {
      const event = validateRunEvent(input);
      if (event.type === "handover_written" && typeof event.json === "string") {
        relativePath = event.json;
      }
      return undefined;
    });
    if (relativePath === undefined) {
      return undefined;
    }
    const handoverPath = resolve(this.options.runDir, relativePath);
    const handoverRoot = `${resolve(this.options.runDir, "handovers")}/`;
    if (!handoverPath.startsWith(handoverRoot)) {
      throw new SeptError("Durable handover path escapes its run directory");
    }
    return validateDurableHandover(readJson(handoverPath));
  }

  /** Persist exact checkpoint evidence before marking operator input consumed. */
  public checkpoint(control: WorkControl, messages: OperatorMessage[], sessionId: string): void {
    this.options.recordRunEvent("work_checkpoint", {
      control,
      sessionId,
      messageIds: messages.map((message) => message.id),
      operatorMessages: messages,
    });
    this.options.consumeMessages(messages, "work_checkpoint");
  }

  /** Build bounded restart context from the latest durable handover and checkpoint. */
  public recoveryContext(): string {
    let latestControl: unknown = null;
    scanJsonLines(this.options.eventsPath, (input) => {
      const event = validateRunEvent(input);
      if (event.type === "work_checkpoint" && typeof event.control === "object") {
        latestControl = event.control;
      }
      return undefined;
    });
    const handover = this.latestHandover();
    const projected =
      handover === undefined
        ? null
        : {
            ...handover,
            ...(handover.predecessorSessionFile === undefined
              ? {}
              : {
                  predecessorSessionFile: `<pi-session>/${basename(handover.predecessorSessionFile)}`,
                }),
          };
    return JSON.stringify(
      {
        handover: projected,
        latestWorkControl: latestControl,
        note: "The controller restarted. Trust this durable state and the workspace; do not assume an interrupted, uncheckpointed action completed.",
      },
      undefined,
      2,
    );
  }

  private handoverValue(
    epoch: number,
    predecessorSessionId: string,
    predecessorSessionFile: string | undefined,
    handover: Handover,
    messages: OperatorMessage[],
  ): DurableHandover {
    const value: DurableHandover = {
      formatVersion: 1,
      runId: this.options.runId,
      epoch,
      predecessorSessionId,
      operatorMessages: messages,
      handover,
      writtenAt: now(),
    };
    if (predecessorSessionFile !== undefined) {
      value.predecessorSessionFile = predecessorSessionFile;
    }
    return validateDurableHandover(value);
  }

  private recordHandoverEvent(value: DurableHandover, stem: string): void {
    this.options.recordRunEvent("handover_written", {
      epoch: value.epoch,
      predecessorSessionId: value.predecessorSessionId,
      json: `handovers/${stem}.json`,
      markdown: `handovers/${stem}.md`,
      messageIds: value.operatorMessages.map((message) => message.id),
      operatorMessages: value.operatorMessages,
    });
  }

  private handoverSnapshotPatch(value: DurableHandover): Partial<RunSnapshot> {
    const patch: Partial<RunSnapshot> = {
      phase: "handover_durable",
      predecessorSessionId: value.predecessorSessionId,
      handoverEpoch: value.epoch,
    };
    if (value.predecessorSessionFile !== undefined) {
      patch.predecessorSessionFile = value.predecessorSessionFile;
    }
    return patch;
  }
}

export { ContextTransferStore };
