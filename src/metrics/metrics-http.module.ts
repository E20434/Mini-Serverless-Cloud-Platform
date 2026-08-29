import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';

// Split from MetricsModule on purpose: this declares an HTTP controller,
// which only makes sense where a real Nest HTTP server exists (the API
// process). The Worker boots via NestFactory.createApplicationContext()
// - no Express instance at all - so it imports MetricsModule (the
// service) directly and exposes /metrics through a plain Node http
// server instead (see metrics-http-server.ts).
@Module({
  controllers: [MetricsController],
})
export class MetricsHttpModule {}
