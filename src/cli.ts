#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireStateRootLease, listRuns, RunStore, SeptError, WorkerLifecycleStore, type TaskRequest } from "./durable/index.js";
import { SeptService, validateRequest } from "./ingress/index.js";
import { classifyError, createTelemetry, NOOP_TELEMETRY } from "./observability/index.js";
import { getAgentDir, inspectPi, PiModelAccess, readModelSelection, validateModelsConfiguration, type LoginInteraction } from "./pi-integration/index.js";
import { CycleController } from "./runtime/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>; version: string };
const piVersion = pkg.dependencies["@earendil-works/pi-coding-agent"];

const OPTION_KEYS = {
  worker: ["agent-dir", "host", "port", "state-dir", "workspace-root"],
  run: ["agent-dir", "max-epochs", "max-invocations", "model", "provider", "role", "state-dir", "task", "thinking", "timeout", "workspace"],
  doctor: ["agent-dir", "provider"],
  health: ["url"],
  models: ["agent-dir", "model", "provider"],
  auth: ["agent-dir", "method", "provider"],
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

function cleanDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\bBearer\s+\S+/gi, "[redacted]").slice(0, 2048);
}

function terminalInteraction(): LoginInteraction & { close(): void } {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } }) as Writable & { isTTY?: boolean; columns?: number };
  output.isTTY = process.stdout.isTTY;
  output.columns = process.stdout.columns;
  const input = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  const question = (message: string, secret: boolean, signal?: AbortSignal): Promise<string> => new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new Error("Login cancelled"));
    const abort = (): void => { input.close(); reject(new Error("Login cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    if (secret && process.stdin.isTTY) { process.stdout.write(`${cleanDisplay(message)}: `); muted = true; }
    input.question(secret && process.stdin.isTTY ? "" : `${cleanDisplay(message)}: `, { signal }, (answer) => {
      signal?.removeEventListener("abort", abort);
      if (secret && process.stdin.isTTY) { muted = false; process.stdout.write("\n"); }
      resolvePromise(answer);
    });
  });
  return {
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        process.stdout.write(`${cleanDisplay(prompt.message)}\n${prompt.options.map((option) => `  ${option.id}: ${cleanDisplay(option.label)}${option.description ? ` — ${cleanDisplay(option.description)}` : ""}`).join("\n")}\n`);
        const selected = await question("Selection", false, prompt.signal);
        if (!prompt.options.some((option) => option.id === selected)) throw new Error("Login selection is invalid");
        return selected;
      }
      return question(prompt.message, prompt.type === "secret" || prompt.type === "manual_code", prompt.signal);
    },
    notify: (event) => {
      if (event.type === "auth_url") process.stdout.write(`Open this provider authorization URL:\n${cleanDisplay(event.url)}\n${event.instructions ? `${cleanDisplay(event.instructions)}\n` : ""}`);
      else if (event.type === "device_code") process.stdout.write(`Open ${cleanDisplay(event.verificationUri)} and enter code ${cleanDisplay(event.userCode)}.\n`);
      else if (event.type === "info") process.stdout.write(`${cleanDisplay(event.message)}${event.links?.length ? `\n${event.links.map((link) => `${cleanDisplay(link.label ?? "Link")}: ${cleanDisplay(link.url)}`).join("\n")}` : ""}\n`);
      else process.stdout.write(`${cleanDisplay(event.message)}\n`);
    },
    close: () => input.close(),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;
  if (!command || !Object.hasOwn(OPTION_KEYS, command)) {
    process.stderr.write("Usage: sept worker|run|doctor|health|models|auth [action] [options]\n");
    process.exitCode = 2;
    return;
  }
  if (command === "worker" || command === "run") telemetry = createTelemetry({ serviceVersion: pkg.version, command });
  process.title = `SEPT ${command}`;
  const action = command === "models" || command === "auth" ? process.argv[3] : undefined;
  const options = args(process.argv.slice(command === "models" || command === "auth" ? 4 : 3), OPTION_KEYS[command]);
  const agentDir = resolve(options["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir());

  if (command === "models") {
    if (action === "validate") {
      process.stdout.write(`${JSON.stringify(validateModelsConfiguration(agentDir), null, 2)}\n`);
      return;
    }
    const access = await PiModelAccess.create(agentDir);
    if (action === "list") {
      process.stdout.write(`${JSON.stringify(await access.catalogue(options.provider), null, 2)}\n`);
      return;
    }
    if (action === "select") {
      if (!options.provider || !options.model) throw new Error("models select requires --provider and --model");
      process.stdout.write(`${JSON.stringify(await access.select(options.provider, options.model), null, 2)}\n`);
      return;
    }
    throw new Error("Usage: sept models list|validate|select [--provider <id>] [--model <id>]");
  }

  if (command === "auth") {
    if (!options.provider) throw new Error("auth commands require --provider");
    const access = await PiModelAccess.create(agentDir);
    if (action === "status") {
      process.stdout.write(`${JSON.stringify(await access.authStatus(options.provider, true, AbortSignal.timeout(15_000)), null, 2)}\n`);
      return;
    }
    if (action === "logout") {
      process.stdout.write(`${JSON.stringify(await access.logout(options.provider, AbortSignal.timeout(15_000)), null, 2)}\n`);
      return;
    }
    if (action === "login") {
      const method = options.method === "api-key" ? "api_key" : options.method === "subscription" || options.method === "oauth" ? "oauth" : undefined;
      if (!method) throw new Error("auth login requires --method api-key|subscription");
      const interaction = terminalInteraction();
      try { process.stdout.write(`${JSON.stringify(await access.login(options.provider, method, interaction), null, 2)}\n`); }
      finally { interaction.close(); }
      return;
    }
    throw new Error("Usage: sept auth status|login|logout --provider <id> [--method api-key|subscription]");
  }

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
      if (new WorkerLifecycleStore(stateRoot).read().readiness !== "accepting") throw new SeptError("worker state root is drained and not accepting new work");
      const resumable = listRuns(stateRoot).filter((store) => store.snapshot().status === "active" || store.snapshot().status === "waiting" || store.snapshot().status === "cancelling");
      if (resumable.length) throw new SeptError("single worker slot is busy");
      const request: TaskRequest = {
        task: options.task,
        role: options.role,
        workspace: options.workspace,
        provider: options.provider,
        model: options.model,
        thinking: options.thinking as TaskRequest["thinking"],
        maxInvocations: int(options["max-invocations"]),
        maxEpochs: int(options["max-epochs"]),
        timeoutSeconds: int(options.timeout),
      };
      const store = telemetry.spanSync("sept.task.create", {}, () => RunStore.create(stateRoot, validateRequest(request, piVersion, undefined, readModelSelection(agentDir))));
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
