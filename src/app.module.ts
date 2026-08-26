import { Module } from '@nestjs/common';
import { BuildModule } from './build/build.module';
import { FunctionsModule } from './functions/functions.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './queue/redis.module';
import { StorageModule } from './storage/storage.module';
import { WorkerRegistryModule } from './worker-registry/worker-registry.module';
import { WorkersModule } from './workers/workers.module';

// The API process itself never runs a container anymore (Phase 7) and
// now also knows nothing about worker internals beyond what the registry
// reports (Phase 8) - it reads WorkerRegistryService purely to answer
// "who's out there and how loaded are they," for GET /workers and for
// backpressure in FunctionsService.invoke().
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    StorageModule,
    WorkerRegistryModule,
    FunctionsModule,
    BuildModule,
    WorkersModule,
  ],
})
export class AppModule {}
