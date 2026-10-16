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
import type { DurableHandover, OperatorMessage } from "../../src/durable/index.js";
import { operatorBlock } from "../../src/pi-integration/prompts.js";
import { sessionMessageText } from "../../src/pi-integration/message-text.js";
import {
  readDurableLocator,
  writeDurableLocator,
} from "../../src/pi-integration/durable-session-files.js";
import { fixtureDirectories, fixtureStore } from "./support.js";

await test("inspectPi returns credential-blind status from an isolated installed Pi directory", async () => {
  const directories = fixtureDirectories("sept-pi-diagnostics-");
  const result = await inspectPi(directories.agentDir, "anthropic");
  assert.equal(result.provider, "anthropic");
  assert.equal(result.authenticated, false);
  assert.equal(result.subscription, false);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

function promptHandover(runId: string, messages: OperatorMessage[]): DurableHandover {
  return {
    formatVersion: 1 as const,
    runId,
    epoch: 1,
    predecessorSessionId: "predecessor",
    predecessorSessionFile: "/private/brain/state/pi-sessions/2.durable.json",
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
}

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
  const handover = promptHandover(manifest.runId, messages);
  assert.match(initialPrompt(manifest, "recovered context"), /standing task/);
  assert.match(initialPrompt(manifest), /durable Pi-backed task worker/);
  for (const prompt of [
    initialPrompt(manifest),
    continuationPrompt(control, messages),
    successorPrompt(manifest, handover, messages),
  ]) {
    assert.match(prompt, /fully accomplished and verified/);
  }
  assert.match(continuationPrompt(control, messages), /exact operator text/);
  assert.match(successorPrompt(manifest, handover, messages), /Full durable predecessor handover/);
  assert.match(successorPrompt(manifest, handover, messages), /<pi-session>\/2\.durable\.json/);
  assert.doesNotMatch(successorPrompt(manifest, handover, messages), /\/private\/brain/);
  assert.equal(handover.predecessorSessionFile, "/private/brain/state/pi-sessions/2.durable.json");
  assert.equal(operatorBlock([]), "");
  assert.match(operatorBlock(messages), /message-1/);
});

await test("sessionMessageText projects text without tool, reasoning or image blocks", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "predecessor progress" }] },
    { role: "user", content: [{ type: "text", text: "SEPT_CONTEXT_ROTATION" }] },
    { role: "assistant", content: [{ type: "text", text: "handover" }], stopReason: "stop" },
  ];
  assert.equal(sessionMessageText(messages[0]), "predecessor progress");
  assert.equal(
    sessionMessageText({
      content: [
        { type: "thinking", thinking: "private" },
        { type: "image", data: "private" },
        { type: "text", text: "public" },
      ],
    }),
    "public",
  );
  assert.equal(sessionMessageText(undefined), "");
});

function exerciseNativeLocators(): void {
  const directories = fixtureDirectories("sept-pi-successor-");
  const sessionDir = join(directories.root, "sessions");
  mkdirSync(sessionDir);
  const predecessor = join(sessionDir, "1.durable.json");
  writeFileSync(
    predecessor,
    JSON.stringify({ formatVersion: 1, engine: "pi-durable", conversationId: 1 }),
  );
  writeFileSync(
    join(sessionDir, "2.durable.json"),
    JSON.stringify({
      formatVersion: 1,
      engine: "pi-durable",
      conversationId: 2,
      parentSession: predecessor,
    }),
  );
  const locator = readDurableLocator(predecessor);
  assert.equal(writeDurableLocator(sessionDir, locator.conversationId), predecessor);
  assert.equal(findSuccessorSession(sessionDir, predecessor), join(sessionDir, "2.durable.json"));
  rejectInvalidNativeLocators(sessionDir, predecessor);
  assert.equal(findSuccessorSession(join(directories.root, "missing"), predecessor), undefined);
}

function rejectInvalidNativeLocators(sessionDir: string, predecessor: string): void {
  writeFileSync(
    join(sessionDir, "3.durable.json"),
    JSON.stringify({
      formatVersion: 1,
      engine: "pi-durable",
      conversationId: 3,
      parentSession: predecessor,
    }),
  );
  assert.throws(() => findSuccessorSession(sessionDir, predecessor), /ambiguous/);
  writeFileSync(
    join(sessionDir, "3.durable.json"),
    JSON.stringify({ formatVersion: 1, engine: "pi-durable", conversationId: 1.5 }),
  );
  assert.throws(
    () => readDurableLocator(join(sessionDir, "3.durable.json")),
    /identity is invalid/,
  );
  writeFileSync(join(sessionDir, "legacy.jsonl"), JSON.stringify({ type: "session" }));
  assert.throws(
    () => readDurableLocator(join(sessionDir, "legacy.jsonl")),
    /unknown fields|legacy/,
  );
}

await test(
  "native locators reject legacy/fractional IDs and successor discovery rejects ambiguity",
  exerciseNativeLocators,
);
