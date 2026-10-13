/** Assertions for real native tool entries, including successful non-Git find parity. */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { arrayField, parseRecord } from "./cli-support.js";

/** Existing Pi bodies must succeed; task counts alone cannot hide a tool error. */
export function assertNativePiToolResults(database: DatabaseSync): void {
  const results = database
    .prepare("SELECT record FROM entries WHERE json_extract(record, '$.kind') = ?")
    .all("pi.tool-result");
  assert.equal(results.length, 9);
  for (const row of results) {
    assert.ok(typeof row.record === "string");
    const entry = parseRecord(row.record);
    for (const result of arrayField(entry, "model")) {
      const tool = parseRecord(JSON.stringify(result));
      assert.equal(tool.isError, false, String(tool.toolName));
      if (tool.toolName === "find") {
        assert.match(JSON.stringify(tool.content), /fixture\.png/);
      }
    }
  }
}
