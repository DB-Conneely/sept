/** Supporting observation-order regression; installed Docker proof separately establishes actual command exit. */
import assert from "node:assert/strict";
import test from "node:test";
import type { HandsAttachment } from "../../src/execution/hands-processes.js";
import type { DockerHandsConfiguration } from "../../src/execution/contracts.js";
import { DockerEngineControl } from "../../src/execution/docker-engine.js";
import { HandsProcessOwner } from "../../src/execution/hands-process-owner.js";
import { suppliedEngine } from "./backend-support.js";

type ObservationOrder = "inspection-before-eof" | "eof-before-inspection" | "lost-stream";

for (const order of ["inspection-before-eof", "eof-before-inspection", "lost-stream"] as const) {
  void test(`Hands command requires post-EOF Engine evidence before declaring loss: ${order}`, async () => {
    const fixture = await suppliedEngine();
    const engine = await DockerEngineControl.open(fixture.path);
    try {
      const owner = await HandsProcessOwner.open(configuration(fixture), engine, {
        pid: 42,
        start: "123",
      });
      const observed = orderInspections(engine, order);
      const result = owner.execute(
        { commandId: 1, program: "rg", argv: [], cwd: "/workspace" },
        {
          network: false,
          signal: new AbortController().signal,
          authorize: () => Promise.resolve(),
        },
        () => Promise.resolve(),
      );
      if (order === "lost-stream") {
        await assert.rejects(result, /Hands command stream closed before its exec joined/);
      } else {
        assert.deepEqual(await result, { code: 0, signal: null, termination: "exit" });
      }
      assert.ok(observed.inspections >= (order === "eof-before-inspection" ? 1 : 2));
    } finally {
      try {
        await engine.close();
      } finally {
        await fixture.close();
      }
    }
  });
}

function configuration(
  fixture: Awaited<ReturnType<typeof suppliedEngine>>,
): DockerHandsConfiguration {
  return {
    profile: "docker-linux-warm-v1",
    engineSocket: fixture.path,
    containerId: "a".repeat(64),
    generation: "original",
    workspace: fixture.root,
    resources: fixture.root,
    dataDomain: "private",
    workspaceLimits: { bytes: 134217728, inodes: 32768 },
    shell: false,
    readOnlyMounts: [],
  };
}

function orderInspections(
  engine: DockerEngineControl,
  order: ObservationOrder,
): { inspections: number } {
  const observed = { inspections: 0 };
  let command: HandsAttachment | undefined;
  const attach = engine.attach.bind(engine);
  engine.attach = async (id, execution) => {
    const attachment = await attach(id, execution);
    if (execution.commandOutput === true) {
      command = attachment;
      if (order === "eof-before-inspection") {
        const end = attachment.end.bind(attachment);
        attachment.end = async (input) => {
          await end(input);
          await attachment.joined;
        };
      }
    }
    return attachment;
  };
  const inspect = engine.inspectExec.bind(engine);
  engine.inspectExec = async (id) => {
    const facts = await inspect(id);
    assert.ok(command);
    assert.equal(id, command.execId);
    observed.inspections += 1;
    if (order !== "eof-before-inspection" && observed.inspections === 1) {
      await command.joined;
      return { ...facts, Running: true, ExitCode: null };
    }
    return order === "lost-stream" ? { ...facts, Running: true, ExitCode: null } : facts;
  };
  return observed;
}
