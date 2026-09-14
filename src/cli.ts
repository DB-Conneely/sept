#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireStateRootLease, listRuns, RunStore, SeptError, type TaskRequest } from "./durable/index.js";
import { SeptService, validateRequest } from "./ingress/index.js";
import { classifyError, createTelemetry, NOOP_TELEMETRY } from "./observability/index.js";
import { getAgentDir, inspectPi } from "./pi-integration/index.js";
import { CycleController } from "./runtime/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>; version: string };
const piVersion = pkg.dependencies["@earendil-works/pi-coding-agent"];

const OPTION_KEYS = {
  worker: ["agent-dir", "host", "port", "state-dir", "workspace-root"],
  run: ["agent-dir", "handover-reserve", "max-epochs", "max-invocations", "model", "provider", "role", "state-dir", "task", "thinking", "threshold", "timeout", "workspace"],
  doctor: ["agent-dir", "provider"],
  health: ["url"],
} as const;

type Command = keyof typeof OPTION_KEYS;

function args(values: string[], allowed: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index++) {
    const argument = values[index];
    if (!argument.startsWith("--")) throw new Error("Unexpected positional argument");
    const key = argument.slice(2);
    if (!allowed.includes(key)) throw new Error(`Unknown option --${key}`);
    if (key in result) throw new Error(`Duplicate option --${key}`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index++;
  }
  return result;
}

function int(value: string | undefined): number | undefined { return value === undefined ? undefined : Number(value); }

let telemetry = NOOP_TELEMETRY;

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !Object.hasOwn(OPTION_KEYS, command)) {
    process.stderr.write("Usage: sept worker|run|doctor|health [options]\n");
    process.exitCode = 2;
    return;
  }
  if (command === "worker" || command === "run") telemetry = createTelemetry({ serviceVersion: pkg.version, command });
  process.title = `SEPT ${command}`;
  const options = args(process.argv.slice(3), OPTION_KEYS[command]);
  const agentDir = resolve(options["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir());

  if (command === "worker") {
    const stateRoot = resolve(options["state-dir"] ?? process.env.SEPT_STATE_DIR ?? join(process.cwd(), ".sept", "runs"));
    const workspaceRoot = resolve(options["workspace-root"] ?? process.env.SEPT_WORKSPACE_ROOT ?? process.cwd());
    const service = new SeptService({ stateRoot, agentDir, workspaceRoot, token: process.env.SEPT_TOKEN ?? "", host: options.host, port: int(options.port), piVersion, telemetry });
    const address = await service.start();
    process.stdout.write(`SEPT Pi worker listening on http://${address.host}:${address.port}\n`);
    let stopping: Promise<void> | undefined;
    const stop = (): void => {
      stopping ??= (async () => { await service.stop(); await telemetry.shutdown(); })().catch((error) => {
        telemetry.log("process.failed", { "sept.outcome": "failure", "error.type": classifyError(error) }, "error");
        process.stderr.write(`sept: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (command === "run") {
    const stateRoot = resolve(options["state-dir"] ?? process.env.SEPT_STATE_DIR ?? join(process.cwd(), ".sept", "runs"));
    const releaseRoot = acquireStateRootLease(stateRoot);
    try {
      const resumable = listRuns(stateRoot).filter((store) => store.snapshot().status === "active" || store.snapshot().status === "waiting");
      if (resumable.length) throw new SeptError("single worker slot is busy");
      const request: TaskRequest = {
        task: options.task,
        role: options.role,
        workspace: options.workspace,
        provider: options.provider,
        model: options.model,
        thinking: options.thinking as TaskRequest["thinking"],
        thresholdPercent: int(options.threshold),
        handoverReserveTokens: int(options["handover-reserve"]),
        maxInvocations: int(options["max-invocations"]),
        maxEpochs: int(options["max-epochs"]),
        timeoutSeconds: int(options.timeout),
      };
      const store = telemetry.spanSync("sept.task.create", {}, () => RunStore.create(stateRoot, validateRequest(request, piVersion)));
      telemetry.workerStarted("none", "run");
      telemetry.setWorkerState("busy");
      telemetry.setRunState("active", 1, 0, 0);
      telemetry.log("task.created", { "sept.run.id": store.runId, "sept.run.state": "active", "sept.outcome": "accepted" });
      process.stdout.write(`${store.runId}\n`);
      await new CycleController(store, agentDir, undefined, telemetry).run();
      process.stdout.write(`${JSON.stringify(store.snapshot())}\n`);
    } finally {
      releaseRoot();
      await telemetry.shutdown();
    }
    return;
  }

  if (command === "doctor") {
    const provider = options.provider ?? "openai-codex";
    const diagnostic = await inspectPi(agentDir, provider);
    process.stdout.write(`${JSON.stringify({ node: process.version, sept: pkg.version, piSdk: piVersion, agentDir, ...diagnostic }, null, 2)}\n`);
    return;
  }

  const token = process.env.SEPT_TOKEN ?? "";
  if (!token) throw new Error("SEPT_TOKEN is required for the authenticated health check");
  const url = options.url ?? "http://127.0.0.1:8090/health";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`SEPT worker health check failed (${response.status})`);
  process.stdout.write("SEPT worker healthy\n");
}

await main().catch(async (error) => {
  telemetry.log("process.failed", { "sept.outcome": "failure", "error.type": classifyError(error) }, "error");
  await telemetry.shutdown();
  process.stderr.write(`sept: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
