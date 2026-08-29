import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../queue/redis.module';
import { WorkerRegistryModule } from '../worker-registry/worker-registry.module';
import { WorkerMetricsServerService } from './worker-metrics-server.service';
import { WorkerService } from './worker.service';

// Deliberately NOT importing PrismaModule or StorageModule - the Worker
// has no business talking to either. Its dependencies are Redis (jobs
// in, results out, heartbeats), the Docker daemon (via containerExecutor,
// imported directly, not injected), and now MetricsModule for its own
// /metrics exposure (via a plain http server, not Nest's HTTP stack -
// see metrics-http-server.ts / worker-metrics-server.service.ts).
@Module({
  imports: [RedisModule, WorkerRegistryModule, MetricsModule],
  providers: [WorkerService, WorkerMetricsServerService],
})
export class WorkerModule {}
