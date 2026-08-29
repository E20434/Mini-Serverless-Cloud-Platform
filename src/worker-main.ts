/**
 * Entry point for the Worker process. Run separately from the API
 * (`npm run start:worker`, its own OS process, potentially its own
 * machine entirely) - it shares nothing with the API process except
 * Redis and the Docker daemon.
 *
 * NestFactory.createApplicationContext() (instead of NestFactory.create())
 * is the deliberate choice here: it boots Nest's dependency-injection
 * container - constructors, onModuleInit hooks, all of it - WITHOUT
 * starting an HTTP server, because a Worker has no routes to serve. This
 * is Nest's own supported way to run non-HTTP processes (workers, CLI
 * tools, cron jobs) through the same DI/module system as the API.
 *
 * Both WorkerService (the consumer loop) and WorkerMetricsServerService
 * (the tiny plain-http /metrics listener) start themselves via their own
 * onModuleInit hooks - nothing extra needs to happen here, which also
 * means every e2e test that constructs WorkerModule directly exercises
 * the exact same startup path this real entrypoint does.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  // No app.listen() - nothing to listen on for the main app. The process
  // stays alive because WorkerService's consumer loop and the metrics
  // http.Server both hold open handles, the same reason a plain
  // long-running script with an open socket never exits on its own.
  console.log('Worker process started.');
}

bootstrap();
