import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../queue/redis.module';
import { BUILD_STREAM_KEY } from './build-stream.constants';

const RELAY_INTERVAL_MS = 1000;

/**
 * The transactional outbox relay. Postgres is the durable source of
 * truth for "this build exists and needs to run" - `submitBuild()` in
 * build.service.ts writes ONLY there, nothing touches Redis on the HTTP
 * request path at all. This relay's only job is noticing newly-committed
 * PENDING builds and publishing them into the stream.
 *
 * Why not just XADD directly inside submitBuild()? Because that would be
 * two independent writes (Postgres INSERT, then Redis XADD) with no way
 * to make them atomic across two different storage systems - if the
 * process crashed between them, the build would exist in Postgres but
 * never get dispatched, stuck PENDING forever with nothing watching it.
 * Splitting the "record the fact" step from the "announce the fact" step,
 * and making the announcer a separate, idempotent, retryable loop, is
 * the standard fix (the "outbox pattern") for exactly this class of bug.
 */
@Injectable()
export class BuildOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildOutboxRelayService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => this.relayOnce(), RELAY_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async relayOnce() {
    const unpublished = await this.prisma.build.findMany({
      where: { status: 'PENDING', publishedToStreamAt: null },
      take: 20,
      orderBy: { createdAt: 'asc' },
    });

    for (const build of unpublished) {
      try {
        await this.redis.xadd(BUILD_STREAM_KEY, '*', 'buildId', build.id);
        await this.prisma.build.update({
          where: { id: build.id },
          data: { publishedToStreamAt: new Date() },
        });
      } catch (err) {
        // Leave publishedToStreamAt null on failure - the next tick will
        // simply try this build again. A build published twice (e.g. the
        // XADD succeeds but the Postgres UPDATE that records it fails) is
        // safe, not just likely-rare: the consumer's idempotency check
        // (see build-stream-consumer.service.ts) treats a redelivery of
        // an already-finished build as a no-op.
        this.logger.error(`Failed to relay build ${build.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
