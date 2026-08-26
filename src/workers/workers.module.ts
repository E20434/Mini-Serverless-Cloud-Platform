import { Module } from '@nestjs/common';
import { WorkersController } from './workers.controller';

// No providers here - WorkerRegistryService comes from the @Global()
// WorkerRegistryModule imported once in AppModule.
@Module({
  controllers: [WorkersController],
})
export class WorkersModule {}
