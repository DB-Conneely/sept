/** Owns the one cached native SQLite import and its exact, credential-blind experimental notice. */

import { NOOP_TELEMETRY, type Observability } from "../observability/index.js";
import { adaptSqliteNotice } from "../durable/index.js";

type SqliteDriver = typeof import("@earendil-works/pi-durable/storage/sqlite/node");
// Native ESM import is process-wide; one shared promise prevents overlapping warning adapters.
let sqliteImport: Promise<SqliteDriver> | undefined;

export { loadNativeSqliteReader } from "../durable/index.js";

async function importSqlite(telemetry: Observability): Promise<SqliteDriver> {
  const restore = adaptSqliteNotice(NOOP_TELEMETRY);
  try {
    const driver = await import("@earendil-works/pi-durable/storage/sqlite/node");
    // The lease mutex may preload SQLite; native initialization still owns one structured notice.
    telemetry.log("pi.sqlite.experimental", { "sept.outcome": "warning" }, "warn");
    return driver;
  } finally {
    restore();
  }
}

/** Load the published driver once, formatting only its exact experimental notice as structured log. */
export function loadNativeSqliteDriver(telemetry: Observability): Promise<SqliteDriver> {
  sqliteImport ??= importSqlite(telemetry);
  return sqliteImport;
}
