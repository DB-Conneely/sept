import { context, trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Logger } from "pino";
import type { TelemetryIdentity } from "./configuration.js";
import type { LogLevel, SafeTelemetryFields } from "./contract.js";
import { boundedString, logFields } from "./safe-fields.js";

export class JsonLogger {
  private readonly logger?: Logger;
  private readonly destination?: DestinationStream & { flushSync?: () => void; on?: (name: string, listener: () => void) => void };

  constructor(identity: TelemetryIdentity, env: NodeJS.ProcessEnv, destination?: DestinationStream, enabled = true) {
    if (!enabled) return;
    this.destination = (destination ?? pino.destination({ dest: 2, sync: false, minLength: 4096, maxLength: 1024 * 1024 })) as typeof this.destination;
    this.destination?.on?.("error", () => undefined);
    const configuredLevel = boundedString(env.SEPT_LOG_LEVEL, "info", 16);
    const level = (["silent", "fatal", "error", "warn", "info", "debug", "trace"] as string[]).includes(configuredLevel) ? configuredLevel : "info";
    this.logger = pino({
      level,
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
        paths: ["authorization", "token", "headers", "payload", "prompt", "text", "path", "sessionFile", "session_file", "toolArguments", "toolOutput"],
        censor: "[REDACTED]",
      },
    }, this.destination);
  }

  write(lifecycle: string, fields: SafeTelemetryFields = {}, level: LogLevel = "info"): void {
    if (!this.logger) return;
    try {
      const active = trace.getSpan(context.active())?.spanContext();
      const correlation = active?.traceId && active.spanId ? { trace_id: active.traceId, span_id: active.spanId } : {};
      this.logger[level]({ lifecycle: boundedString(lifecycle, "unknown", 96), ...logFields(fields), ...correlation }, lifecycle);
    } catch {}
  }

  flush(): void {
    try { this.logger?.flush(); this.destination?.flushSync?.(); } catch {}
  }
}
