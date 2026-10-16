/** HTTP fixture assertions observe complete factory behavior through the authenticated public router. */
import assert from "node:assert/strict";
import type { Worker, WorkerOptions } from "../../src/worker/index.js";
import { arrayField, record, responseRecord } from "./cli-support.js";

/** Return the real bound endpoint of an initialized factory worker. */
export function base(worker: Worker): string {
  return `http://${worker.address.host}:${String(worker.address.port)}`;
}

/** Build authenticated fixture headers without reading ambient credentials. */
export function headers(configuration: WorkerOptions): Record<string, string> {
  return { Authorization: `Bearer ${configuration.token}`, "Content-Type": "application/json" };
}

/** Read the authoritative public task projection for comparison across reopen. */
export async function projection(
  worker: Worker,
  configuration: WorkerOptions,
  runId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base(worker)}/v1/tasks/${runId}`, {
    headers: headers(configuration),
  });
  assert.equal(response.status, 200);
  return responseRecord(response);
}

/** Verify exact acknowledged operator text remains available in retained conversation evidence. */
export async function assertMessageEvidence(
  worker: Worker,
  configuration: WorkerOptions,
  runId: string,
): Promise<void> {
  const response = await fetch(`${base(worker)}/v1/tasks/${runId}/conversation`, {
    headers: headers(configuration),
  });
  assert.equal(response.status, 200);
  const events = arrayField(await responseRecord(response), "events");
  assert.ok(
    events.some((event) => record(event, "event").text === "  later evidence: exact bytes\n"),
  );
}
