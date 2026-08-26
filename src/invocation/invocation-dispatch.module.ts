import { Module } from '@nestjs/common';
import { InvocationDispatchService } from './invocation-dispatch.service';

@Module({
  providers: [InvocationDispatchService],
  exports: [InvocationDispatchService],
})
export class InvocationDispatchModule {}
