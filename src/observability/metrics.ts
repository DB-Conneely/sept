/**
 * Projects finite SEPT lifecycle outcomes and bounded process gauges into OpenTelemetry metrics.
 * The telemetry facade owns this mutable snapshot, runtime mechanisms only report observations, and
 * no run/session/message identity or durable transition authority is retained by this module.
 */

import { performance } from "node:perf_hooks";
import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type {
  InvocationOutcome,
  ObservedRunState,
  RunOutcome,
  SessionOpenOutcome,
  TelemetrySignal,
  WebhookKind,
  WebhookOutcome,
  WorkerAdoption,
  WorkerMode,
  WorkerState,
} from "./contract.js";

interface RunInstruments {
  workerStarts: Counter;
  runOutcomes: Counter;
  sessionOpens: Counter;
  epochs: Counter;
  invocations: Counter;
  invocationDuration: Histogram;
}

interface RequestInstruments {
  webhook: Counter;
  httpRequests: Counter;
  httpDuration: Histogram;
  exports: Counter;
}

type MetricInstruments = RunInstruments & RequestInstruments;

interface MetricState {
  workerState: WorkerState;
  runState: ObservedRunState;
  epoch: number;
  invocation: number;
  queueDepth: number;
  contextPressure: number | undefined;
}

function createRunInstruments(meter: Meter): RunInstruments {
  return {
    workerStarts: meter.createCounter("sept.worker.starts", {
      description: "Worker process starts",
      unit: "{start}",
    }),
    runOutcomes: meter.createCounter("sept.run.outcomes", {
      description: "Terminal run outcomes",
      unit: "{run}",
    }),
    sessionOpens: meter.createCounter("sept.pi.session.opens", {
      description: "Pi session open and adoption outcomes",
      unit: "{session}",
    }),
    epochs: meter.createCounter("sept.run.epochs", {
      description: "Pi session epochs started or adopted by this process",
      unit: "{epoch}",
    }),
    invocations: meter.createCounter("sept.pi.invocations", {
      description: "Pi invocation outcomes",
      unit: "{invocation}",
    }),
    invocationDuration: meter.createHistogram("sept.pi.invocation.duration", {
      description: "Pi invocation wall time",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3_600],
      },
    }),
  };
}

function createRequestInstruments(meter: Meter): RequestInstruments {
  return {
    webhook: meter.createCounter("sept.webhook.requests", {
      description: "Webhook routing outcomes",
      unit: "{request}",
    }),
    httpRequests: meter.createCounter("sept.http.server.requests", {
      description: "Worker HTTP outcomes",
      unit: "{request}",
    }),
    httpDuration: meter.createHistogram("sept.http.server.duration", {
      description: "Worker HTTP request latency",
      unit: "s",
      advice: {
        explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 30],
      },
    }),
    exports: meter.createCounter("sept.telemetry.exports", {
      description: "Telemetry exporter outcomes",
      unit: "{export}",
    }),
  };
}

function createInstruments(meter: Meter): MetricInstruments {
  return { ...createRunInstruments(meter), ...createRequestInstruments(meter) };
}

function registerLifecycleGauges(meter: Meter, state: MetricState): void {
  meter
    .createObservableGauge("sept.worker.uptime", {
      description: "Worker process uptime",
      unit: "s",
    })
    .addCallback((result) => {
      result.observe(process.uptime());
    });
  meter
    .createObservableGauge("sept.worker.state", {
      description: "Current worker state",
      unit: "1",
    })
    .addCallback((result) => {
      result.observe(1, { "sept.worker.state": state.workerState });
    });
  meter
    .createObservableGauge("sept.run.state", {
      description: "Current resident run state",
      unit: "1",
    })
    .addCallback((result) => {
      result.observe(1, { "sept.run.state": state.runState });
    });
}

function registerRunGauges(meter: Meter, state: MetricState): void {
  meter
    .createObservableGauge("sept.run.epoch", {
      description: "Current resident run epoch",
      unit: "{epoch}",
    })
    .addCallback((result) => {
      result.observe(state.epoch);
    });
  meter
    .createObservableGauge("sept.run.invocation", {
      description: "Current resident run invocation count",
      unit: "{invocation}",
    })
    .addCallback((result) => {
      result.observe(state.invocation);
    });
  meter
    .createObservableGauge("sept.operator.queue.depth", {
      description: "Pending operator message count",
      unit: "{message}",
    })
    .addCallback((result) => {
      result.observe(state.queueDepth);
    });
  meter
    .createObservableGauge("sept.pi.context.pressure", {
      description: "Latest provider-reported active context ratio",
      unit: "1",
    })
    .addCallback((result) => {
      if (state.contextPressure !== undefined) {
        result.observe(state.contextPressure);
      }
    });
}

function registerProcessGauges(meter: Meter): void {
  meter
    .createObservableGauge("sept.process.memory", {
      description: "Bounded Node process memory indicators",
      unit: "By",
    })
    .addCallback((result) => {
      const memory = process.memoryUsage();
      result.observe(memory.rss, { kind: "rss" });
      result.observe(memory.heapUsed, { kind: "heap_used" });
      result.observe(memory.heapTotal, { kind: "heap_total" });
      result.observe(memory.external, { kind: "external" });
    });
  meter
    .createObservableGauge("sept.process.cpu", {
      description: "Cumulative Node process CPU time",
      unit: "s",
    })
    .addCallback((result) => {
      const cpu = process.cpuUsage();
      result.observe(cpu.user / 1_000_000, { kind: "user" });
      result.observe(cpu.system / 1_000_000, { kind: "system" });
    });
  meter
    .createObservableGauge("sept.nodejs.event_loop.utilization", {
      description: "Node event-loop utilization",
      unit: "1",
    })
    .addCallback((result) => {
      result.observe(performance.eventLoopUtilization().utilization);
    });
}

