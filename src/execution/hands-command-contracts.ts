/** Closed actual-process types; identity/environment/network/budgets are exclusively parent-owned. */
/** Resident supplies exact bytes only; executable, identity, environment, network and limits are parent-owned. */
export interface HandsCommandStart {
  commandId: number;
  program: "bash" | "custom";
  command: string;
  input: string;
  cwd: string;
}
/** Exit is sent only after exact namespace descendants and the command attachment joined. */
export interface HandsCommandExit {
  code: number | null;
  signal: string | null;
  termination: "exit" | "timeout" | "aborted" | "overflow";
}
/** One serial parent's actual process seam; callback bytes are data, never control or authority. */
export type HandsCommandHandler = (
  command: HandsCommandStart,
  output: (text: string) => Promise<void>,
  signal: AbortSignal,
) => Promise<HandsCommandExit>;
/** Native resident body requests one actual process and keeps formatting/output accumulation locally. */
export type HandsCommandExecutor = (
  command: Omit<HandsCommandStart, "commandId">,
  onData: (data: Buffer) => void,
  signal?: AbortSignal,
) => Promise<HandsCommandExit>;
