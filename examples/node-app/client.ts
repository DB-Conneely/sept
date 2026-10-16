import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskClient, type TaskClient, type TaskProjection } from "sept-agent/client";

function required(name: string): string {
  const value = process.env[name];
  assert.ok(value, `Set ${name} explicitly`);
  return value;
}

async function completed(client: TaskClient, runId: string): Promise<TaskProjection> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const projection = await client.getTask(runId);
    if (projection.state.status === "complete") {
      return projection;
    }
    assert.ok(["active", "waiting"].includes(projection.state.status), "Task did not complete");
    await delay(250);
  }
  assert.fail("Finite task polling budget exhausted");
}

const client = createTaskClient({
  baseUrl: required("SEPT_BASE_URL"),
  token: required("SEPT_TOKEN"),
  timeoutMs: 10_000,
});
let runId: string | undefined;
let finished = false;
try {
  const admission = await client.createTask({
    source: "node-app",
    eventId: required("SEPT_EVENT_ID"),
    task: {
      task: 'Call write_marker once with text "SEPT_NATIVE_EXAMPLE\n", then confirm the marker was written. Do no other work.',
      workspace: required("SEPT_WORKSPACE_ROOT"),
      provider: required("SEPT_PROVIDER"),
      model: required("SEPT_MODEL"),
      thinking: "off",
      maxInvocations: 3,
      maxEpochs: 2,
      timeoutSeconds: 120,
    },
  });
  runId = admission.runId;
  const projection = await completed(client, runId);
  const conversation = await client.getConversation(runId, { limit: 250 });
  assert.equal(conversation.terminal?.status, "complete");
  finished = true;
  console.log(JSON.stringify({ admission, projection, conversation }));
} finally {
  if (runId !== undefined && !finished) {
    await client.cancel(runId);
  }
}
