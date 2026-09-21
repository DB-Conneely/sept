/**
 * Owns the safe projection of process/environment configuration into telemetry identity and
 * OpenTelemetry resources. Setup depends on this module, while business mechanisms do not; the
 * projection excludes argv, credentials, paths, and unbounded operator-controlled attributes.
 */

import { hostname } from "node:os";
import type { Attributes } from "@opentelemetry/api";
import {
  detectResources,
  envDetector,
  hostDetector,
  resourceFromAttributes,
  type Resource,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { TelemetrySignal } from "./contract.js";
import { boundedString, SAFE_RESOURCE_KEYS } from "./safe-fields.js";

/**
 * Bounded process identity shared by logs, traces, and metrics.
 * It intentionally contains no filesystem, model, session, request, or credential information.
 */
export interface TelemetryIdentity {
  serviceName: string;
  serviceVersion: string;
  instanceId: string;
  workerId: string;
  command: string;
}

/**
 * Build one process identity from bounded deployment labels and trusted process facts.
 * Missing or malformed operator values fall back safely; paths, arguments, and credentials are
 * never inspected, so this function does not throw for hostile environment strings.
 */
export function telemetryIdentity(
  serviceVersion: string,
  command: string | undefined,
  environment: NodeJS.ProcessEnv,
): TelemetryIdentity {
  const serviceName = boundedString(environment.OTEL_SERVICE_NAME, "sept", 128);
  const workerId = boundedString(environment.SEPT_WORKER_ID, hostname(), 128);
  return {
    serviceName,
    serviceVersion,
    instanceId: `${workerId}:${String(process.pid)}`,
    workerId,
    command: boundedString(command, "unknown", 32),
  };
}

function configuredResourceAttributes(): Attributes {
  const configured = detectResources({ detectors: [envDetector] }).attributes;
  const safe: Attributes = {};
  for (const key of SAFE_RESOURCE_KEYS) {
    const value = boundedString(configured[key], "", 128);
    if (value.length > 0) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Build an OpenTelemetry resource from explicitly allowlisted environment and host identity only.
 * The observability mechanism owns this projection and excludes the process detector because its
 * command-argument attributes could disclose paths or bearer credentials.
 */
export function telemetryResource(identity: TelemetryIdentity): Resource {
  // processDetector is intentionally excluded because argv may contain paths or old secrets.
  const detected = detectResources({ detectors: [hostDetector] }).merge(
    resourceFromAttributes(configuredResourceAttributes()),
  );
  return detected.merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: identity.serviceName,
      [ATTR_SERVICE_VERSION]: identity.serviceVersion,
      "service.instance.id": identity.instanceId,
      "sept.worker.id": identity.workerId,
      "sept.command": identity.command,
    }),
  );
}

function signalExporterVariable(signal: TelemetrySignal): string {
  return signal === "traces" ? "OTEL_TRACES_EXPORTER" : "OTEL_METRICS_EXPORTER";
}

function signalEndpointVariable(signal: TelemetrySignal): string {
  return signal === "traces"
    ? "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
    : "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT";
}

/**
 * Return whether OTLP export is explicitly or conventionally configured for one signal.
 * Explicit `none` and global SDK disablement fail closed; this decision selects SDK construction
 * only and never probes, authenticates, or grants authority to an endpoint.
 */
export function exporterSelected(signal: TelemetrySignal, environment: NodeJS.ProcessEnv): boolean {
  if (environment.OTEL_SDK_DISABLED?.toLowerCase() === "true") {
    return false;
  }
  const configured = environment[signalExporterVariable(signal)];
  if (configured !== undefined) {
    const values = configured.split(",").map((value) => value.trim().toLowerCase());
    return values.includes("otlp") && !values.includes("none");
  }
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT ?? environment[signalEndpointVariable(signal)],
  );
}
