/**
 * Owns sequenced internal run events and bounded payload-free diagnostics beneath RunStore. Lifecycle
 * callers supply facts, while this store fsyncs event order, streams bounded retrieval, and truncates
 * logs without allowing diagnostics to become durable authority.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { RunEvent } from "./contracts.js";
import { validateRunEvent } from "./evidence-codecs.js";
import { appendSynced, atomicWrite, now, scanJsonLines } from "./filesystem.js";

/** Owns append-only internal events and the bounded lifecycle diagnostic log. */
class RunEvidenceStore {
  private sequence: number;

  public constructor(
    private readonly eventsPath: string,
    private readonly logPath: string,
  ) {
    let sequence = 0;
    scanJsonLines(eventsPath, (value) => {
      const event = validateRunEvent(value);
      sequence = event.seq;
      return undefined;
    });
    this.sequence = sequence;
  }

  /** Append and fsync one sequenced internal event. */
  public event(type: string, fields: Record<string, unknown> = {}): RunEvent {
    const event = validateRunEvent({
      ...fields,
      seq: this.sequence + 1,
      type,
      at: now(),
    });
    appendSynced(this.eventsPath, event);
    this.sequence = event.seq;
    return event;
  }

  /** Stream a response-bounded event page from append-only evidence. */
  public events(after = 0, limit = 250): RunEvent[] {
    const events: RunEvent[] = [];
    const boundedLimit = Math.min(Math.max(limit, 1), 1000);
    scanJsonLines(this.eventsPath, (value) => {
      const event = validateRunEvent(value);
      if (event.seq > after) {
        events.push(event);
      }
      return events.length < boundedLimit ? undefined : false;
    });
    return events;
  }

  /** Append one payload-free operational record and retain a bounded tail. */
  public log(record: Record<string, unknown>, maxBytes = 5 * 1024 * 1024): void {
    appendSynced(this.logPath, { at: now(), ...record });
    if (statSync(this.logPath).size <= maxBytes) {
      return;
    }
    const content = readFileSync(this.logPath);
    const tail = content.subarray(Math.max(0, content.length - Math.floor(maxBytes * 0.8)));
    const firstNewline = tail.indexOf(10);
    atomicWrite(
      this.logPath,
      tail.subarray(firstNewline < 0 ? 0 : firstNewline + 1).toString("utf8"),
    );
  }

  /** Return at most one MiB from the latest bounded diagnostic records. */
  public logTail(maxBytes = 512 * 1024): string {
    if (!existsSync(this.logPath)) {
      return "";
    }
    const content = readFileSync(this.logPath);
    const retainedBytes = Math.min(maxBytes, 1024 * 1024);
    return content.subarray(Math.max(0, content.length - retainedBytes)).toString("utf8");
  }
}

export { RunEvidenceStore };
