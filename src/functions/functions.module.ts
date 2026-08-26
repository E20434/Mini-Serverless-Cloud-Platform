import { Module } from '@nestjs/common';
import { InvocationDispatchModule } from '../invocation/invocation-dispatch.module';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';

@Module({
  imports: [InvocationDispatchModule],
  controllers: [FunctionsController],
  providers: [FunctionsService],
  // BuildModule needs to look up a function by name (to get its id)
  // before it can accept a version upload for it.
  exports: [FunctionsService],
})
export class FunctionsModule {}
