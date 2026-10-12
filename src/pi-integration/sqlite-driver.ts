/** Owns the one cached native SQLite import and its exact, credential-blind experimental notice. */

import type { Observability } from "../observability/index.js";

type SqliteDriver = typeof import("@earendil-works/pi-durable/storage/sqlite/node");
type WarningConstructor = NonNullable<NodeJS.EmitWarningOptions["ctor"]>;
type WarningOptions = string | WarningConstructor | NodeJS.EmitWarningOptions;

// Native ESM import is process-wide; one shared promise prevents overlapping warning adapters.
let sqliteImport: Promise<SqliteDriver> | undefined;

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

function adaptSqliteNotice(telemetry: Observability): () => void {
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

async function importSqlite(telemetry: Observability): Promise<SqliteDriver> {
  const restore = adaptSqliteNotice(telemetry);
  try {
    return await import("@earendil-works/pi-durable/storage/sqlite/node");
  } finally {
    restore();
  }
}

/** Load Node's canonical read-only database constructor through the same exact notice adapter. */
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

/** Load the published driver once, formatting only its exact experimental notice as structured log. */
export function loadNativeSqliteDriver(telemetry: Observability): Promise<SqliteDriver> {
  sqliteImport ??= importSqlite(telemetry);
  return sqliteImport;
}