function recordSafely(operation: () => void): void {
  try {
    operation();
  } catch {
    // Metrics are advisory and never participate in durable lifecycle authority.
  }
}

/**
 * Owns metric instruments and the latest in-process gauge snapshot for one meter provider.
 * Attributes use finite domain labels, recording failures are contained, and sampled state remains
 * advisory: it neither drives nor persists worker/run/session transitions.
 */
export class RuntimeMetrics {
  private readonly state: MetricState = {
    workerState: "starting",
    runState: "none",
    epoch: 0,
    invocation: 0,
    queueDepth: 0,
    contextPressure: undefined,
  };
  private readonly instruments: MetricInstruments;

  constructor(provider: MeterProvider, serviceVersion: string) {
    const meter = provider.getMeter("sept", serviceVersion);
    this.instruments = createInstruments(meter);
    registerLifecycleGauges(meter, this.state);
    registerRunGauges(meter, this.state);
    registerProcessGauges(meter);
  }

  /** Replace the latest worker-state observation; the runtime remains transition owner. */
  setWorkerState(state: WorkerState): void {
    this.state.workerState = state;
  }

  /**
   * Replace the resident-run gauge snapshot as one observation.
   * Negative counters are clamped at zero and the durable run state remains authoritative.
   */
  setRunState(state: ObservedRunState, epoch = 0, invocation = 0, queueDepth = 0): void {
    this.state.runState = state;
    this.state.epoch = Math.max(0, epoch);
    this.state.invocation = Math.max(0, invocation);
    this.state.queueDepth = Math.max(0, queueDepth);
  }

  /**
   * Update only the non-negative pending operator-message count.
   * Queue contents and message identity never enter metric state.
   */
  setQueueDepth(depth: number): void {
    this.state.queueDepth = Math.max(0, depth);
  }

  /**
   * Count one completed process start using finite adoption and mode classifications.
   * The worker has already decided adoption from durable evidence before reporting this fact.
   */
  workerStarted(adoption: WorkerAdoption, mode: WorkerMode): void {
    recordSafely(() => {
      this.instruments.workerStarts.add(1, { adoption, mode });
    });
  }

  /** Count an already-settled terminal run outcome without retaining run identity or authority. */
  runOutcome(outcome: RunOutcome): void {
    recordSafely(() => {
      this.instruments.runOutcomes.add(1, { outcome });
    });
  }

  /**
   * Count a Pi session open and a new epoch unless the existing session resumed in place.
   * Pi integration owns session replacement and no session identifier is recorded.
   */
  sessionOpened(outcome: SessionOpenOutcome): void {
    recordSafely(() => {
      this.instruments.sessionOpens.add(1, { outcome });
      if (outcome !== "resumed") {
        this.instruments.epochs.add(1, { outcome });
      }
    });
  }

  /**
   * Count one settled Pi invocation and its non-negative wall duration.
   * Provider response content and error details are reduced to finite outcome/steering labels.
   */
  invocationFinished(durationMs: number, outcome: InvocationOutcome, steered: boolean): void {
    const attributes: Attributes = { outcome, steered };
    recordSafely(() => {
      this.instruments.invocations.add(1, attributes);
      this.instruments.invocationDuration.record(Math.max(0, durationMs) / 1_000, attributes);
    });
  }

  /**
   * Store a valid finalized provider-reported context ratio or make the gauge absent.
   * Missing usage never becomes zero or a SEPT token estimate; ratios above capacity cap at one.
   */
  setContextPressure(tokens: number | null, contextWindow: number): number | undefined {
    const valid = tokens !== null && tokens > 0 && contextWindow > 0;
    this.state.contextPressure = valid ? Math.min(1, tokens / contextWindow) : undefined;
    return this.state.contextPressure;
  }

  /** Count a completed webhook routing classification without event, source, or message identity. */
  webhook(outcome: WebhookOutcome, kind: WebhookKind): void {
    recordSafely(() => {
      this.instruments.webhook.add(1, { outcome, kind });
    });
  }

  /**
   * Count a completed HTTP request using its pre-normalized method/route and non-negative latency.
   * Only status class is retained, avoiding raw URLs, headers, bodies, and status-cardinality drift.
   */
  http(method: string, route: string, status: number, durationMs: number): void {
    const statusClass = `${String(Math.floor(status / 100))}xx`;
    const attributes = { method, route, status_class: statusClass };
    recordSafely(() => {
      this.instruments.httpRequests.add(1, attributes);
      this.instruments.httpDuration.record(Math.max(0, durationMs) / 1_000, attributes);
    });
  }

  /**
   * Count exporter health using only finite signal and outcome classifications.
   * Export errors and payloads remain outside metrics, and recorder failure is contained.
   */
  export(outcome: "success" | "failure", signal: TelemetrySignal): void {
    recordSafely(() => {
      this.instruments.exports.add(1, { signal, outcome });
    });
  }
}
