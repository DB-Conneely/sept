// Copied outside the checkout before execution: every bare import resolves the installed tarball.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, SeptError } from "sept-agent";
import { createTaskClient, TaskClientError } from "sept-agent/client";
import { loadHandsConfiguration, networkFirewall } from "sept-agent/hands";

// Resolve from SEPT's installed entry so consumer hoisting cannot conceal an unsafe Pi edge.
const septRequire = createRequire(fileURLToPath(import.meta.resolve("sept-agent")));
const piManifestPath = septRequire.resolve
  .paths("@earendil-works/pi-coding-agent")
  .map((path) => join(path, "@earendil-works/pi-coding-agent/package.json"))
  .find((path) => existsSync(path));
assert.ok(piManifestPath);
const piManifest = JSON.parse(readFileSync(piManifestPath, "utf8"));
const undiciPath = createRequire(piManifestPath).resolve("undici/package.json");
assert.equal(piManifest.version, "1.1.0");
assert.equal(piManifest.dependencies.undici, "8.12.2");
assert.equal(JSON.parse(readFileSync(undiciPath, "utf8")).version, "8.12.2");
const durablePath = septRequire.resolve("@earendil-works/pi-durable/package.json");
assert.equal(
  createRequire(durablePath).resolve("@earendil-works/chord/package.json"),
  septRequire.resolve("@earendil-works/chord/package.json"),
);

const token = process.env.SEPT_TOKEN;
assert.ok(token);
assert.equal(typeof loadHandsConfiguration, "function");
assert.equal(typeof networkFirewall, "function");
assert.ok(new SeptError("ci") instanceof Error);
await assert.rejects(import("sept-agent/dist/src/index.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});

async function probe(baseUrl) {
  const health = await fetch(`${baseUrl}/health`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(health.status, 200);
  const result = await health.json();
  assert.equal(result.status, "ok");
  assert.equal(result.worker, "idle");
  const unauthorized = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(unauthorized.status, 401);
  const client = createTaskClient({ baseUrl, token, timeoutMs: 10_000 });
  await assert.rejects(
    client.getTask("missing-run"),
    (error) => error instanceof TaskClientError && error.status === 404,
  );
}

if (process.argv[2]) {
  await probe(process.argv[2]);
} else {
  const roots = Object.fromEntries(
    ["stateRoot", "agentDir", "workspaceRoot"].map((key) => {
      const path = resolve(key);
      mkdirSync(path, { mode: 0o700 });
      return [key, path];
    }),
  );
  const worker = await createWorker({ ...roots, token, host: "127.0.0.1", port: 0 });
  try {
    await probe(`http://${worker.address.host}:${worker.address.port}`);
  } finally {
    await worker.stop();
  }
}
console.log(
  JSON.stringify({
    passed: true,
    pi: { manifest: piManifestPath, version: piManifest.version, undici: undiciPath },
    entries: Object.fromEntries(
      ["sept-agent", "sept-agent/client", "sept-agent/hands"].map((name) => [
        name,
        import.meta.resolve(name),
      ]),
    ),
  }),
);
