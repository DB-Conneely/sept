/**
 * Adapts Pi-owned authentication prompts to this process's terminal. This module owns only
 * bounded display, cancellation, and terminal cleanup; ModelAccess owns credentials and flows.
 */
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { LoginInteraction } from "../model-access/index.js";
import { CliError } from "./errors.js";

function display(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .slice(0, 4096);
}

/** A Pi login interaction whose terminal listeners and streams can be released idempotently. */
export interface TerminalAuthInteraction extends LoginInteraction {
  close(): void;
}

class TerminalPrompter implements TerminalAuthInteraction {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly terminal = process.stdin.isTTY;
  private readonly output: Writable;
  private readonly input: Interface;
  private muted = false;
  private closed = false;

  public constructor() {
    this.signal = this.controller.signal;
    this.output = new Writable({
      write: (chunk: string | Uint8Array, _encoding, callback) => {
        if (!this.muted) {
          process.stderr.write(chunk);
        }
        callback();
      },
    });
    Object.assign(this.output, {
      isTTY: process.stderr.isTTY,
      columns: process.stderr.columns,
    });
    this.input = createInterface({
      input: process.stdin,
      output: this.output,
      terminal: this.terminal,
    });
    process.once("SIGINT", this.cancel);
  }

  private readonly cancel = (): void => {
    this.controller.abort();
  };

  private question(message: string, secret: boolean, promptSignal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = promptSignal
        ? AbortSignal.any([this.controller.signal, promptSignal])
        : this.controller.signal;
      if (signal.aborted) {
        reject(new CliError("Login cancelled"));
        return;
      }
      let settled = false;
      const finish = (error?: Error, answer?: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        if (secret && this.terminal && this.muted) {
          this.muted = false;
          process.stderr.write("\n");
        }
        if (error) {
          reject(error);
        } else {
          resolve(answer ?? "");
        }
      };
      const abort = (): void => {
        finish(new CliError("Login cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (secret && this.terminal) {
        process.stderr.write(`${display(message)}: `);
        this.muted = true;
      }
      this.input.question(secret && this.terminal ? "" : `${display(message)}: `, (answer) => {
        finish(undefined, answer);
      });
    });
  }

  // Pi may retain these callbacks independently of this owner, so receiver binding must survive.
  public readonly prompt = async (
    prompt: Parameters<LoginInteraction["prompt"]>[0],
  ): Promise<string> => {
    if (prompt.type === "select") {
      process.stderr.write(
        `${display(prompt.message)}\n${prompt.options.map((option) => `  ${option.id}: ${display(option.label)}${option.description ? ` — ${display(option.description)}` : ""}`).join("\n")}\n`,
      );
      const selected = await this.question("Selection", false, prompt.signal);
      if (!prompt.options.some((option) => option.id === selected)) {
        throw new CliError("Login selection is invalid");
      }
      return selected;
    }
    return this.question(
      prompt.message,
      prompt.type === "secret" || prompt.type === "manual_code",
      prompt.signal,
    );
  };

  public readonly notify = (event: Parameters<LoginInteraction["notify"]>[0]): void => {
    if (event.type === "auth_url") {
      process.stderr.write(
        `Open this provider authorization URL:\n${display(event.url)}\n${event.instructions ? `${display(event.instructions)}\n` : ""}`,
      );
    } else if (event.type === "device_code") {
      process.stderr.write(
        `Open ${display(event.verificationUri)} and enter code ${display(event.userCode)}.\n`,
      );
    } else if (event.type === "info") {
      process.stderr.write(
        `${display(event.message)}${event.links?.length ? `\n${event.links.map((link) => `${display(link.label ?? "Link")}: ${display(link.url)}`).join("\n")}` : ""}\n`,
      );
    } else {
      process.stderr.write(`${display(event.message)}\n`);
    }
  };

  public readonly close = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    process.removeListener("SIGINT", this.cancel);
    this.controller.abort();
    this.input.close();
    this.muted = false;
  };
}

/** Terminal presentation only; Pi still owns every authentication flow and credential mutation. */
export function createTerminalAuthInteraction(): TerminalAuthInteraction {
  return new TerminalPrompter();
}
