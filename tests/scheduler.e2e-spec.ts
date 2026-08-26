import 'reflect-metadata';
import path from 'node:path';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WorkerModule } from '../src/worker/worker.module';
import { INVOCATION_CONSUMER_GROUP, INVOCATION_STREAM_KEY } from '../src/worker/invocation-stream.constants';

const fn = (name: string) => path.join(__dirname, '..', 'functions', name);
const REGISTRY_KEY = 'workers:registry';

async function waitForBuildToFinish(app: INestApplication, name: string, buildId: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app.getHttpServer()).get(`/functions/${name}/builds/${buildId}`).expect(200);
    if (res.body.status === 'SUCCESS' || res.body.status === 'FAILED') return res.body;
    if (Date.now() > deadline) throw new Error(`Build did not finish in time (status: ${res.body.status})`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function xpendingOwner(redis: Redis, messageId: string): Promise<string | undefined> {
  const entries = (await redis.xpending(INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, '-', '+', 50)) as [
    string,
    string,
    number,
    number,
  ][];
  return entries.find(([id]) => id === messageId)?.[1];
}

describe('Scheduler: worker registry and smart reclaim (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplicationContext | undefined;
  let redis: Redis;
  let imageTag: string;

  beforeAll(async () => {
    // Short idle threshold so "should this stale message be reclaimed"
    // decisions happen in ~1s instead of the production default of 8s.
    process.env.INVOCATION_CLAIM_IDLE_MS = '1000';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    const prisma = moduleRef.get(PrismaService);
    await prisma.function.deleteMany({ where: { name: 'scheduler-test' } });

    // One real, invokable image, reused across both manufactured-message
    // tests below.
    await request(app.getHttpServer()).post('/functions').send({ name: 'scheduler-test' }).expect(201);
    const upload = await request(app.getHttpServer())
      .post('/functions/scheduler-test/versions')
      .attach('source', fn('hello.js'))
      .expect(201);
    const build = await waitForBuildToFinish(app, 'scheduler-test', upload.body.buildId);
    imageTag = build.imageTag;

    // Consumer group must exist before we can manually XADD/XREADGROUP
    // against it - normally a real WorkerService's onModuleInit does
    // this; no worker exists yet in this file at this point.
    try {
      await redis.xgroup('CREATE', INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  });

  afterAll(async () => {
    delete process.env.INVOCATION_CLAIM_IDLE_MS;
    redis.disconnect();
    await app.close();
    await workerApp?.close();
  });

  it('GET /workers reflects a real running worker heartbeat', async () => {
    workerApp = await NestFactory.createApplicationContext(WorkerModule);

    const res = await request(app.getHttpServer()).get('/workers').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some((w: { healthy: boolean }) => w.healthy)).toBe(true);

    await workerApp.close();
    workerApp = undefined;
  });

  it('does NOT reclaim a message owned by a worker the registry still considers healthy', async () => {
    // Manufacture a message and manually deliver it to a made-up
    // consumer name, exactly like build-queue.e2e-spec.ts's proven
    // pattern - no real worker exists yet, so this delivery is
    // deterministic, not a race.
    // xadd() returns the generated message ID as a plain string - NOT an
    // array. (An earlier version of this test destructured it as `[id]`,
    // which silently grabbed just the first CHARACTER of the ID and made
    // every xpendingOwner() lookup below search for a bogus one-char ID
    // that could never match anything - a real bug this test itself
    // caught, worth remembering as its own small lesson.)
    const id = (await redis.xadd(
      INVOCATION_STREAM_KEY, '*', 'correlationId', 'unused-1', 'imageTag', imageTag,
      'event', '{}', 'timeoutMs', '3000', 'memoryMb', '128',
    )) as string;
    await redis.xreadgroup('GROUP', INVOCATION_CONSUMER_GROUP, 'slow-but-alive-worker', 'COUNT', '1', 'STREAMS', INVOCATION_STREAM_KEY, '>');

    // Register that consumer name in the registry with a FRESH
    // heartbeat - "still alive, just taking a long time on this job."
    await redis.hset(REGISTRY_KEY, 'slow-but-alive-worker', JSON.stringify({
      workerId: 'slow-but-alive-worker', capacity: 1, inFlight: 1, lastHeartbeatAt: Date.now(),
    }));

    // Start the real worker AFTER manufacturing the above, same ordering
    // reasoning as before: no race with an already-blocked consumer.
    workerApp = await NestFactory.createApplicationContext(WorkerModule);

    // Wait well past the idle threshold - long enough that a naive
    // idle-time-only reclaim (Phase 6/7's XAUTOCLAIM) would have stolen
    // this by now.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(await xpendingOwner(redis, id)).toBe('slow-but-alive-worker');

    await workerApp.close();
    workerApp = undefined;
    await redis.hdel(REGISTRY_KEY, 'slow-but-alive-worker');
    // Clean up the never-acked message so it doesn't pollute later runs.
    await redis.xack(INVOCATION_STREAM_KEY, INVOCATION_CONSUMER_GROUP, id);
  }, 15000);

  it('reclaims a message from a worker no longer in the registry (presumed dead)', async () => {
    const id = (await redis.xadd(
      INVOCATION_STREAM_KEY, '*', 'correlationId', 'unused-2', 'imageTag', imageTag,
      'event', '{}', 'timeoutMs', '3000', 'memoryMb', '128',
    )) as string;
    await redis.xreadgroup('GROUP', INVOCATION_CONSUMER_GROUP, 'presumed-dead-worker', 'COUNT', '1', 'STREAMS', INVOCATION_STREAM_KEY, '>');
    // Deliberately NOT registering 'presumed-dead-worker' anywhere - the
    // registry has never heard of it, exactly like a worker that
    // crashed before ever sending a heartbeat, or long enough ago that
    // its entry already expired from staleness.

    workerApp = await NestFactory.createApplicationContext(WorkerModule);

    const deadline = Date.now() + 10000;
    let owner: string | undefined = 'presumed-dead-worker';
    while (owner !== undefined) {
      if (Date.now() > deadline) throw new Error('Message was never reclaimed');
      await new Promise((resolve) => setTimeout(resolve, 300));
      owner = await xpendingOwner(redis, id);
    }
    // owner undefined means the message is no longer pending at all -
    // the real worker reclaimed it, executed it, and ACKed it.
  }, 20000);
});
