import crypto from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { executeVersionedFunction, ExecutionOutcome } from '../containerExecutor';
import { REDIS_CLIENT } from '../queue/redis.module';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { INVOCATION_CONSUMER_GROUP, INVOCATION_STREAM_KEY, invocationResultChannel } from './invocation-stream.constants';

const BLOCK_MS = 2000;
const HEARTBEAT_INTERVAL_MS = 3000;
const DEFAULT_CLAIM_IDLE_MS = 8000;
// This worker processes ONE invocation at a time (COUNT 1 below) - true
// per-worker concurrency is a real, valuable enhancement that belongs to
// a later Scaling phase, not this one. capacity=1 here is honest about
// that, not a placeholder: it's the actual number of jobs this process
// can run simultaneously today.
const CAPACITY = 1;

/**
 * The Worker, now with a real identity instead of a hardcoded name.
 * Three responsibilities beyond Phase 7's version:
 *   1. A unique workerId, used both as this worker's Streams consumer
 *      name AND its registry key - multiple real worker processes can
 *      now coexist in the same consumer group without corrupting each
 *      other's Pending Entries List bookkeeping.
 *   2. A heartbeat loop, independent of message processing, so the
 *      registry reflects "is this process alive" even between jobs.
 *   3. Smarter reclaim: only steal a stale message from a worker the
 *      registry confirms is actually dead, never from one that's simply
 *      slow but still heartbeating.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  private running = false;
  private inFlight = 0;
  private loopPromise?: Promise<void>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly registry: WorkerRegistryService,
  ) {}

  async onModuleInit() {
    await this.ensureConsumerGroup();
    await this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.log(`Worker "${this.workerId}" is up, waiting for invocations`);
  }

  async onModuleDestroy() {
    this.running = false;
    clearInterval(this.heartbeatTimer);
    await this.loopPromise;
    // Graceful deregistration. Note this ONLY runs on a clean shutdown -
    // a real crash skips this entirely, which is exactly why heartbeat
    // staleness (not this line) is the actual failure detector the rest
    // of the system relies on.
    await this.registry.deregister(this.workerId);
  }

  private async sendHeartbeat() {
    await this.registry.heartbeat({
      workerId: this.workerId,
      capacity: CAPACITY,
      inFlight: this.inFlight,
      lastHeartbeatAt: Date.now(),
    });
  }

  private async ensureConsumerGroup() {
    try {
      await this.redis.xgroup('CREATE', INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  private async loop() {
    while (this.running) {
      try {
        await this.reclaimFromDeadWorkers();
        await this.readAndProcessOnce();
      } catch (err) {
        this.logger.error(`Worker loop iteration failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async readAndProcessOnce() {
    const response = await this.redis.xreadgroup(
      'GROUP', INVOCATION_CONSUMER_GROUP, this.workerId,
      'COUNT', '1',
      'BLOCK', String(BLOCK_MS),
      'STREAMS', INVOCATION_STREAM_KEY, '>',
    );
    if (!response) return;

    const [[, messages]] = response as [string, [string, string[]][]][];
    for (const [messageId, fields] of messages) {
      await this.handleMessage(messageId, fields);
    }
  }

  /**
   * Replaces Phase 6/7's blind XAUTOCLAIM. XPENDING with IDLE lets us see
   * WHO currently owns each stale message before deciding whether to
   * steal it - the piece XAUTOCLAIM alone can't give you. Only messages
   * owned by a worker the registry no longer considers healthy get
   * reclaimed; a worker that's simply taking a long time on a legitimate
   * slow function keeps its job, because stealing it would just mean
   * running the same invocation twice for no reason.
   */
  private async reclaimFromDeadWorkers() {
    const claimIdleMs = Number(process.env.INVOCATION_CLAIM_IDLE_MS ?? DEFAULT_CLAIM_IDLE_MS);

    const entries = (await this.redis.xpending(
      INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP,
      'IDLE', String(claimIdleMs),
      '-', '+', '10',
    )) as [string, string, number, number][];
    if (!entries.length) return;

    const workers = await this.registry.listWorkers();
    const healthyWorkerIds = new Set(workers.filter((w) => w.healthy).map((w) => w.workerId));

    for (const [messageId, ownerConsumer] of entries) {
      if (ownerConsumer === this.workerId) continue; // already ours
      if (healthyWorkerIds.has(ownerConsumer)) continue; // alive, just slow - leave it alone

      this.logger.warn(`Reclaiming message ${messageId} from presumed-dead worker "${ownerConsumer}"`);
      const claimed = await this.redis.xclaim(
        INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, this.workerId, claimIdleMs, messageId,
      );
      for (const [id, fields] of claimed as [string, string[]][]) {
        await this.handleMessage(id, fields);
      }
    }
  }

  private async handleMessage(messageId: string, fields: string[]) {
    const get = (key: string) => fields[fields.indexOf(key) + 1];
    const correlationId = get('correlationId');

    this.inFlight++;
    let outcome: ExecutionOutcome;
    try {
      const imageTag = get('imageTag');
      const event = JSON.parse(get('event'));
      const timeoutMs = Number(get('timeoutMs'));
      const memoryMb = Number(get('memoryMb'));
      outcome = await executeVersionedFunction(imageTag, event, { timeoutMs, memoryMb });
    } catch (err) {
      outcome = { status: 'error', error: err instanceof Error ? err.message : String(err), durationMs: 0 };
    } finally {
      this.inFlight--;
    }

    await this.redis.publish(invocationResultChannel(correlationId), JSON.stringify(outcome));
    await this.redis.xack(INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, messageId);
  }
}
