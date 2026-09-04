import http from 'node:http';
import { MetricsService } from './metrics.service';

/**
 * A tiny, deliberately non-Nest HTTP listener for the Worker process,
 * which has no Nest HTTP server at all - NestFactory.createApplicationContext()
 * boots the DI container without ever starting Express. This is a real,
 * common pattern: a background/batch process exposing just a /metrics
 * endpoint alongside its main loop, without becoming a full web app.
 *
 * Real, load-test-discovered lesson baked into this function: running
 * more than one worker on the SAME host with the SAME WORKER_METRICS_PORT
 * means every worker after the first hits EADDRINUSE. An http.Server
 * with no 'error' listener treats that as an uncaught exception and
 * crashes the ENTIRE process - taking down real invocation-processing
 * capacity over a failure in a side-channel. That violates the same
 * principle observability has followed since Phase 1: a metrics/logging
 * failure must never be allowed to take down the thing it's observing.
 * So: log a warning and keep going without a scrapable endpoint, rather
 * than let a port collision kill a perfectly good worker.
 */
export function startMetricsServer(metrics: MetricsService, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      metrics.metricsText().then((text) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(text);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.warn(
        `[metrics] port ${port} already in use - this process will run WITHOUT a scrapable /metrics endpoint. ` +
          `Running multiple workers on one host needs a unique WORKER_METRICS_PORT per process.`,
      );
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(`[metrics] server error (non-fatal): ${err.message}`);
  });

  server.listen(port);
  return server;
}
