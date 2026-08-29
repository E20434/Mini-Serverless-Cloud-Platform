import { Controller, Get, Header, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../queue/redis.module';
import { INVOCATION_STREAM_KEY } from '../worker/invocation-stream.constants';
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
      this.redis.xlen(INVOCATION_STREAM_KEY),
      this.workerRegistry.listWorkers(),
    ]);
    this.metrics.invocationQueueDepth.set(queueDepth);
    this.metrics.healthyWorkers.set(workers.filter((w) => w.healthy).length);

    return this.metrics.metricsText();
  }
}
