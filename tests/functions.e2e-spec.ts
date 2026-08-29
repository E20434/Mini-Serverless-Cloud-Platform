import 'reflect-metadata';
import { INestApplication, INestApplicationContext, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import path from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker/worker.module';
import { authHeader, createTestUser } from './test-helpers/auth';

const fn = (name: string) => path.join(__dirname, '..', 'functions', name);

/**
 * The build pipeline is genuinely asynchronous now (Phase 5's "poor
 * man's queue" - a polling worker, not a direct call) - a test can't just
 * upload a version and immediately assert success. This polls the real
 * build-status endpoint, the same way a real client/CLI would, until the
 * background worker picks the job up and finishes it.
 */
async function waitForBuildToFinish(
  app: INestApplication,
  auth: [string, string],
  name: string,
  buildId: string,
  timeoutMs = 20000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app.getHttpServer()).get(`/functions/${name}/builds/${buildId}`).set(...auth).expect(200);
    if (res.body.status === 'SUCCESS' || res.body.status === 'FAILED') {
      return res.body;
    }
    if (Date.now() > deadline) {
      throw new Error(`Build ${buildId} did not finish within ${timeoutMs}ms (last status: ${res.body.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

describe('Functions API (e2e)', () => {
  let app: INestApplication;
  // Since Phase 7, invocations require a real Worker to actually
  // complete - the API process no longer touches Docker at all for
  // invoke. This is a SEPARATE Nest application context (its own DI
  // container, its own Redis connections), deliberately not sharing
  // anything with `app` except the physical Redis server both connect
  // to - the same architectural boundary a real second OS process would
  // have, just co-located in this test process for convenience/speed.
  let workerApp: INestApplicationContext;
  let auth: [string, string];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    workerApp = await NestFactory.createApplicationContext(WorkerModule);

    // A brand-new, uniquely-emailed user per test-file run - as of Phase
    // 9, function names are unique PER USER, so a fresh tenant here means
    // no possible collision with leftover data from a previous run.
    // There's nothing left to clean up the way prisma.function.deleteMany()
    // used to - multi-tenancy fixed that for free.
    const { token } = await createTestUser(app);
    auth = authHeader(token);
  });

  afterAll(async () => {
    await app.close();
    await workerApp.close();
  });

  it('registers, lists, and fetches a function', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'hello' }).expect(201);

    const list = await request(app.getHttpServer()).get('/functions').set(...auth).expect(200);
    expect(list.body.map((record: { name: string }) => record.name)).toContain('hello');

    await request(app.getHttpServer()).get('/functions/hello').set(...auth).expect(200);
  });

  it('rejects an unauthenticated request with 401, before it ever reaches the service', async () => {
    await request(app.getHttpServer()).get('/functions').expect(401);
    await request(app.getHttpServer()).get('/functions').set('Authorization', 'Bearer not-a-real-token').expect(401);
  });

  it("returns 404 for a function belonging to a DIFFERENT user - the actual point of Phase 9", async () => {
    // A second, completely separate tenant.
    const { token: otherToken } = await createTestUser(app);
    const otherAuth = authHeader(otherToken);

    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'private-to-user-one' }).expect(201);

    // User two cannot see it, fetch it, or invoke it - it looks
    // EXACTLY like it doesn't exist, not like a permissions error. That
    // indistinguishability is deliberate: confirming "this name exists,
    // you just can't touch it" would itself leak information.
    await request(app.getHttpServer()).get('/functions/private-to-user-one').set(...otherAuth).expect(404);
    await request(app.getHttpServer()).post('/functions/private-to-user-one/invoke').set(...otherAuth).send({}).expect(404);
    const otherList = await request(app.getHttpServer()).get('/functions').set(...otherAuth).expect(200);
    expect(otherList.body).toHaveLength(0);
  });

  it('two different users can each register a function with the SAME name', async () => {
    const { token: otherToken } = await createTestUser(app);
    const otherAuth = authHeader(otherToken);

    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'shared-name' }).expect(201);
    // Would have been a 409 under Phase 4-8's global `name @unique` -
    // this is the schema change from Part 4's Phase 4 interview answers,
    // finally real.
    await request(app.getHttpServer()).post('/functions').set(...otherAuth).send({ name: 'shared-name' }).expect(201);
  });

  it('rejects registering the same name twice for the SAME user with 409 - a platform-level conflict', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'dup' }).expect(201);
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'dup' }).expect(409);
  });

  it('rejects an invalid function name at the validation layer, before it reaches the service', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'not a valid name!' }).expect(400);
  });

  it('returns 404 invoking an unknown function - platform-level, never touches a container', async () => {
    await request(app.getHttpServer()).post('/functions/does-not-exist/invoke').set(...auth).send({}).expect(404);
  });

  it('returns 409 invoking a function with no built version yet - a distinct platform-level state', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'never-deployed' }).expect(201);
    const res = await request(app.getHttpServer()).post('/functions/never-deployed/invoke').set(...auth).send({}).expect(409);
    expect(res.body.message).toMatch(/no built version/);
  });

  it('uploads source, builds a real image asynchronously, and invokes the resulting version', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'hello-built' }).expect(201);

    const upload = await request(app.getHttpServer())
      .post('/functions/hello-built/versions')
      .set(...auth)
      .attach('source', fn('hello.js'))
      .expect(201);
    expect(upload.body.status).toBe('PENDING');

    const build = await waitForBuildToFinish(app, auth, 'hello-built', upload.body.buildId);
    expect(build.status).toBe('SUCCESS');
    expect(build.imageTag).toMatch(/^mini-cloud-fn-hello-built:1$/);

    const versions = await request(app.getHttpServer()).get('/functions/hello-built/versions').set(...auth).expect(200);
    expect(versions.body).toHaveLength(1);
    expect(versions.body[0].versionNumber).toBe(1);

    const invokeRes = await request(app.getHttpServer())
      .post('/functions/hello-built/invoke')
      .set(...auth)
      .send({ name: 'Ada' })
      .expect(200);
    expect(invokeRes.body.result).toEqual({ message: 'Hello, Ada!' });
    expect(invokeRes.headers['x-function-error']).toBeUndefined();
  }, 30000);

  it('a second upload creates version 2, and invoke automatically runs the newest version', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'versioned' }).expect(201);

    const v1 = await request(app.getHttpServer())
      .post('/functions/versioned/versions')
      .set(...auth)
      .attach('source', fn('hello.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'versioned', v1.body.buildId);

    const v2 = await request(app.getHttpServer())
      .post('/functions/versioned/versions')
      .set(...auth)
      .attach('source', fn('sync.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'versioned', v2.body.buildId);

    const versions = await request(app.getHttpServer()).get('/functions/versioned/versions').set(...auth).expect(200);
    expect(versions.body.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([1, 2]);

    // sync.js (version 2) should run, not hello.js (version 1) - "newest
    // successfully built version wins" from FunctionsService.invoke.
    const invokeRes = await request(app.getHttpServer()).post('/functions/versioned/invoke').set(...auth).send({}).expect(200);
    expect(invokeRes.body.result).toEqual({ message: 'I am not async, but I still work' });
  }, 45000);

  // NOTE: there is deliberately no e2e test for a build FAILING here.
  // With no dependency installation (no npm install support yet), a
  // COPY-only Dockerfile has no realistic user-triggerable way to fail -
  // any bytes we upload become valid `docker build` input regardless of
  // whether they're valid JS (that only matters at RUN time, a Phase 1
  // concern). The FAILED path in build.service.ts's try/catch is real
  // and worth a unit test with a mocked dockerBuild() rejection, but an
  // honest e2e case doesn't exist until dependency installation gives
  // failure a real trigger.

  it('returns 200 + X-Function-Error for a function-level failure, never a 5xx', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'throws-e2e' }).expect(201);

    const upload = await request(app.getHttpServer())
      .post('/functions/throws-e2e/versions')
      .set(...auth)
      .attach('source', fn('throws.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'throws-e2e', upload.body.buildId);

    const res = await request(app.getHttpServer()).post('/functions/throws-e2e/invoke').set(...auth).send({}).expect(200);

    expect(res.headers['x-function-error']).toBe('Unhandled');
    expect(res.body.errorMessage).toMatch(/Something went wrong/);
  }, 30000);

  it('returns 503 immediately (Phase 8 backpressure) when no worker is available at all', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'no-worker-e2e' }).expect(201);
    const upload = await request(app.getHttpServer())
      .post('/functions/no-worker-e2e/versions')
      .set(...auth)
      .attach('source', fn('hello.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'no-worker-e2e', upload.body.buildId);

    // Kill the ONLY worker. This must be the last test in the file -
    // every invoke test after this point would fail for the wrong
    // reason (no worker at all) rather than the reason it's meant to
    // test. Closing it triggers WorkerService's graceful
    // onModuleDestroy, which deregisters it - so the registry reflects
    // zero workers immediately, and this request fails FAST via Phase
    // 8's backpressure check rather than waiting out a dispatch timeout.
    await workerApp.close();

    const start = Date.now();
    const res = await request(app.getHttpServer()).post('/functions/no-worker-e2e/invoke').set(...auth).send({}).expect(503);
    expect(Date.now() - start).toBeLessThan(2000); // fast failure, not a multi-second dispatch-timeout wait
    expect(res.body.message).toMatch(/no worker.*spare capacity/i);
  }, 15000);
});
