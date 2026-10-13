/** Owns canonical SQLite loading and the exact platform notice shared by durable callers. */

import type { Observability } from "../observability/index.js";

type WarningConstructor = NonNullable<NodeJS.EmitWarningOptions["ctor"]>;
type WarningOptions = string | WarningConstructor | NodeJS.EmitWarningOptions;

function forwardWarning(
  emit: NodeJS.Process["emitWarning"],
  warning: string | Error,
  type: WarningOptions | undefined,
  code: string | WarningConstructor | undefined,
  ctor: WarningConstructor | undefined,
): void {
  if (typeof type === "string") {
    if (typeof code === "function") {
      emit(warning, type, code);
    } else {
      emit(warning, type, code, ctor);
    }
  } else if (typeof type === "function") {
    emit(warning, type);
  } else {
    emit(warning, type);
  }
}

function sqliteNotice(warning: string | Error, type: WarningOptions | undefined): boolean {
  let name: string | undefined;
  if (typeof type === "string") {
    name = type;
  } else if (warning instanceof Error) {
    name = warning.name;
  }
  const message = typeof warning === "string" ? warning : warning.message;
  // Node supplies no SQLite warning code; exact message/type matching leaves every other warning intact.
  return (
    name === "ExperimentalWarning" &&
    message === "SQLite is an experimental feature and might change at any time"
  );
}

/** Adapt only Node’s exact SQLite notice; the caller must restore after its synchronous or awaited load. */
export function adaptSqliteNotice(telemetry: Observability): () => void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Saved only for exact restoration; forwarding uses the bound emitter.
  const original = process.emitWarning;
  const emit = original.bind(process);
  process.emitWarning = (
    warning: string | Error,
    type?: WarningOptions,
    code?: string | WarningConstructor,
    ctor?: WarningConstructor,
  ): void => {
    if (sqliteNotice(warning, type)) {
      telemetry.log("pi.sqlite.experimental", { "sept.outcome": "warning" }, "warn");
      return;
    }
    forwardWarning(emit, warning, type, code, ctor);
  };
  return () => {
    process.emitWarning = original;
  };
}

/** Load Node's canonical SQLite constructor; callers choose read-only or writable access. */
export function loadNativeSqliteReader(
  telemetry: Observability,
): Pick<typeof import("node:sqlite"), "DatabaseSync"> {
  const restore = adaptSqliteNotice(telemetry);
  try {
    const native: unknown = process.getBuiltinModule("node:sqlite");
    // CAST: This is Node's canonical builtin module, not provider or durable input.
    return native as Pick<typeof import("node:sqlite"), "DatabaseSync">;
  } finally {
    restore();
  }
}
