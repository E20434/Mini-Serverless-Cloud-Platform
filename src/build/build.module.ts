import { Module } from '@nestjs/common';
import { FunctionsModule } from '../functions/functions.module';
import { BuildController } from './build.controller';
import { BuildOutboxRelayService } from './build-outbox-relay.service';
import { BuildStreamConsumerService } from './build-stream-consumer.service';
import { BuildService } from './build.service';

@Module({
  imports: [FunctionsModule],
  controllers: [BuildController],
  providers: [BuildService, BuildOutboxRelayService, BuildStreamConsumerService],
})
export class BuildModule {}
