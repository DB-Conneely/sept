/**
 * Composes validated CLI syntax with SEPT's public mechanism boundaries. Each handler owns one
 * command lifecycle; durable state, credentials, telemetry, Pi sessions, and HTTP remain owned by
 * their respective mechanisms.
 */

import { join, resolve } from "node:path";
import { acquireStateRootLease, RunStore } from "../durable/index.js";
import { SeptService, validateRequest, publicTaskProjection } from "../ingress/index.js";
import { ModelAccessService, type AuthenticationMethod } from "../model-access/index.js";
import { classifyError, type Observability } from "../observability/index.js";
import { assertCompatibleStateRoot, getAgentDir, inspectPi } from "../pi-integration/index.js";
import { CycleController } from "../runtime/index.js";
import { createTerminalAuthInteraction } from "./auth-interaction.js";
import {
  runPermissions,
  initializeCapabilities,
  assertCapabilityAdmission,
  capabilityHostFactory,
} from "./permissions.js";
import { resumePermissionRun, assertLocalRunSlot } from "./permission-decisions.js";
import { CliError } from "./errors.js";
import type { CliInvocation } from "./options.js";

interface CommandContext extends CliInvocation {
  agentDir: string;
  piVersion: string;
  septVersion: string;
  telemetry: Observability;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function integer(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

async function selectModel(
  access: ModelAccessService,
  options: Record<string, string>,
): Promise<void> {
  const provider = options.provider;
  const model = options.model;
  if (provider === undefined || model === undefined) {
    throw new CliError("models select requires --provider and --model");
  }
  writeJson(await access.setPodDefault(provider, model, AbortSignal.timeout(15_000)));
}

async function runModels(context: CommandContext): Promise<void> {
  const access = await ModelAccessService.create(context.agentDir);
  if (context.action === "validate") {
    writeJson(access.validateCustomConfiguration());
  } else if (context.action === "list") {
    writeJson(await access.catalogue(context.options.provider, AbortSignal.timeout(15_000)));
  } else if (context.action === "current") {
    const resolved = access.resolveSelection();
    writeJson(
      await access.preflightSelection(
        resolved.provider,
        resolved.model,
        resolved.source,
        AbortSignal.timeout(15_000),
      ),
    );
  } else if (context.action === "select") {
    await selectModel(access, context.options);
  } else {
    throw new CliError(
      "Usage: sept models list|current|validate|select [--provider <id>] [--model <id>]",
    );
  }
}

function authenticationMethod(value: string | undefined): AuthenticationMethod | undefined {
  if (value === "api-key") {
    return "api_key";
  }
  if (value === "subscription" || value === "oauth") {
    return value;
  }
  return undefined;
}

async function login(
  access: ModelAccessService,
  provider: string,
  methodOption: string | undefined,
): Promise<void> {
  const method = authenticationMethod(methodOption);
  if (method === undefined) {
    throw new CliError("auth login requires --method api-key|subscription|oauth");
  }
  const interaction = createTerminalAuthInteraction();
  try {
    writeJson(await access.login(provider, method, interaction));
  } finally {
    interaction.close();
  }
}

async function runAuth(context: CommandContext): Promise<void> {
  const provider = context.options.provider;
  if (provider === undefined) {
    throw new CliError("auth commands require --provider");
  }
  const access = await ModelAccessService.create(context.agentDir);
  if (context.action === "status") {
    writeJson(await access.authenticationStatus(provider, AbortSignal.timeout(15_000)));
  } else if (context.action === "logout") {
    writeJson(await access.logout(provider, AbortSignal.timeout(15_000)));
  } else if (context.action === "login") {
    await login(access, provider, context.options.method);
  } else {
    throw new CliError(
      "Usage: sept auth status|login|logout --provider <id> [--method api-key|subscription]",
    );
  }
}

function stateRoot(options: Record<string, string>): string {
  return resolve(
    options["state-dir"] ?? process.env.SEPT_STATE_DIR ?? join(process.cwd(), ".sept", "runs"),
  );
}

function registerWorkerStop(service: SeptService, telemetry: Observability): void {
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= (async () => {
      await service.stop();
      await telemetry.shutdown();
    })().catch((error: unknown) => {
      telemetry.log(
        "process.failed",
        { "sept.outcome": "failure", "error.type": classifyError(error) },
        "error",
      );
      process.stderr.write(`sept: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function runWorker(context: CommandContext): Promise<void> {
  const policy = initializeCapabilities(context.options, stateRoot(context.options));
  const workspaceRoot = resolve(
    context.options["workspace-root"] ?? process.env.SEPT_WORKSPACE_ROOT ?? process.cwd(),
  );
  const host = context.options.host;
  const port = integer(context.options.port);
  const service = new SeptService({
    stateRoot: stateRoot(context.options),
    agentDir: context.agentDir,
    workspaceRoot,
    token: process.env.SEPT_TOKEN ?? "",
    hostFactory: capabilityHostFactory(
      stateRoot(context.options),
      context.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
    ),
    capabilityAdmission: () => {
      assertCapabilityAdmission(policy);
    },
    piVersion: context.piVersion,
    telemetry: context.telemetry,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
  });
  const address = await service.start();
  process.stdout.write(
    `SEPT Pi worker listening on http://${address.host}:${String(address.port)}\n`,
  );
  registerWorkerStop(service, context.telemetry);
}

function directRequest(options: Record<string, string>): Record<string, unknown> {
  return {
    task: options.task,
    role: options.role,
    workspace: options.workspace,
    provider: options.provider,
    model: options.model,
    thinking: options.thinking,
    maxInvocations: integer(options["max-invocations"]),
    maxEpochs: integer(options["max-epochs"]),
    timeoutSeconds: integer(options.timeout),
  };
}

async function createDirectRun(context: CommandContext, root: string): Promise<RunStore> {
  const validated = validateRequest(directRequest(context.options), context.piVersion);
  const access = await ModelAccessService.create(context.agentDir);
  const explicit =
    context.options.provider !== undefined && context.options.model !== undefined
      ? { provider: validated.provider, model: validated.model }
      : undefined;
  const resolved = access.resolveSelection(explicit);
  const preflight = await access.preflightSelection(
    resolved.provider,
    resolved.model,
    resolved.source,
    AbortSignal.timeout(15_000),
  );
  return context.telemetry.spanSync("sept.task.create", {}, () =>
    RunStore.create(root, {
      ...validated,
      provider: preflight.selected.provider,
      model: preflight.selected.model,
    }),
  );
}

async function executeDirectRun(context: CommandContext, store: RunStore): Promise<void> {
  context.telemetry.workerStarted("none", "run");
  context.telemetry.setWorkerState("busy");
  const snapshot = store.snapshot();
  context.telemetry.setRunState(
    snapshot.status,
    snapshot.epoch,
    snapshot.invocations,
    store.pendingMessages().length,
  );
  context.telemetry.log(context.options.resume === undefined ? "task.created" : "task.resumed", {
    "sept.run.id": store.runId,
    "sept.run.state": "active",
    "sept.outcome": "accepted",
  });
  process.stdout.write(`${store.runId}\n`);
  await new CycleController(
    store,
    context.agentDir,
    capabilityHostFactory(
      stateRoot(context.options),
      context.options.hands ?? process.env.SEPT_HANDS_CONFIGURATION,
    ),
    context.telemetry,
  ).run();
  process.stdout.write(`${JSON.stringify(publicTaskProjection(store).state)}\n`);
}

async function runDirect(context: CommandContext): Promise<void> {
  const root = stateRoot(context.options);
  assertCompatibleStateRoot(root, context.telemetry);
  assertCapabilityAdmission(initializeCapabilities(context.options, stateRoot(context.options)));
  const releaseRoot = acquireStateRootLease(root);
  try {
    assertLocalRunSlot(root, context.options.resume);
    const resumed = resumePermissionRun(context, root);
    await executeDirectRun(context, resumed ?? (await createDirectRun(context, root)));
  } finally {
    releaseRoot();
    await context.telemetry.shutdown();
  }
}

async function runDoctor(context: CommandContext): Promise<void> {
  const diagnostic = await inspectPi(context.agentDir, context.options.provider ?? "openai-codex");
  writeJson({
    node: process.version,
    sept: context.septVersion,
    piSdk: context.piVersion,
    agentDir: context.agentDir,
    ...diagnostic,
  });
}

async function runHealth(context: CommandContext): Promise<void> {
  const token = process.env.SEPT_TOKEN ?? "";
  if (!token) {
    throw new CliError("SEPT_TOKEN is required for the authenticated health check");
  }
  const url = context.options.url ?? "http://127.0.0.1:8090/health";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new CliError(`SEPT worker health check failed (${String(response.status)})`);
  }
  process.stdout.write("SEPT worker healthy\n");
}

/** Execute one parsed command through public mechanism boundaries without retaining credentials. */
export async function executeCommand(context: CommandContext): Promise<void> {
  switch (context.command) {
    case "permissions":
      writeJson(await runPermissions(context, stateRoot(context.options), context.agentDir));
      return;
    case "models":
      return runModels(context);
    case "auth":
      return runAuth(context);
    case "worker":
      return runWorker(context);
    case "run":
      return runDirect(context);
    case "doctor":
      return runDoctor(context);
    case "health":
      return runHealth(context);
  }
}

/** Resolve the Pi agent directory only after argv syntax has been accepted. */
export function resolveAgentDirectory(options: Record<string, string>): string {
  return resolve(options["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? getAgentDir());
}
