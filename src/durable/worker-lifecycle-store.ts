import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkerLifecycleState } from "./contracts.js";
import { validateWorkerLifecycle } from "./evidence-codecs.js";
import { atomicWrite, now, readJson } from "./filesystem.js";

/** Owns the fsynced state-root readiness record that gates worker admission. */
export class WorkerLifecycleStore {
  public readonly path: string;

  public constructor(public readonly root: string) {
    this.path = join(root, "worker-state.json");
  }

  /** Read validated readiness or return the initial accepting state. */
  public read(): WorkerLifecycleState {
    if (!existsSync(this.path)) {
      return { formatVersion: 1, readiness: "accepting", updatedAt: now() };
    }
    return validateWorkerLifecycle(readJson(this.path));
  }

  /** Durably and idempotently revoke new task and message admission. */
  public beginDrain(): WorkerLifecycleState {
    const current = this.read();
    if (current.readiness !== "accepting") {
      return current;
    }
    const acceptedAt = now();
    const next: WorkerLifecycleState = {
      formatVersion: 1,
      readiness: "draining",
      updatedAt: acceptedAt,
      drainAcceptedAt: acceptedAt,
    };
    atomicWrite(this.path, next);
    return next;
  }

  /** Durably mark drain settlement after resident work becomes quiescent. */
  public finishDrain(): WorkerLifecycleState {
    const current = this.read();
    if (current.readiness === "accepting" || current.readiness === "drained") {
      return current;
    }
    const drainedAt = now();
    const next: WorkerLifecycleState = {
      ...current,
      readiness: "drained",
      updatedAt: drainedAt,
      drainedAt,
    };
    atomicWrite(this.path, next);
    return next;
  }
}
