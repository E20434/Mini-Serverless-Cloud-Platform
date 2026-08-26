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
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerModule);
  // No app.listen() - nothing to listen on. The process stays alive
  // because WorkerService's own consumer loop holds an open Redis
  // connection (an active handle), the same reason a plain long-running
  // script with an open socket never exits on its own.
  console.log('Worker process started.');
}

bootstrap();
