import http from 'node:http';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { startMetricsServer } from '../metrics/metrics-http-server';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Starting the metrics server here, as part of the Worker's own Nest
 * lifecycle, rather than only in worker-main.ts, is deliberate: any test
 * that constructs WorkerModule directly via
 * NestFactory.createApplicationContext() (every e2e test in this repo
 * does) exercises the exact same startup path a real deployed process
 * would - there's no separate "test doesn't have metrics" code path to
 * accidentally diverge from production.
 */
@Injectable()
export class WorkerMetricsServerService implements OnModuleInit, OnModuleDestroy {
  private server?: http.Server;

  constructor(private readonly metrics: MetricsService) {}

  onModuleInit() {
    const port = process.env.WORKER_METRICS_PORT ? Number(process.env.WORKER_METRICS_PORT) : 9200;
    this.server = startMetricsServer(this.metrics, port);
  }

  onModuleDestroy(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }
}
