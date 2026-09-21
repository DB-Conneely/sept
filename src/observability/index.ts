/**
 * Defines the observability mechanism's public import boundary. Business mechanisms depend only
 * on this facade and its provider-neutral contract; SDK configuration, exporters, sinks, metrics,
 * and tracing remain internally owned and can never become durable lifecycle authority.
 */

/** Public construction API and shared disabled facade; initialization is fail-open. */
export {
  NOOP_TELEMETRY,
  classifyError,
  createTelemetry,
  type TelemetryOptions,
} from "./telemetry.js";

/** Business-facing advisory contract, kept independent of OpenTelemetry and Pino types. */
export type { Observability } from "./contract.js";
