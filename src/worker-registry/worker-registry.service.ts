import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../queue/redis.module';

export interface WorkerHeartbeat {
  workerId: string;
  capacity: number;
  inFlight: number;
  lastHeartbeatAt: number; // epoch ms
}

export interface WorkerStatus extends WorkerHeartbeat {
  healthy: boolean;
}

const REGISTRY_KEY = 'workers:registry';
// No heartbeat in this long => treated as dead. This is a LEASE, not a
// message-idle timer: it answers "is the worker itself still alive,"
// independent of whether it currently happens to be mid-job.
const STALE_AFTER_MS = 10000;

/**
 * The worker fleet's shared source of truth for "who exists and are they
 * alive" - a single Redis hash (workerId -> JSON heartbeat), not
 * Postgres. This is deliberately ephemeral, fast-changing OPERATIONAL
 * state (Part 3 called this out from the very first design pass): if
 * Redis restarted and lost this hash entirely, nothing durable is lost -
 * every live worker's next heartbeat, seconds later, rebuilds it. That
 * property is exactly why this belongs in Redis and not Postgres.
 */
@Injectable()
export class WorkerRegistryService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async heartbeat(info: WorkerHeartbeat): Promise<void> {
    await this.redis.hset(REGISTRY_KEY, info.workerId, JSON.stringify(info));
  }

  async deregister(workerId: string): Promise<void> {
    await this.redis.hdel(REGISTRY_KEY, workerId);
  }

  async listWorkers(): Promise<WorkerStatus[]> {
    const raw = await this.redis.hgetall(REGISTRY_KEY);
    const now = Date.now();
    return Object.values(raw).map((json) => {
      const info: WorkerHeartbeat = JSON.parse(json);
      return { ...info, healthy: now - info.lastHeartbeatAt <= STALE_AFTER_MS };
    });
  }

  async hasSpareCapacity(): Promise<boolean> {
    const workers = await this.listWorkers();
    return workers.some((w) => w.healthy && w.inFlight < w.capacity);
  }
}
