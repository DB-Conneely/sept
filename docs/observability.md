# SEPT observability

SEPT emits operational telemetry without changing its durable recovery or audit records. `manifest.json`, `state.json`, `events.jsonl`, operator-message evidence, checkpoints, and handovers remain authoritative and are fsynced in their existing order. Telemetry can be sampled, dropped, unavailable, or retained for a shorter period without affecting execution or recovery.

## Signals and identity

- **Logs:** bounded-field Pino JSON on stderr for container-runtime collection. The public command result remains on stdout; SEPT creates no repository log files. Logs include `service.name`, `service.version`, `service.instance.id`, `sept.worker.id`, `process.pid`, lifecycle, and active trace/span IDs where available.
- **Traces:** OpenTelemetry spans cover worker startup/adoption, authenticated HTTP routing (including drain, cancel, transcript, and stream setup), task/webhook/operator routing, controller and lease ownership, Pi session open/resume/rotation/close, invocations, context/checkpoint/handover events, and terminal outcomes.
- **Metrics:** OpenTelemetry instruments cover worker start/uptime/state, run state/outcomes/current epoch and invocation (including cancelling/cancelled), session opens, Pi invocation count/latency/failure, context pressure, operator queue depth, webhook outcomes, HTTP outcomes, exporter health, and bounded Node memory/CPU/event-loop indicators. Missing provider usage leaves context pressure absent rather than reporting a misleading zero.

`OTEL_SERVICE_NAME` defaults to `sept`. Set the bounded `SEPT_WORKER_ID` to a stable deployment identity such as `review-worker-1`; it defaults to the container hostname. `service.instance.id` is `<worker-id>:<pid>`, identifying one concrete process incarnation. For cardinality and data safety, SEPT accepts only `service.namespace`, `deployment.environment.name`, `container.name`, and `container.id` from standard `OTEL_RESOURCE_ATTRIBUTES`, with each value capped at 128 characters. A deployment can set bounded labels such as:

```text
service.namespace=agent-workers,deployment.environment.name=production,container.name=sept-review-1
```

Do not put credentials, customer data, repository paths, run IDs, session IDs, message IDs, or other unbounded values in the accepted resource attributes. SEPT deliberately omits the standard process detector because its command-argument resource field could expose `--token` values or filesystem paths; bounded process PID and runtime metrics are emitted explicitly instead. Run IDs are present only in selected logs and traces for investigation. Metrics intentionally omit run, session, message, event, and path identifiers; all metric attributes use finite outcome/state/kind sets.

## OTLP configuration

OpenTelemetry export is disabled unless an OTLP endpoint is configured or the corresponding exporter is explicitly selected. Pino JSON logging remains enabled unless `SEPT_LOG_LEVEL=silent` is set.

```bash
export OTEL_SERVICE_NAME=sept
export SEPT_WORKER_ID=review-worker-1
export OTEL_RESOURCE_ATTRIBUTES='service.namespace=agent-workers,deployment.environment.name=production,container.name=sept-review-1'
export OTEL_EXPORTER_OTLP_ENDPOINT='http://alloy.internal:4318'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
```

Signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` are also supported. SEPT wires OTLP over HTTP/protobuf; gRPC and HTTP/JSON exporter selection are not supported in this tranche. The upstream OTLP HTTP/protobuf exporters honor standard endpoint, header, compression, certificate, and timeout variables. Treat `OTEL_EXPORTER_OTLP_HEADERS` as a secret and inject it at runtime; SEPT never logs it. Set `OTEL_SDK_DISABLED=true`, `OTEL_TRACES_EXPORTER=none`, or `OTEL_METRICS_EXPORTER=none` to disable export.

SEPT bounds the trace batch queue to 512 spans, batches to 128, limits span attributes/events, limits metric cardinality to 64 series per instrument, and limits metric export batches to 128. These conventional controls are accepted within hard safety bounds:

- `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`
- `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_TIMEOUT`
- `SEPT_LOG_LEVEL` (`silent`, `fatal`, `error`, `warn`, `info`, `debug`, or `trace`)

Exports are batched and asynchronous, and the Pino destination has a 1 MiB in-process buffer ceiling. Export exceptions are contained; failure logs contain only the signal and outcome and are rate-limited to one per minute. Startup, HTTP work, durable writes, checkpointing, wake, drain, cancellation, and conversation delivery never wait for a collector. Shutdown attempts a short bounded flush. Process stop, durable worker drain, and targeted run cancellation retain distinct semantics.

## Collector topology

A minimal container deployment needs no telemetry sidecar:

1. Each SEPT container sends OTLP/HTTP traces and metrics to a host-level or central OpenTelemetry Collector or Grafana Alloy endpoint.
2. The container runtime or Alloy tails each container's JSON stderr stream. Preserve the Pino fields rather than reparsing free text.
3. The collector/Alloy routes traces to Tempo, metrics to a Prometheus-compatible backend, and logs to Loki. Grafana queries all three using `service.name`, `sept.worker.id`, and `service.instance.id`; trace IDs correlate a log with a trace.

Use TLS and authenticated collector ingress across hosts, bind collector receivers to private networks, and restrict telemetry egress from SEPT containers to the collector. Collector retries and disk queues belong at the collector, not in SEPT. Do not make collector health a SEPT readiness dependency.

Start with short operational retention (for example 7–14 days for traces/logs and 30 days for aggregated metrics), then adjust from measured incident needs and cost. Apply collector-side sampling to routine health traffic, retain failures and slow invocations, cap log ingestion, and alert on dropped exporter data. Durable run evidence follows the separate state retention/backup policy and should not be shipped as telemetry. In the production image it remains under `/state/runs`, backed by the required persistent `/state` volume; OTLP traces/metrics remain collector-bound.

## Data safety

Instrumentation uses an allowlist of bounded operational fields. Inbound W3C `traceparent` and validated `tracestate` are propagated; no other request headers or baggage are extracted. It does not export bearer credentials or headers, webhook bodies, source/event/message IDs, task or operator text, prompts, assistant text, tool arguments/output, session IDs, session-file paths, workspace/state/agent paths, or error messages/stacks. Exact user and validated assistant conversation evidence remains only in the bounded local `conversation.jsonl` and authenticated replay/stream endpoints. Operational telemetry records route templates, status classes, bounded lifecycle states, and outcomes, but never conversation text, SSE payloads, cancellation request bodies, or cursor/message IDs.
