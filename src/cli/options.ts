/**
 * Parses the installed CLI's argv boundary. It owns command/option syntax only and passes bounded
 * strings toward command composition without interpreting runtime or credential semantics.
 */

import { CliError } from "./errors.js";

const OPTION_KEYS = {
  worker: ["agent-dir", "host", "port", "state-dir", "workspace-root"],
  run: [
    "agent-dir",
    "max-epochs",
    "max-invocations",
    "model",
    "provider",
    "role",
    "state-dir",
    "task",
    "thinking",
    "timeout",
    "workspace",
  ],
  doctor: ["agent-dir", "provider"],
  health: ["url"],
  models: ["agent-dir", "model", "provider"],
  auth: ["agent-dir", "method", "provider"],
} as const;

/** Installed CLI commands accepted before any mechanism is constructed. */
export type CliCommand = keyof typeof OPTION_KEYS;

/** Parsed command syntax; command handlers remain responsible for semantic validation. */
export interface CliInvocation {
  command: CliCommand;
  action?: string;
  options: Record<string, string>;
}

function isCommand(value: string | undefined): value is CliCommand {
  return value !== undefined && Object.hasOwn(OPTION_KEYS, value);
}

function parseOptions(values: string[], allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const argument = values[index];
    if (!argument?.startsWith("--")) {
      throw new CliError("Unexpected positional argument");
    }
    const key = argument.slice(2);
    if (!allowed.includes(key)) {
      throw new CliError(`Unknown option --${key}`);
    }
    if (key in result) {
      throw new CliError(`Duplicate option --${key}`);
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Missing value for --${key}`);
    }
    result[key] = value;
  }
  return result;
}

/** Parse argv without admitting unknown commands, positional values, or duplicate options. */
export function parseCliInvocation(argv: string[]): CliInvocation | undefined {
  const command = argv[2];
  if (!isCommand(command)) {
    return undefined;
  }
  const hasAction = command === "models" || command === "auth";
  const action = hasAction ? argv[3] : undefined;
  const options = parseOptions(argv.slice(hasAction ? 4 : 3), OPTION_KEYS[command]);
  return action === undefined ? { command, options } : { command, action, options };
}
