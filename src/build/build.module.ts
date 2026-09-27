import { Module } from '@nestjs/common';
import { FunctionsModule } from '../functions/functions.module';
import { BUILD_EXECUTOR } from './build-executor';
import { BuildController } from './build.controller';
import { BuildOutboxRelayService } from './build-outbox-relay.service';
import { BuildStreamConsumerService } from './build-stream-consumer.service';
import { BuildService } from './build.service';
import { CodeBuildExecutor } from './codebuild-executor';
import { LocalDockerBuildExecutor } from './local-docker-build-executor';

@Module({
  imports: [FunctionsModule],
  controllers: [BuildController],
  providers: [
    BuildService,
    BuildOutboxRelayService,
    BuildStreamConsumerService,
    LocalDockerBuildExecutor,
    CodeBuildExecutor,
    {
      provide: BUILD_EXECUTOR,
      // BUILD_EXECUTOR=codebuild only on the AWS deployment
      // (terraform/ecs.tf sets it on the API task) - every other
      // environment (bare host, Phase 12's Kubernetes) is unset,
      // defaulting to the local Docker path unchanged since Phase 5.
      useFactory: (local: LocalDockerBuildExecutor, codebuild: CodeBuildExecutor) =>
        process.env.BUILD_EXECUTOR === 'codebuild' ? codebuild : local,
      inject: [LocalDockerBuildExecutor, CodeBuildExecutor],
    },
  ],
})
export class BuildModule {}
