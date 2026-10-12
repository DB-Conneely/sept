/** Exercises real platform warning delegation and exact restoration around the native import. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { NOOP_TELEMETRY } from "../../src/observability/index.js";
import {
  loadNativeSqliteDriver,
  loadNativeSqliteReader,
} from "../../src/pi-integration/sqlite-driver.js";

await test("loadNativeSqliteDriver shares one import, logs SQLite notice and preserves unrelated warnings", async () => {
  const notices: string[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Compared by identity only, never called unbound.
  const original = process.emitWarning;
  const telemetry = {
    ...NOOP_TELEMETRY,
    log: (name: string): void => {
      notices.push(name);
    },
  };
  const unrelated = new Promise<Error>((resolve) => {
    process.once("warning", resolve);
  });
  const first = loadNativeSqliteDriver(telemetry);
  assert.equal(first, loadNativeSqliteDriver(telemetry));
  assert.equal(process.emitWarning === original, false);
  process.emitWarning("UNRELATED-WARNING-CANARY", {
    type: "SeptFixtureWarning",
    code: "SEPT_FIXTURE_WARNING",
  });
  const warning = await unrelated;
  assert.equal(warning.name, "SeptFixtureWarning");
  assert.equal(warning.message, "UNRELATED-WARNING-CANARY");
  await first;
  assert.equal(process.emitWarning === original, true);
  assert.deepEqual(notices, ["pi.sqlite.experimental"]);
  assert.equal(typeof loadNativeSqliteReader(telemetry).DatabaseSync, "function");
  assert.equal(process.emitWarning === original, true);
});

await test("native SQLite import failure restores the exact warning emitter", () => {
  const driver = pathToFileURL(resolve("dist/src/pi-integration/sqlite-driver.js")).href;
  const telemetry = pathToFileURL(resolve("dist/src/observability/index.js")).href;
  const script = `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { loadNativeSqliteDriver } from ${JSON.stringify(driver)};
import { NOOP_TELEMETRY } from ${JSON.stringify(telemetry)};
class FixtureError extends Error {}
const original = process.emitWarning;
registerHooks({ resolve(specifier, context, next) { if (specifier === "@earendil-works/pi-durable/storage/sqlite/node") throw new FixtureError("fixture import unavailable"); return next(specifier, context); } });
await assert.rejects(loadNativeSqliteDriver(NOOP_TELEMETRY), FixtureError);
assert.equal(process.emitWarning, original);
process.stdout.write("restoration verified\\n");`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.signal, null);
  assert.match(child.stdout, /restoration verified/);
});
