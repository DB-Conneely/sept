/**
 * Owns the bounded Pino destination and correlation projection for process JSON logs. Telemetry's
 * facade supplies only candidate safe fields; this module re-applies the allowlist and guarantees
 * that sink failure, buffering, or shutdown flushing cannot alter durable worker behavior.
 */

import { context, trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Logger } from "pino";
import type { TelemetryIdentity } from "./configuration.js";
import type { LogLevel, SafeTelemetryFields } from "./contract.js";
import { boundedString, logFields } from "./safe-fields.js";

type PinoLogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
type FlushableDestination = DestinationStream & {
  flushSync?: () => void;
  on?: (name: string, listener: () => void) => void;
};

const PINO_LEVELS: ReadonlySet<string> = new Set([
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

function isPinoLogLevel(value: string): value is PinoLogLevel {
  return PINO_LEVELS.has(value);
}

function configuredLogLevel(environment: NodeJS.ProcessEnv): PinoLogLevel {
  const configured = boundedString(environment.SEPT_LOG_LEVEL, "info", 16);
  return isPinoLogLevel(configured) ? configured : "info";
}

function defaultDestination(): FlushableDestination {
  // The asynchronous destination is intentionally bounded so collector failure cannot grow memory.
  return pino.destination({
    dest: 2,
    sync: false,
    minLength: 4_096,
    maxLength: 1_024 * 1_024,
  });
}

function loggerOptions(
  identity: TelemetryIdentity,
  environment: NodeJS.ProcessEnv,
): pino.LoggerOptions {
  return {
    level: configuredLogLevel(environment),
    messageKey: "message",
    base: {
      "service.name": identity.serviceName,
      "service.version": identity.serviceVersion,
      "service.instance.id": identity.instanceId,
      "sept.worker.id": identity.workerId,
      "process.pid": process.pid,
      "sept.command": identity.command,
    },
    redact: {
      paths: [
        "authorization",
        "token",
        "headers",
        "payload",
        "prompt",
        "text",
        "path",
        "sessionFile",
        "session_file",
        "toolArguments",
        "toolOutput",
      ],
      censor: "[REDACTED]",
    },
  };
}

function activeCorrelation(): Record<string, string> {
  const active = trace.getSpan(context.active())?.spanContext();
  if (active === undefined) {
    return {};
  }
  return { trace_id: active.traceId, span_id: active.spanId };
}

/**
 * Owns one Pino logger and its optional destination for a telemetry facade.
 * Records contain only bounded allowlisted facts and active trace correlation; logger and sink
 * failures are absorbed because local durable evidence remains authoritative.
 */
export class JsonLogger {
  private readonly logger: Logger | undefined;
  private readonly destination: FlushableDestination | undefined;

  constructor(
    identity: TelemetryIdentity,
    environment: NodeJS.ProcessEnv,
    destination?: DestinationStream,
    enabled = true,
  ) {
    if (!enabled) {
      this.logger = undefined;
      this.destination = undefined;
      return;
    }
    const selectedDestination: FlushableDestination = destination ?? defaultDestination();
    this.destination = selectedDestination;
    // Destination failures are advisory and must not become uncaught worker failures.
    selectedDestination.on?.("error", () => undefined);
    this.logger = pino(loggerOptions(identity, environment), selectedDestination);
  }

  /**
   * Emit one sanitized lifecycle record to the configured process stream.
   * Unapproved fields are discarded, lifecycle text is bounded, and sink failure is contained.
   */
  write(lifecycle: string, fields: SafeTelemetryFields = {}, level: LogLevel = "info"): void {
    if (this.logger === undefined) {
      return;
    }
    try {
      this.logger[level](
        {
          lifecycle: boundedString(lifecycle, "unknown", 96),
          ...logFields(fields),
          ...activeCorrelation(),
        },
        lifecycle,
      );
    } catch {
      // Logging is non-authoritative; durable lifecycle evidence remains the source of truth.
    }
  }

  /**
   * Best-effort flush the owned bounded process destination during shutdown.
   * Flush failure is ignored so process and lease shutdown can continue independently.
   */
  flush(): void {
    try {
      this.logger?.flush();
      this.destination?.flushSync?.();
    } catch {
      // Process shutdown must continue when the external log sink is unavailable.
    }
  }
}
