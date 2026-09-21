import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { LoginInteraction } from "../model-access/index.js";

function display(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .slice(0, 4096);
}

export interface TerminalAuthInteraction extends LoginInteraction {
  close(): void;
}

/** Terminal presentation only; Pi still owns every authentication flow and credential mutation. */
export function createTerminalAuthInteraction(): TerminalAuthInteraction {
  const controller = new AbortController();
  let muted = false;
  let closed = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  output.isTTY = process.stderr.isTTY;
  output.columns = process.stderr.columns;
  const terminal = process.stdin.isTTY === true;
  const input: Interface = createInterface({ input: process.stdin, output, terminal });
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);

  const question = (
    message: string,
    secret: boolean,
    promptSignal?: AbortSignal,
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const signal = promptSignal
        ? AbortSignal.any([controller.signal, promptSignal])
        : controller.signal;
      if (signal.aborted) {
        reject(new Error("Login cancelled"));
        return;
      }
      let settled = false;
      const finish = (error?: Error, answer?: string): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        if (secret && terminal && muted) {
          muted = false;
          process.stderr.write("\n");
        }
        if (error) reject(error);
        else resolve(answer ?? "");
      };
      const abort = (): void => finish(new Error("Login cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (secret && terminal) {
        process.stderr.write(`${display(message)}: `);
        muted = true;
      }
      input.question(secret && terminal ? "" : `${display(message)}: `, (answer) =>
        finish(undefined, answer),
      );
    });

  return {
    signal: controller.signal,
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        process.stderr.write(
          `${display(prompt.message)}\n${prompt.options.map((option) => `  ${option.id}: ${display(option.label)}${option.description ? ` — ${display(option.description)}` : ""}`).join("\n")}\n`,
        );
        const selected = await question("Selection", false, prompt.signal);
        if (!prompt.options.some((option) => option.id === selected))
          throw new Error("Login selection is invalid");
        return selected;
      }
      return question(
        prompt.message,
        prompt.type === "secret" || prompt.type === "manual_code",
        prompt.signal,
      );
    },
    notify: (event) => {
      if (event.type === "auth_url")
        process.stderr.write(
          `Open this provider authorization URL:\n${display(event.url)}\n${event.instructions ? `${display(event.instructions)}\n` : ""}`,
        );
      else if (event.type === "device_code")
        process.stderr.write(
          `Open ${display(event.verificationUri)} and enter code ${display(event.userCode)}.\n`,
        );
      else if (event.type === "info")
        process.stderr.write(
          `${display(event.message)}${event.links?.length ? `\n${event.links.map((link) => `${display(link.label ?? "Link")}: ${display(link.url)}`).join("\n")}` : ""}\n`,
        );
      else process.stderr.write(`${display(event.message)}\n`);
    },
    close: () => {
      if (closed) return;
      closed = true;
      process.removeListener("SIGINT", cancel);
      controller.abort();
      input.close();
      muted = false;
    },
  };
}
