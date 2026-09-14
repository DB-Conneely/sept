import { performance } from "node:perf_hooks";
import type { Attributes } from "@opentelemetry/api";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { ObservedRunState, WorkerState } from "./contract.js";

export class RuntimeMetrics {
  private workerState: WorkerState = "starting";
  private runState: ObservedRunState = "none";
  private epoch = 0;
  private invocation = 0;
  private queueDepth = 0;
  private contextPressure: number | undefined;
  private readonly exportCounter;
  private readonly instruments;

  constructor(provider: MeterProvider, serviceVersion: string) {
    const meter = provider.getMeter("sept", serviceVersion);
    const workerStarts = meter.createCounter("sept.worker.starts", { description: "Worker process starts", unit: "{start}" });
    const runOutcomes = meter.createCounter("sept.run.outcomes", { description: "Terminal run outcomes", unit: "{run}" });
    const sessionOpens = meter.createCounter("sept.pi.session.opens", { description: "Pi session open and adoption outcomes", unit: "{session}" });
    const epochs = meter.createCounter("sept.run.epochs", { description: "Pi session epochs started or adopted by this process", unit: "{epoch}" });
    const invocations = meter.createCounter("sept.pi.invocations", { description: "Pi invocation outcomes", unit: "{invocation}" });
    const invocationDuration = meter.createHistogram("sept.pi.invocation.duration", { description: "Pi invocation wall time", unit: "s", advice: { explicitBucketBoundaries: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900, 3600] } });
    const webhook = meter.createCounter("sept.webhook.requests", { description: "Webhook routing outcomes", unit: "{request}" });
    const httpRequests = meter.createCounter("sept.http.server.requests", { description: "Worker HTTP outcomes", unit: "{request}" });
    const httpDuration = meter.createHistogram("sept.http.server.duration", { description: "Worker HTTP request latency", unit: "s", advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1, 5, 30] } });
    this.exportCounter = meter.createCounter("sept.telemetry.exports", { description: "Telemetry exporter outcomes", unit: "{export}" });
    this.instruments = { workerStarts, runOutcomes, sessionOpens, epochs, invocations, invocationDuration, webhook, httpRequests, httpDuration };

    meter.createObservableGauge("sept.worker.uptime", { description: "Worker process uptime", unit: "s" }).addCallback((result) => result.observe(process.uptime()));
    meter.createObservableGauge("sept.worker.state", { description: "Current worker state", unit: "1" }).addCallback((result) => result.observe(1, { "sept.worker.state": this.workerState }));
    meter.createObservableGauge("sept.run.state", { description: "Current resident run state", unit: "1" }).addCallback((result) => result.observe(1, { "sept.run.state": this.runState }));
    meter.createObservableGauge("sept.run.epoch", { description: "Current resident run epoch", unit: "{epoch}" }).addCallback((result) => result.observe(this.epoch));
    meter.createObservableGauge("sept.run.invocation", { description: "Current resident run invocation count", unit: "{invocation}" }).addCallback((result) => result.observe(this.invocation));
    meter.createObservableGauge("sept.operator.queue.depth", { description: "Pending operator message count", unit: "{message}" }).addCallback((result) => result.observe(this.queueDepth));
    meter.createObservableGauge("sept.pi.context.pressure", { description: "Latest provider-reported active context ratio", unit: "1" }).addCallback((result) => {
      if (this.contextPressure !== undefined) result.observe(this.contextPressure);
    });
    meter.createObservableGauge("sept.process.memory", { description: "Bounded Node process memory indicators", unit: "By" }).addCallback((result) => {
      const memory = process.memoryUsage();
      result.observe(memory.rss, { kind: "rss" });
      result.observe(memory.heapUsed, { kind: "heap_used" });
      result.observe(memory.heapTotal, { kind: "heap_total" });
      result.observe(memory.external, { kind: "external" });
    });
    meter.createObservableGauge("sept.process.cpu", { description: "Cumulative Node process CPU time", unit: "s" }).addCallback((result) => {
      const cpu = process.cpuUsage();
      result.observe(cpu.user / 1_000_000, { kind: "user" });
      result.observe(cpu.system / 1_000_000, { kind: "system" });
    });
    meter.createObservableGauge("sept.nodejs.event_loop.utilization", { description: "Node event-loop utilization", unit: "1" }).addCallback((result) => result.observe(performance.eventLoopUtilization().utilization));
  }

  setWorkerState(state: WorkerState): void { this.workerState = state; }
  setRunState(state: ObservedRunState, epoch = 0, invocation = 0, queueDepth = 0): void {
    this.runState = state;
    this.epoch = Math.max(0, epoch);
    this.invocation = Math.max(0, invocation);
    this.queueDepth = Math.max(0, queueDepth);
  }
  setQueueDepth(depth: number): void { this.queueDepth = Math.max(0, depth); }
  workerStarted(adoption: string, mode: string): void { try { this.instruments.workerStarts.add(1, { adoption, mode }); } catch {} }
  runOutcome(outcome: string): void { try { this.instruments.runOutcomes.add(1, { outcome }); } catch {} }
  sessionOpened(outcome: string): void {
    try {
      this.instruments.sessionOpens.add(1, { outcome });
      if (outcome !== "resumed") this.instruments.epochs.add(1, { outcome });
    } catch {}
  }
  invocationFinished(durationMs: number, outcome: string, steered: boolean): void {
    const attributes: Attributes = { outcome, steered };
    try {
      this.instruments.invocations.add(1, attributes);
      this.instruments.invocationDuration.record(Math.max(0, durationMs) / 1000, attributes);
    } catch {}
  }
  setContextPressure(tokens: number | null, contextWindow: number): number | undefined {
    const valid = tokens !== null && tokens > 0 && contextWindow > 0;
    this.contextPressure = valid ? Math.min(1, tokens / contextWindow) : undefined;
    return this.contextPressure;
  }
  webhook(outcome: string, kind: string): void { try { this.instruments.webhook.add(1, { outcome, kind }); } catch {} }
  http(method: string, route: string, status: number, durationMs: number): void {
    const attributes = { method, route, status_class: `${Math.floor(status / 100)}xx` };
    try {
      this.instruments.httpRequests.add(1, attributes);
      this.instruments.httpDuration.record(Math.max(0, durationMs) / 1000, attributes);
    } catch {}
  }
  export(outcome: "success" | "failure", signal: string): void { try { this.exportCounter.add(1, { signal, outcome }); } catch {} }
}
