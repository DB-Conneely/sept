/** Synthetic installed native resource fixtures; production owns HTTP, tools, persistence and output. */

import assert from "node:assert/strict";
import { supplyHands } from "./hands-support.js";
import { assertNativePiToolResults } from "./pi-durable-assertions.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  closeServer,
  listen,
  openAiReply,
  parseRecord,
  prepareDirectories,
  waitForExit,
  writeProvider,
} from "./cli-support.js";

/** Only this validated public field may reach the operator conversation. */
export const NATIVE_COMPLETE = JSON.stringify({
  message: "Native resources and tools verified.",
  control: {
    status: "complete",
    summary: "verified",
    verification: ["native task results"],
    next_action: "",
  },
});

/** Synthetic provider plus generated resources, retained until the test owner closes it. */
export interface NativeResourceFixture {
  agent: string;
  state: string;
  workspace: string;
  provider: Server;
  requests: Record<string, unknown>[];
  failures: unknown[];
  close(): Promise<void>;
}

function trustedExtension(agent: string): void {
  mkdirSync(join(agent, "custom"));
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({ extensions: ["custom/native.mjs"] }),
  );
  writeFileSync(
    join(agent, "custom", "native.mjs"),
    `import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const { defineTask } = await import(pathToFileURL(resolve("node_modules/@earendil-works/pi-durable/dist/index.js")).href);
const task = defineTask({ name: "trusted.marker", version: 1, initial: () => ({ phase: "run" }), phases: { run: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "TRUSTED-NATIVE-TASK-MARKER" } }), context); } }, abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context); } });
export const extension = {
  name: "trusted-fixture",
  tasks: [task],
  tools: [{ name: "trusted_fixture", description: "Write a harmless native tool marker", parameters: { type: "object", properties: {}, additionalProperties: false }, replay: "unsafe",
    async execute(_args, api, context) { const child = await api.createTask(task, {}, { ownership: { kind: "task", taskId: api.taskId } }, context); const receipt = await api.waitForTask(child, context); await api.env.writeFile("trusted.txt", "TRUSTED-TOOL-MARKER", context); return { content: [{ type: "text", text: "TRUSTED-TOOL-MARKER " + receipt.state.outcome.result }] }; } }],
  hooks: [{ task: "pi.generation", handlers: { beforeRequest(request) { appendFileSync(new URL("../hook-observed", import.meta.url), "hook\\n"); return { messages: [...request.messages, { role: "user", content: [{ type: "text", text: "TRUSTED-HOOK-MARKER" }], timestamp: Date.now() }] }; } } }]
};
`,
  );
}

function resourceFiles(agent: string, workspace: string): void {
  trustedExtension(agent);
  writeFileSync(join(agent, "SYSTEM.md"), "TRUSTED-SYSTEM-MARKER");
  writeFileSync(join(agent, "APPEND_SYSTEM.md"), "TRUSTED-APPEND-MARKER");
  mkdirSync(join(agent, "skills", "fixture"), { recursive: true });
  writeFileSync(
    join(agent, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: TRUSTED-SKILL-DESCRIPTION\n---\nHarmless skill content.\n",
  );
  writeFileSync(join(workspace, "AGENTS.md"), "PROJECT-AGENTS-MARKER");
  mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(workspace, ".pi", "extensions", "untrusted.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(workspace, "untrusted-executed"))}, "unsafe"); export const extension = { name: "untrusted" };`,
  );
  writeFileSync(
    join(workspace, "fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  writeFileSync(join(workspace, "large.txt"), "RESOURCE-TEXT-MARKER\n".repeat(2500));
}

function toolReply(
  response: ServerResponse,
  calls: { name: string; arguments: Record<string, unknown> }[],
): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `${call.name}-${String(index)}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  response.write(
    `data: ${JSON.stringify({ id: "native-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: toolCalls }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "native-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function nativeReply(call: number, response: ServerResponse): void {
  if (call % 4 === 1) {
    toolReply(response, [
      { name: "read", arguments: { path: "fixture.png" } },
      { name: "read", arguments: { path: "large.txt" } },
      { name: "write", arguments: { path: "artifact.txt", content: "before\n" } },
      { name: "trusted_fixture", arguments: {} },
      { name: "ls", arguments: { path: ".", limit: 10 } },
      { name: "grep", arguments: { pattern: "RESOURCE-TEXT-MARKER", path: "large.txt", limit: 1 } },
      { name: "find", arguments: { pattern: "fixture.png", path: ".", limit: 10 } },
    ]);
  } else if (call % 4 === 2) {
    toolReply(response, [
      { name: "edit", arguments: { path: "artifact.txt", oldText: "before", newText: "after" } },
    ]);
  } else if (call % 4 === 3) {
    toolReply(response, [
      { name: "bash", arguments: { command: "printf 'shell\\n' >> artifact.txt" } },
    ]);
  } else {
    openAiReply(response, NATIVE_COMPLETE);
  }
}

/** Prepare a loopback provider and harmless operator/workspace files for installed-path acceptance. */
export async function nativeResourceFixture(root: string): Promise<NativeResourceFixture> {
  const { agent, state, workspace } = prepareDirectories(root);
  resourceFiles(agent, workspace);
  const requests: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        assert.ok(body.length <= 512 * 1024);
      }
      requests.push(parseRecord(body));
      nativeReply(requests.length, response);
    })().catch((error: unknown) => {
      failures.push(error);
      response.writeHead(500).end();
    });
  });
  writeProvider(agent, await listen(provider), "local-native", { apiKey: "local" });
  enableFixtureImages(agent);
  return {
    agent,
    state,
    workspace,
    provider,
    requests,
    failures,
    close: () => closeServer(provider),
  };
}

function enableFixtureImages(agent: string): void {
  const models = parseRecord(readFileSync(join(agent, "models.json"), "utf8"));
  const providers = parseRecord(JSON.stringify(models.providers));
  const local = parseRecord(JSON.stringify(providers["local-native"]));
  local.models = [
    {
      id: "fixture",
      name: "fixture",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ];
  providers["local-native"] = local;
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers }));
}

