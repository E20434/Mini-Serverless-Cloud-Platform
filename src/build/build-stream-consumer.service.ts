import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../queue/redis.module';
import { BuildService } from './build.service';
import { BUILD_CONSUMER_GROUP, BUILD_CONSUMER_NAME, BUILD_STREAM_KEY } from './build-stream.constants';

const BLOCK_MS = 2000;
const DEFAULT_CLAIM_IDLE_MS = 30000;

/**
 * The real message-queue consumer, replacing Phase 5's DB-polling
 * BuildWorkerService. Two responsibilities, both real Redis Streams
 * mechanisms:
 *
 *  1. Block on new messages (XREADGROUP ... BLOCK) - push-like
 *     efficiency: no wasted round trips while idle, unlike a
 *     setInterval poll.
 *  2. Reclaim messages abandoned by a dead consumer (XAUTOCLAIM) - the
 *     Streams equivalent of SQS's visibility timeout expiring, and the
 *     direct replacement for what Postgres's SKIP LOCKED gave us in
 *     Phase 5.
 */
@Injectable()
export class BuildStreamConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildStreamConsumerService.name);
  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly buildService: BuildService,
  ) {}

  async onModuleInit() {
    await this.ensureConsumerGroup();
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onModuleDestroy() {
    this.running = false;
    // Doesn't forcibly interrupt an in-flight BLOCK call - the loop exits
    // cleanly on its own once that call returns (at most BLOCK_MS later).
    await this.loopPromise;
  }

  private async ensureConsumerGroup() {
    try {
      // '$' = only messages added AFTER this group is created; MKSTREAM
      // creates the stream itself if the outbox relay hasn't published
      // anything yet. The group must exist before the first
      // XREADGROUP call, regardless of publish order.
      await this.redis.xgroup('CREATE', BUILD_STREAM_KEY, BUILD_CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP = the group already exists - expected on every restart
      // after the very first one, not a real error.
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  private async loop() {
    while (this.running) {
      try {
        await this.reclaimAbandonedMessages();
        await this.readAndProcessOnce();
      } catch (err) {
        this.logger.error(`Consumer loop iteration failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async readAndProcessOnce() {
    const response = await this.redis.xreadgroup(
      'GROUP', BUILD_CONSUMER_GROUP, BUILD_CONSUMER_NAME,
      'COUNT', '1',
      'BLOCK', String(BLOCK_MS),
      'STREAMS', BUILD_STREAM_KEY, '>',
    );
    if (!response) return; // BLOCK timed out with nothing new - loop again

    const [[, messages]] = response as [string, [string, string[]][]][];
    for (const [messageId, fields] of messages) {
      await this.handleMessage(messageId, fields);
    }
  }

  private async reclaimAbandonedMessages() {
    const claimIdleMs = Number(process.env.BUILD_CLAIM_IDLE_MS ?? DEFAULT_CLAIM_IDLE_MS);
    const [, claimed] = await this.redis.xautoclaim(
      BUILD_STREAM_KEY, BUILD_CONSUMER_GROUP, BUILD_CONSUMER_NAME, claimIdleMs, '0',
    );
    for (const [messageId, fields] of claimed as [string, string[]][]) {
      this.logger.warn(`Reclaimed abandoned message ${messageId} (idle > ${claimIdleMs}ms)`);
      await this.handleMessage(messageId, fields);
    }
  }

  private async handleMessage(messageId: string, fields: string[]) {
    const buildId = fields[fields.indexOf('buildId') + 1];
    try {
      // Idempotency guard: at-least-once delivery means this could be a
      // REDELIVERY of a build already finished by us or a now-dead
      // consumer. Trusting "I received a message" to mean "this hasn't
      // happened yet" is exactly the mistake at-least-once systems
      // punish - always check current state before doing real work.
      const build = await this.prisma.build.findUniqueOrThrow({ where: { id: buildId } });
      if (build.status === 'SUCCESS' || build.status === 'FAILED') {
        this.logger.log(`Build ${buildId} already ${build.status} - skipping redelivered message ${messageId}`);
      } else {
        await this.buildService.runBuild(build);
      }
      await this.redis.xack(BUILD_STREAM_KEY, BUILD_CONSUMER_GROUP, messageId);
    } catch (err) {
      this.logger.error(`Failed handling build message ${messageId}: ${err instanceof Error ? err.message : err}`);
      // Deliberately NOT acking - the message stays in the Pending
      // Entries List, where reclaimAbandonedMessages() will pick it up
      // again once it's been idle long enough.
    }
  }
}
