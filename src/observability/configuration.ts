import { hostname } from "node:os";
import type { Attributes } from "@opentelemetry/api";
import { detectResources, envDetector, hostDetector, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { TelemetrySignal } from "./contract.js";
import { boundedString, SAFE_RESOURCE_KEYS } from "./safe-fields.js";

export interface TelemetryIdentity {
  serviceName: string;
  serviceVersion: string;
  instanceId: string;
  workerId: string;
  command: string;
}

export function telemetryIdentity(serviceVersion: string, command: string | undefined, env: NodeJS.ProcessEnv): TelemetryIdentity {
  const serviceName = boundedString(env.OTEL_SERVICE_NAME, "sept", 128);
  const workerId = boundedString(env.SEPT_WORKER_ID, hostname(), 128);
  return {
    serviceName,
    serviceVersion,
    instanceId: `${workerId}:${process.pid}`,
    workerId,
    command: boundedString(command, "unknown", 32),
  };
}

export function telemetryResource(identity: TelemetryIdentity): Resource {
  // Do not use processDetector: it exports argv, which may contain --token and filesystem paths.
  const configured = detectResources({ detectors: [envDetector] }).attributes;
  const configuredSafe: Attributes = {};
  for (const key of SAFE_RESOURCE_KEYS) {
    const value = boundedString(configured[key], "", 128);
    if (value) configuredSafe[key] = value;
  }
  const detected = detectResources({ detectors: [hostDetector] }).merge(resourceFromAttributes(configuredSafe));
  return detected.merge(resourceFromAttributes({
    [ATTR_SERVICE_NAME]: identity.serviceName,
    [ATTR_SERVICE_VERSION]: identity.serviceVersion,
    "service.instance.id": identity.instanceId,
    "sept.worker.id": identity.workerId,
    "sept.command": identity.command,
  }));
}

export function exporterSelected(signal: TelemetrySignal, env: NodeJS.ProcessEnv): boolean {
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return false;
  const configured = env[signal === "traces" ? "OTEL_TRACES_EXPORTER" : "OTEL_METRICS_EXPORTER"];
  if (configured !== undefined) {
    const values = configured.split(",").map((value) => value.trim().toLowerCase());
    return values.includes("otlp") && !values.includes("none");
  }
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env[signal === "traces" ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" : "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"]);
}
