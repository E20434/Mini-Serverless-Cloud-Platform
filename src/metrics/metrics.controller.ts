import { Controller, Get, Header, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../queue/redis.module';
import { INVOCATION_CONSUMER_GROUP, INVOCATION_STREAM_KEY } from '../worker/invocation-stream.constants';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { MetricsService } from './metrics.service';

// Deliberately NO @UseGuards(AuthGuard) here. In a real deployment this
// endpoint is reached only from the Prometheus scraper's network (a
// firewall rule, a private subnet, a separate port) - not gated by
// application credentials, because a scraper polling every few seconds
// shouldn't need to manage a token. Worth stating explicitly rather than
// leaving it looking like an oversight.
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly workerRegistry: WorkerRegistryService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    // Fleet-wide gauges are computed fresh on every scrape, not cached -
    // Prometheus scrapes are infrequent enough (default 15s-1m) that
    // this is cheap, and it means the value is never more stale than the
    // scrape interval itself.
    const [queueDepth, workers] = await Promise.all([
      this.getConsumerGroupLag(),
      this.workerRegistry.listWorkers(),
    ]);
    this.metrics.invocationQueueDepth.set(queueDepth);
    this.metrics.healthyWorkers.set(workers.filter((w) => w.healthy).length);

    return this.metrics.metricsText();
  }

  /**
   * A real bug, found by Phase 11's load test, not by inspection: this
   * used to be `XLEN` (total entries EVER added to the stream). Streams
   * are an append-only log - they never shrink as messages get consumed
   * and acked, so XLEN only ever grows and says nothing about current
   * backlog. The actual "how much unconsumed work is queued up" metric
   * is a consumer group's LAG - entries added to the stream that have
   * not yet been delivered to any consumer in the group at all. XINFO
   * GROUPS exposes it directly (Redis 7+).
   */
  private async getConsumerGroupLag(): Promise<number> {
    const groups = (await this.redis.xinfo('GROUPS', INVOCATION_STREAM_KEY)) as unknown as unknown[][];
    const group = groups.find((fields) => fields[fields.indexOf('name') + 1] === INVOCATION_CONSUMER_GROUP);
    if (!group) return 0;
    const lag = group[group.indexOf('lag') + 1];
    return typeof lag === 'number' ? lag : 0;
  }
}
