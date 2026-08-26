import { Module } from '@nestjs/common';
import { RedisModule } from '../queue/redis.module';
import { WorkerRegistryModule } from '../worker-registry/worker-registry.module';
import { WorkerService } from './worker.service';

// Deliberately NOT importing PrismaModule or StorageModule - the Worker
// has no business talking to either. Its dependencies are Redis (jobs
// in, results out, heartbeats) and the Docker daemon (via
// containerExecutor, imported directly, not injected).
@Module({
  imports: [RedisModule, WorkerRegistryModule],
  providers: [WorkerService],
})
export class WorkerModule {}
