import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { BUILD_CONSUMER_GROUP, BUILD_STREAM_KEY } from '../src/build/build-stream.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { ObjectStorageService } from '../src/storage/object-storage.service';

const fn = (name: string) => path.join(__dirname, '..', 'functions', name);

describe('Build queue crash recovery (e2e)', () => {
  let app: INestApplication | undefined;

  afterAll(async () => {
    delete process.env.BUILD_CLAIM_IDLE_MS;
    await app?.close();
  });

  it('reclaims a message abandoned by a dead consumer instead of leaving it stuck forever', async () => {
    // Read fresh inside reclaimAbandonedMessages() on every loop
    // iteration - setting this before the real app exists makes its
    // XAUTOCLAIM sweep reclaim abandoned messages in ~1s instead of the
    // production default of 30s, without changing any application code.
    process.env.BUILD_CLAIM_IDLE_MS = '1000';

    // Plain, un-DI'd instances - deliberately NOT the real app's managed
    // singletons. This lets us manufacture and steal a message BEFORE
    // the real app (and its already-blocked BuildStreamConsumerService)
    // exists at all. Doing this steal against an app that's already
    // live and listening would race that app's own blocked XREADGROUP
    // call - which, being already parked waiting for exactly this kind
    // of new message, tends to win delivery before an out-of-band call
    // fired right after XADD ever gets a chance to. Controlling exactly
    // when the competing consumer comes alive removes that race
    // entirely instead of trying to out-time it.
    const prisma = new PrismaService();
    await prisma.onModuleInit(); // just $connect()
    const storage = new ObjectStorageService();
    await storage.onModuleInit(); // just ensures the bucket exists
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    try {
      // Phase 9: Function.userId is required now, and names are unique
      // per-user, not globally - a plain fixture user, created directly
      // (never logged into via HTTP, so the password hash is never
      // actually checked against anything).
      await prisma.user.deleteMany({ where: { email: 'build-queue-test@example.com' } });
      const user = await prisma.user.create({
        data: { email: 'build-queue-test@example.com', passwordHash: 'unused-fixture-user' },
      });
      const functionRecord = await prisma.function.create({ data: { userId: user.id, name: 'reclaim-test' } });

      // Manufacture exactly what the outbox relay would have produced -
      // real source bytes in object storage, a real PENDING Build row.
      const sourceObjectKey = `functions/${functionRecord.id}/manual-test.js`;
      await storage.putObject(sourceObjectKey, fs.readFileSync(fn('hello.js')));
      const build = await prisma.build.create({
        data: { functionId: functionRecord.id, sourceObjectKey, status: 'PENDING' },
      });

      // Unlike Postgres rows, Redis stream messages and consumer-group /
      // Pending Entries List state do NOT get cleaned up between test
      // runs on their own - nothing here has been calling XDEL/XTRIM.
      // Leftover pending entries from EARLIER runs (including earlier
      // failed attempts at this exact test) accumulate forever, and
      // xpending('-', '+', 1) below returns the OLDEST pending entry in
      // the whole group - which, without this line, could easily be a
      // stale leftover instead of the message this run just published.
      // That's exactly what produced a very real, very confusing flake
      // here before this line existed (a previous run's dangling message
      // referencing an already-deleted Build). Deleting the key wipes
      // the stream AND its consumer-group/PEL state together, so every
      // run starts from a genuinely empty stream.
      await redis.del(BUILD_STREAM_KEY);
      await redis.xgroup('CREATE', BUILD_STREAM_KEY, BUILD_CONSUMER_GROUP, '$', 'MKSTREAM');

      // Publish it (standing in for the outbox relay), then immediately
      // claim delivery under a consumer name that will never ack or
      // claim it again - simulating "a worker received this job and then
      // crashed before finishing." No live real consumer exists yet, so
      // this delivery is deterministic, not a race.
      await redis.xadd(BUILD_STREAM_KEY, '*', 'buildId', build.id);
      const stolen = await redis.xreadgroup(
        'GROUP', BUILD_CONSUMER_GROUP, 'rogue-dead-consumer',
        'COUNT', '1',
        'STREAMS', BUILD_STREAM_KEY, '>',
      );
      expect(stolen).not.toBeNull(); // sanity check: we actually claimed delivery of one message

      // Confirm it's genuinely stuck, attributed to the dead consumer -
      // this is what makes the eventual SUCCESS below proof of reclaim,
      // not a coincidence of some other consumer seeing it normally.
      const pendingOwner = await redis.xpending(BUILD_STREAM_KEY, BUILD_CONSUMER_GROUP, '-', '+', 1);
      expect((pendingOwner as unknown as [string, string][])[0][1]).toBe('rogue-dead-consumer');

      // ONLY NOW does the real app - and its real BuildStreamConsumerService
      // - come alive. It starts its loop fresh, sees this message already
      // idle in the group's Pending Entries List under a consumer it's
      // never heard of, and will reclaim it via XAUTOCLAIM once
      // BUILD_CLAIM_IDLE_MS has elapsed.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      const deadline = Date.now() + 15000;
      let final = build;
      while (final.status !== 'SUCCESS' && final.status !== 'FAILED') {
        if (Date.now() > deadline) {
          throw new Error(`Build never reclaimed (last status: ${final.status})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        final = await prisma.build.findUniqueOrThrow({ where: { id: build.id } });
      }

      expect(final.status).toBe('SUCCESS');
      expect(final.imageTag).toBe('mini-cloud-fn-reclaim-test:1');
    } finally {
      await prisma.$disconnect();
      redis.disconnect();
    }
  }, 20000);
});
