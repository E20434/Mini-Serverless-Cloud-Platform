import { Controller, Get } from '@nestjs/common';

/**
 * Deliberately trivial and unauthenticated - a liveness/readiness probe
 * needs to answer ONE question fast: "is this process able to respond to
 * HTTP at all." It does NOT check Postgres/Redis/MinIO connectivity
 * (a "deep" health check) - conflating the two is a real, common K8s
 * mistake: if this endpoint failed whenever Postgres was briefly slow,
 * Kubernetes would kill and restart a perfectly healthy API process for
 * a problem restarting it cannot fix, potentially cascading a downstream
 * outage into an unnecessary crash-loop of the API tier itself.
 */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
