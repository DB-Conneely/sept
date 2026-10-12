/**
 * Covers the smaller exported Pi-boundary contracts that complement end-to-end session tests:
 * credential-blind diagnostics, prompt continuity, native message recovery projection, and bounded
 * successor discovery. Fixtures use isolated directories and never read operator credentials.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  continuationPrompt,
  findSuccessorSession,
  initialPrompt,
  inspectPi,
  successorPrompt,
} from "../../src/pi-integration/index.js";
import { operatorBlock, ROTATION_STEER } from "../../src/pi-integration/prompts.js";
import {
  isFinalAssistantMessage,
  rotationRecovery,
  sessionMessageText,
} from "../../src/pi-integration/session-recovery.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

await test("inspectPi returns credential-blind status from an isolated installed Pi directory", async () => {
  const directories = fixtureDirectories("sept-pi-diagnostics-");
  const result = await inspectPi(directories.agentDir, "anthropic");
  assert.equal(result.provider, "anthropic");
  assert.equal(result.authenticated, false);
  assert.equal(result.subscription, false);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

await test("prompt renderers preserve standing task, control, handover, and exact operator evidence", () => {
  const directories = fixtureDirectories("sept-pi-prompts-");
  const manifest = fixtureStore(directories, "provider", "standing task").manifest();
  const messages = [
    { id: "message-1", text: "exact operator text", createdAt: new Date().toISOString() },
  ];
  const control = {
    status: "continue" as const,
    summary: "continue safely",
    verification: ["checked"],
    next_action: "next seam",
  };
  const handover = {
    formatVersion: 1 as const,
    runId: manifest.runId,
    epoch: 1,
    predecessorSessionId: "predecessor",
    operatorMessages: messages,
    handover: {
      handover_summary: "summary",
      entry_state_and_done: "entry",
      completed: ["done"],
      in_flight: [],
      not_started: [],
      decisions: [],
      rejected_approaches: [],
      verification: [],
      uncertainties: [],
      references: [],
      lessons: [],
      next_action: "continue",
    },
    writtenAt: new Date().toISOString(),
  };
  assert.match(initialPrompt(manifest, "recovered context"), /standing task/);
  assert.match(continuationPrompt(control, messages), /exact operator text/);
  assert.match(successorPrompt(manifest, handover, messages), /Full durable predecessor handover/);
  assert.equal(operatorBlock([]), "");
  assert.match(operatorBlock(messages), /message-1/);
});

await test("sessionMessageText and rotationRecovery recognize one finalized native rotation", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "predecessor progress" }] },
    { role: "user", content: [{ type: "text", text: "SEPT_CONTEXT_ROTATION" }] },
    { role: "assistant", content: [{ type: "text", text: "handover" }], stopReason: "stop" },
  ];
  assert.equal(sessionMessageText(messages[0]), "predecessor progress");
  assert.equal(isFinalAssistantMessage(messages[2]), true);
  assert.equal(isFinalAssistantMessage({ ...messages[2], stopReason: "aborted" }), false);
  const rotationMessages = [
    messages[0],
    { ...messages[1], content: [{ type: "text", text: ROTATION_STEER }] },
    messages[2],
  ];
  const sessionValue: unknown = { messages: rotationMessages };
  // CAST: The recovery helper reads only the validated messages array supplied above.
  const session = sessionValue as Parameters<typeof rotationRecovery>[0];
  const recovery = rotationRecovery(session, true);
  assert.equal(recovery.rotationSteerRecorded, true);
  assert.equal(recovery.preRotationText, "predecessor progress");
});

await test("findSuccessorSession ignores malformed candidates and selects the newest matching child", () => {
  const directories = fixtureDirectories("sept-pi-successor-");
  const sessionDir = join(directories.root, "sessions");
  mkdirSync(sessionDir);
  const predecessor = join(sessionDir, "predecessor.jsonl");
  writeFileSync(
    join(sessionDir, "001.jsonl"),
    `${JSON.stringify({ type: "session", parentSession: predecessor })}\n`,
  );
  writeFileSync(
    join(sessionDir, "002.jsonl"),
    `${JSON.stringify({ type: "session", parentSession: predecessor })}\n`,
  );
  writeFileSync(join(sessionDir, "003.jsonl"), "not-json\n");
  assert.equal(findSuccessorSession(sessionDir, predecessor), join(sessionDir, "002.jsonl"));
  assert.equal(findSuccessorSession(join(directories.root, "missing"), predecessor), undefined);
});
