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
 * A real bug, found running 2 API replicas in Kubernetes (Phase 12), not
 * hypothesized: the FIRST version of this method did a plain SELECT with
 * no locking, then XADD, then UPDATE. With only one relay instance ever
 * running (every phase before this one), that's fine. With two - both
 * polling on the same 1s interval - both could SELECT the same
 * unpublished build before either one's UPDATE committed, and both would
 * XADD it as two SEPARATE stream messages. Each message gets a distinct
 * ID, so the Phase 8-style unique-consumer-name fix and the Phase 6
 * idempotency check in the consumer (which only catches REDELIVERY of
 * the SAME message) do nothing to stop this - it's a genuinely different
 * race, at the producer, not the consumer. Fixed with the exact
 * SKIP LOCKED pattern already proven for exactly this shape of problem
 * (Phase 5's original build-claim logic): atomically claim rows - lock
 * them, mark them published, all in one transaction - before ANY relay
 * instance is allowed to act on them.
 */
@Injectable()
export class BuildOutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildOutboxRelayService.name);
  private timer?: ReturnType<typeof setInterval>;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      // The same "attach a handler immediately" lesson from Phase 1's
      // handlerPromise and Phase 7's resultPromise, a third time: if
      // relayOnce()'s transaction ever rejects and nothing is awaiting
      // `currentTick` yet (the gap between ticks), that's a real
      // unhandled rejection, not a hypothetical one.
      this.currentTick = this.relayOnce().catch((err) => {
        this.logger.error(`Relay tick failed: ${err instanceof Error ? err.message : err}`);
      });
    }, RELAY_INTERVAL_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    // Found for real running the test suite after the SKIP LOCKED fix
    // above: relayOnce() now runs inside a real $transaction(). Clearing
    // the interval stops NEW ticks but does nothing about one already in
    // flight - if Prisma disconnects (its own onModuleDestroy) while that
    // transaction is still open, it fails with a genuine
    // "Transaction not found... obtained before disconnecting" error.
    // Same fix already used by WorkerService/BuildStreamConsumerService:
    // await the in-flight work before this hook returns.
    await this.currentTick;
  }

  private async relayOnce() {
    const claimedIds = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM builds
        WHERE status = 'PENDING' AND published_to_stream_at IS NULL
        ORDER BY created_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];

      const ids = rows.map((row) => row.id);
      // Claimed and marked in the SAME transaction as the lock, before
      // this relay instance has even tried to publish anything - a
      // concurrent relay's SKIP LOCKED scan can never see these rows,
      // full stop, regardless of how long the actual XADD calls below
      // take.
      await tx.build.updateMany({
        where: { id: { in: ids } },
        data: { publishedToStreamAt: new Date() },
      });
      return ids;
    });

    for (const buildId of claimedIds) {
      try {
        await this.redis.xadd(BUILD_STREAM_KEY, '*', 'buildId', buildId);
      } catch (err) {
        // The row is already marked published even though this XADD
        // failed - a deliberate tradeoff. The alternative (leave it
        // unpublished so a later tick retries) is exactly what let two
        // relays double-publish before this fix. A real Redis outage
        // here is rare and loud (logged), and would need a separate
        // reconciliation sweep to recover cleanly - out of scope here,
        // same as the other known, documented gaps in this project.
        this.logger.error(`Claimed build ${buildId} but failed to publish it: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
