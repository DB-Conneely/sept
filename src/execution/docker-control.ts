/** Bounded Docker control transport and exact-generation shutdown, without provisioning. */
import { spawn } from "node:child_process";
import { SeptError } from "../durable/index.js";
import type { DockerHandsConfiguration } from "./contracts.js";
import { HANDS_RESPONSE_BYTES, handsRecord } from "./protocol.js";
import { validateDockerProfile } from "./profile.js";
// env -i excludes a forged marker; the constructor alone can acknowledge kernel protection.
const GUARD_PRELOAD =
  "data:text/javascript," +
  encodeURIComponent("if (process.env.SEPT_HANDS_PROCESS_GUARD !== '1') process.exit(126);");
const GUARDED_ENV = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "PI_OFFLINE=1",
  "LD_PRELOAD=/app/hands-guard.so",
];
const GUARDED_NODE = ["node", "--disable-sigusr1", "--import", GUARD_PRELOAD];

/** Build the exact credential-free hands entry command. */
export function dockerArguments(configuration: DockerHandsConfiguration, cwd: string): string[] {
  return [
    "exec",
    "-i",
    "--workdir",
    cwd,
    configuration.containerId,
    ...GUARDED_ENV,
    ...GUARDED_NODE,
    "/app/dist/src/execution/hands-entry.js",
  ];
}

/** Own one bounded trusted Docker control subprocess and join it before settlement. */
export function runDocker(
  arguments_: string[],
  input = "",
  maximum = HANDS_RESPONSE_BYTES,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      // This is the trusted control client. Executed hands receive env -i, never this environment.
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    let output = "";
    let overflow = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > maximum) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        output += chunk;
      }
    });
    // Diagnostics are intentionally drained, never buffered or exposed as hostile error text.
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", (error: unknown) => {
      clearTimeout(timer);
      reject(new SeptError("Hands control client is unavailable", { cause: error }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow) {
        reject(new SeptError("Hands operation failed or exceeded its transport bound"));
      } else {
        resolvePromise(output);
      }
    });
    child.stdin.end(input);
  });
}

/** Read bounded kernel/namespace facts from the consumer-owned engine. */
export async function inspect(configuration: DockerHandsConfiguration): Promise<unknown> {
  const raw = await runDocker(
    ["inspect", "--format", "{{json .}}", configuration.containerId],
    "",
    256 * 1024,
  );
  const value: unknown = JSON.parse(raw);
  return value;
}

/** Validate kernel profile without acquiring native task authority. */
export async function validateDockerConfiguration(
  configuration: DockerHandsConfiguration,
  brainRoots: readonly string[],
  workspace = configuration.workspace,
): Promise<string> {
  const cwd = validateDockerProfile(
    configuration,
    await inspect(configuration),
    workspace,
    brainRoots,
  );
  const receipt = await runDocker(
    [
      "exec",
      configuration.containerId,
      ...GUARDED_ENV,
      ...GUARDED_NODE,
      "--eval",
      "process.stdout.write(process.env.SEPT_HANDS_PROCESS_GUARD === '1' ? 'protected' : 'refused')",
    ],
    "",
    1024,
  );
  if (receipt !== "protected") {
    throw new SeptError("Hands process control guard is unavailable");
  }
  return cwd;
}
/** Stop and verify only exact persisted authority; never kill a consumer's changed generation. */
export async function revokeDockerBinding(binding: {
  containerId: string;
  generation: string;
}): Promise<void> {
  const inspected = handsRecord(
    await runDocker(
      ["inspect", "--format", "{{json .}}", binding.containerId],
      "",
      256 * 1024,
    ).then((raw): unknown => JSON.parse(raw)),
  );
  const state = handsRecord(inspected.State);
  if (state.Running === true && state.StartedAt !== binding.generation) {
    throw new SeptError("Revocation requires reconciliation of the changed backend generation");
  }
  if (state.Running === true) {
    try {
      await runDocker(["kill", binding.containerId], "", 1024);
    } catch {
      /* A concurrent revoke may win; stopped-state verification still owns success. */
    }
  }
  const stopped = handsRecord(
    await runDocker(["inspect", "--format", "{{json .State}}", binding.containerId], "", 4096).then(
      (raw): unknown => JSON.parse(raw),
    ),
  );
  if (stopped.Running !== false || stopped.Pid !== 0) {
    throw new SeptError("Capability revocation shutdown could not be verified");
  }
}

/** A validated consumer restart replaces the kernel generation; stale authority must not kill it. */
export async function reconcileDockerBinding(
  previous: { containerId: string; generation: string },
  next: { containerId: string; generation: string },
): Promise<void> {
  if (previous.containerId !== next.containerId) {
    return revokeDockerBinding(previous);
  }
  if (previous.generation === next.generation) {
    throw new SeptError("Reconciliation requires a fresh namespace generation");
  }
  const state = handsRecord(
    await runDocker(["inspect", "--format", "{{json .State}}", next.containerId], "", 4096).then(
      (raw): unknown => JSON.parse(raw),
    ),
  );
  if (state.Running !== true || state.StartedAt !== next.generation) {
    throw new SeptError("Fresh consumer namespace generation could not be reconciled");
  }
}
