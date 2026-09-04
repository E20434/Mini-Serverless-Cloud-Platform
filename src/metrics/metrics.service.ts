import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * One Registry per process (API and Worker each get their OWN, separate
 * metrics - they're different processes, scraped as different targets).
 * Three different Prometheus primitives, each the right tool for a
 * different shape of data:
 *   - Counter: only ever goes up. Right for "how many invocations have
 *     happened" - you graph its RATE, never its raw value.
 *   - Histogram: buckets observed values so percentiles (p50/p95/p99)
 *     can be computed later. Right for durations - averaging latencies
 *     directly is misleading on a skewed distribution; bucketed counts
 *     aren't.
 *   - Gauge: a point-in-time value that can go up OR down. Right for
 *     "how many invocations is this worker running right now" - a
 *     counter could never represent that correctly.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly invocationsTotal = new Counter({
    name: 'mini_cloud_invocations_total',
    help: 'Total invocation attempts that reached the dispatch layer, by outcome status',
    labelNames: ['status'],
    registers: [this.registry],
  });

  readonly invocationDurationMs = new Histogram({
    name: 'mini_cloud_invocation_duration_ms',
    help: 'Invocation duration in milliseconds, as observed by whichever process recorded it',
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [this.registry],
  });

  readonly workerInFlight = new Gauge({
    name: 'mini_cloud_worker_in_flight',
    help: 'Invocations this worker process is currently executing (0 or 1 today - see WorkerService)',
    registers: [this.registry],
  });

  // Fleet-wide gauges, populated only by the API's MetricsController
  // right before a scrape (see its getMetrics()) - these describe the
  // WHOLE system, not any one process, so exactly one place should be
  // responsible for computing them fresh, rather than every worker
  // redundantly reporting the same global numbers.
  readonly invocationQueueDepth = new Gauge({
    name: 'mini_cloud_invocation_queue_depth',
    help: 'Consumer group LAG for the invocation stream: entries never yet delivered to any worker (NOT stream XLEN, which only grows)',
    registers: [this.registry],
  });

  readonly healthyWorkers = new Gauge({
    name: 'mini_cloud_healthy_workers',
    help: 'Workers in the registry with a heartbeat newer than the staleness threshold',
    registers: [this.registry],
  });

  metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