function directArguments(fixture: NativeResourceFixture): string[] {
  return [
    "run",
    "--task",
    "Exercise native resources",
    "--role",
    "NATIVE-ROLE-MARKER",
    "--workspace",
    fixture.workspace,
    "--state-dir",
    join(fixture.state, "direct"),
    "--agent-dir",
    fixture.agent,
    "--provider",
    "local-native",
    "--model",
    "fixture",
    "--thinking",
    "off",
  ];
}

/** Await the actual installed direct-run exit before interpreting stdout or durable artifacts. */
export async function nativeDirectRun(fixture: NativeResourceFixture): Promise<string> {
  const hands = supplyHands(fixture.workspace, true);
  const child = spawn(resolve("sept"), [...directArguments(fixture), "--hands", hands.path], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OTEL_SDK_DISABLED: "true",
      SEPT_LOG_LEVEL: "silent",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exit = await waitForExit(child);
  hands.close();
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const runId = stdout.trim().split("\n")[0];
  assert.ok(runId);
  return join(fixture.state, "direct", runId);
}

/** Inspect native SQLite task/entry identity plus real filesystem effects and public output. */
export function assertNativeResources(fixture: NativeResourceFixture, runDir: string): void {
  assert.equal(readFileSync(join(fixture.workspace, "artifact.txt"), "utf8"), "after\nshell\n");
  assert.equal(readFileSync(join(fixture.workspace, "trusted.txt"), "utf8"), "TRUSTED-TOOL-MARKER");
  assert.equal(existsSync(join(fixture.workspace, "untrusted-executed")), false);
  assert.equal(
    readFileSync(join(fixture.agent, "hook-observed"), "utf8").split("hook\n").length - 1,
    fixture.requests.length,
  );
  const serialized = JSON.stringify(fixture.requests);
  for (const marker of [
    "TRUSTED-SYSTEM-MARKER",
    "TRUSTED-APPEND-MARKER",
    "PROJECT-AGENTS-MARKER",
    "TRUSTED-SKILL-DESCRIPTION",
    "TRUSTED-HOOK-MARKER",
    "TRUSTED-TOOL-MARKER",
    "TRUSTED-NATIVE-TASK-MARKER",
    "NATIVE-ROLE-MARKER",
    "data:image/",
    "Showing lines 1-2000",
  ]) {
    assert.ok(serialized.includes(marker), marker);
  }
  assert.deepEqual(fixture.failures, []);
  assertNativeSqlite(runDir);
  assertNativePublicResult(runDir);
}

function assertNativeSqlite(runDir: string): void {
  const database = new DatabaseSync(join(runDir, "pi-durable.sqlite"), { readOnly: true });
  try {
    assertNativeTaskCounts(database);
    assertNativePiToolResults(database);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM documents WHERE json_extract(record, '$.kind') = 'pi.provider'",
        )
        .get()?.count,
      1,
    );
    assert.ok(database.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count);
  } finally {
    database.close();
  }
}

function assertNativeTaskCounts(database: DatabaseSync): void {
  const expected = [
    ["pi.generation", 4],
    ["pi.tool", 9],
    ["trusted.marker", 1],
    ["pi.compaction", 0],
  ] as const;
  const query = database.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE json_extract(record, '$.kind') = ?",
  );
  for (const [kind, count] of expected) {
    assert.equal(query.get(kind)?.count, count, kind);
  }
}

function assertNativePublicResult(runDir: string): void {
  const state = parseRecord(readFileSync(join(runDir, "state.json"), "utf8"));
  assert.equal(state.status, "complete");
  assert.ok(
    readdirSync(join(runDir, "pi-sessions")).every((file) => file.endsWith(".durable.json")),
  );
  const conversation = readFileSync(join(runDir, "conversation.jsonl"), "utf8");
  assert.match(conversation, /Native resources and tools verified/);
  assert.doesNotMatch(conversation, /TRUSTED-TOOL-MARKER|data:image\/|RESOURCE-TEXT-MARKER/);
}
