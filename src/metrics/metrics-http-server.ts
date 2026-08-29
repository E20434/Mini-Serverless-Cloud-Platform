import http from 'node:http';
import { MetricsService } from './metrics.service';

/**
 * A tiny, deliberately non-Nest HTTP listener for the Worker process,
 * which has no Nest HTTP server at all - NestFactory.createApplicationContext()
 * boots the DI container without ever starting Express. This is a real,
 * common pattern: a background/batch process exposing just a /metrics
 * endpoint alongside its main loop, without becoming a full web app.
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
  server.listen(port);
  return server;
}
