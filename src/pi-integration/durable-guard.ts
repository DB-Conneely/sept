/** Seals native task admission and signals active invocations when a critical SEPT boundary fails. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { SeptError } from "../durable/index.js";

/** A Harness failure owner; close joins are awaited outside native hooks to avoid self-await deadlock. */
export class DurableGuard {
  private harness: Harness | undefined;
  private failure: unknown;
  private closing: Promise<void> | undefined;

  /** Attach before scheduling; an earlier construction failure seals the same Harness immediately. */
  public bind(harness: Harness): void {
    this.harness = harness;
    if (this.failure !== undefined) {
      this.seal();
    }
  }

  /** Close synchronously signals every active invocation and prevents new task commits/dispatch. */
  public report(error: unknown): void {
    this.failure ??= error;
    this.seal();
  }

  private seal(): void {
    if (this.harness !== undefined && this.closing === undefined) {
      // Harness.close seals Session admission and aborts scheduler signals before returning its join.
      this.closing = this.harness.close(BACKGROUND_CONTEXT).catch((error: unknown) => {
        this.failure ??= error;
      });
    }
  }

  /** Reject before another owned native action when failure has already won the dispatch race. */
  public assertHealthy(): void {
    if (this.failure instanceof SeptError) {
      throw this.failure;
    }
    if (this.failure !== undefined) {
      throw new SeptError("Pi Durable reported an invocation failure", { cause: this.failure });
    }
  }

  /** Join task shutdown after the failing hook has returned, then surface the classified failure. */
  public async settle(): Promise<void> {
    await this.closing;
    this.assertHealthy();
  }
}
