/** Public barrels must not install Pi process handlers until the caller starts a worker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

void test("root, client and hands imports preserve process ownership and expose only allowed behaviors", () => {
  const script = `
    import assert from "node:assert/strict";
    const capture = () => ({
      title: process.title,
      signals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"].map(name => [name, process.listenerCount(name)]),
    });
    const before = capture();
    for (const [path, names] of [
      ["./dist/src/client/index.js", ["TaskClientError", "createTaskClient"]],
      ["./dist/src/index.js", ["SeptError", "createWorker"]],
      ["./dist/src/hands.js", ["loadHandsConfiguration", "networkFirewall"]],
    ]) {
      const imported = await import(path);
      assert.deepEqual(Object.keys(imported).sort(), names);
      assert.deepEqual(capture(), before);
    }
    const root = await import("./dist/src/index.js");
    const internalWorker = await import("./dist/src/worker/index.js");
    const hands = await import("./dist/src/hands.js");
    const execution = await import("./dist/src/execution/index.js");
    assert.equal(root.createWorker, internalWorker.createWorker);
    assert.equal(hands.loadHandsConfiguration, execution.loadHandsConfiguration);
    assert.equal(hands.networkFirewall, execution.networkFirewall);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.deepEqual({ code: result.status, signal: result.signal }, { code: 0, signal: null });
  assert.equal(result.stderr, "");
});
