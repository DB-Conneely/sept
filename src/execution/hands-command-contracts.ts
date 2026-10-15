/** Closed actual-process types; identity/environment/network/budgets are exclusively parent-owned. */
/** Resident supplies exact bytes only; executable, identity, environment, network and limits are parent-owned. */
interface HandsScriptCommand {
  commandId: number;
  program: "bash" | "custom";
  command: string;
  input: string;
  cwd: string;
}
interface HandsSearchCommand {
  commandId: number;
  program: "rg" | "fd";
  argv: string[];
  cwd: string;
}
/** Closed native command bytes; helper argv never selects environment, executable, UID or budget. */
export type HandsCommandStart = HandsScriptCommand | HandsSearchCommand;
/** Preserve variant-specific fields when the resident assigns its sole command correlation. */
export type HandsCommandInput =
  | Omit<HandsScriptCommand, "commandId">
  | Omit<HandsSearchCommand, "commandId">;
/** Docker stream identity survives decoding; Bash alone combines decoded chunks in arrival order. */
export type HandsCommandStream = "stdout" | "stderr";
/** Exit is sent only after exact namespace descendants and the command attachment joined. */
export interface HandsCommandExit {
  code: number | null;
  signal: string | null;
  termination: "exit" | "timeout" | "aborted" | "overflow";
}
/** One serial parent's actual process seam; callback bytes are data, never control or authority. */
export type HandsCommandHandler = (
  command: HandsCommandStart,
  output: (text: string, stream: HandsCommandStream) => Promise<void>,
  signal: AbortSignal,
) => Promise<HandsCommandExit>;
/** Native resident body requests one actual process and keeps formatting/output accumulation locally. */
export type HandsCommandExecutor = (
  command: HandsCommandInput,
  onData: (data: Buffer, stream: HandsCommandStream) => void,
  signal?: AbortSignal,
) => Promise<HandsCommandExit>;
