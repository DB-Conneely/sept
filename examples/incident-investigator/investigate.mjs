import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskClient } from "sept-agent/client";

function required(name) {
  const value = process.env[name];
  assert.ok(value, `Set ${name} explicitly`);
  return value;
}

const phase = process.argv[2];
assert.ok(phase === "wait" || phase === "report", "Use: node investigate.mjs wait|report");
const client = createTaskClient({
  baseUrl: required("SEPT_BASE_URL"),
  token: required("SEPT_TOKEN"),
  timeoutMs: 10_000,
});
const eventId = required("SEPT_EVENT_ID");
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
const request = { signal: controller.signal };
const evidence =
  "E1 [2026-10-16T09:00:00Z]: redacted service error rate increased from baseline; customer identifiers removed.";
const laterEvidence =
  "  E2 [2026-10-16T09:04:00Z]: redacted deployment audit shows no release during the affected interval.\t\n";
const input = {
  source: "incident-investigator",
  eventId,
  task: {
    task: `Investigate only this bounded inline evidence: ${evidence}
Evidence cutoff: 2026-10-16T09:05:00Z. E2 is missing. Root cause, affected population and recovery are unknown.
Do not use file, shell or network tools. First summarize E1 and enter WAIT for E2. After accepted E2 arrives, finish a short report citing E1 and E2, distinguishing observations from unknowns. Do not remediate.`,
    workspace: required("SEPT_WORKSPACE_ROOT"),
    provider: required("SEPT_PROVIDER"),
    model: required("SEPT_MODEL"),
    thinking: "off",
    maxInvocations: 3,
    maxEpochs: 2,
    timeoutSeconds: 120,
  },
};

async function untilStatus(runId, wanted) {
  // Each phase has a finite 240-read budget; the client does not poll or retry for us.
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const projection = await client.getTask(runId, request);
    if (projection.state.status === wanted) {
      return projection;
    }
    assert.ok(
      ["active", "waiting"].includes(projection.state.status),
      "Unexpected authoritative task status",
    );
    await delay(250, undefined, request);
  }
  throw new Error(`Finite polling budget exhausted before ${wanted}`);
}

async function report(admission) {
  const runId = admission.runId;
  const waiting = await client.getTask(runId, request);
  assert.equal(
    waiting.state.status,
    "waiting",
    "Reopen the preserved WAIT run under fresh authority first",
  );
  const message = { source: input.source, eventId: `${eventId}:E2`, runId, message: laterEvidence };
  const accepted = await client.sendMessage(message, request);
  // A second identical submission demonstrates one stable durable acceptance.
  const duplicate = await client.sendMessage(message, request);
  assert.deepEqual(duplicate, { ...accepted, duplicate: true });
  const final = await untilStatus(runId, "complete");
  assert.deepEqual(final.manifest, waiting.manifest);
  assert.equal(final.state.activeSessionId, waiting.state.activeSessionId);
  const conversation = await client.getConversation(runId, { limit: 250, ...request });
  assert.ok(conversation.events.some((event) => event.text === laterEvidence));
  const text = conversation.events
    .filter((event) => event.type === "message" && event.role === "assistant")
    .at(-1)?.text;
  assert.equal(typeof text, "string");
  assert.match(text, /E1/);
  assert.match(text, /E2/);
  assert.equal(conversation.terminal?.status, "complete");
  console.log(
    JSON.stringify({
      stage: "report",
      admission,
      waiting,
      accepted,
      duplicate,
      final,
      conversation,
    }),
  );
}

let runId;
let settled = false;
try {
  // Both commands replay this exact task identity; its original receipt is not current state.
  const admission = await client.createTask(input, request);
  runId = admission.runId;
  if (phase === "wait") {
    const waiting = await untilStatus(runId, "waiting");
    console.log(JSON.stringify({ stage: "WAIT", admission, waiting }));
  } else {
    await report(admission);
  }
  settled = true;
} finally {
  try {
    if (runId !== undefined && !settled) {
      // Independent bounded cleanup request; cancel may need later reconciliation.
      console.log(JSON.stringify({ stage: "cleanup", result: await client.cancel(runId) }));
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
