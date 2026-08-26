import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../queue/redis.module';
import { WorkerRegistryService } from './worker-registry.service';

// @Global() only reaches every provider within the SAME application's DI
// container - the API process (AppModule) and the Worker process
// (WorkerModule) are two SEPARATE application contexts (two separate
// NestFactory calls), so each root module must import this directly at
// least once. Both do, below.
@Global()
@Module({
  imports: [RedisModule],
  providers: [WorkerRegistryService],
  exports: [WorkerRegistryService],
})
export class WorkerRegistryModule {}
