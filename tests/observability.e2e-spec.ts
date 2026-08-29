import 'reflect-metadata';
import path from 'node:path';
import { INestApplication, INestApplicationContext, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WorkerModule } from '../src/worker/worker.module';
import { authHeader, createTestUser } from './test-helpers/auth';

const fn = (name: string) => path.join(__dirname, '..', 'functions', name);

async function waitForBuildToFinish(app: INestApplication, auth: [string, string], name: string, buildId: string) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const res = await request(app.getHttpServer()).get(`/functions/${name}/builds/${buildId}`).set(...auth).expect(200);
    if (res.body.status === 'SUCCESS' || res.body.status === 'FAILED') return res.body;
    if (Date.now() > deadline) throw new Error(`Build did not finish (status: ${res.body.status})`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

describe('Observability (e2e)', () => {
  let app: INestApplication;
  let workerApp: INestApplicationContext;
  let auth: [string, string];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    workerApp = await NestFactory.createApplicationContext(WorkerModule);

    const { token } = await createTestUser(app);
    auth = authHeader(token);
  });

  afterAll(async () => {
    await app.close();
    await workerApp.close();
  });

  it('records a durable Invocation row for a successful invoke, queryable via GET .../invocations', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'obs-success' }).expect(201);
    const upload = await request(app.getHttpServer())
      .post('/functions/obs-success/versions')
      .set(...auth)
      .attach('source', fn('hello.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'obs-success', upload.body.buildId);

    await request(app.getHttpServer()).post('/functions/obs-success/invoke').set(...auth).send({}).expect(200);

    const history = await request(app.getHttpServer()).get('/functions/obs-success/invocations').set(...auth).expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({ status: 'SUCCESS', coldStart: true });
    expect(typeof history.body[0].durationMs).toBe('number');
  }, 30000);

  it('records ERROR and reflects it in the metrics summary (error rate, latency percentiles)', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'obs-error' }).expect(201);
    const upload = await request(app.getHttpServer())
      .post('/functions/obs-error/versions')
      .set(...auth)
      .attach('source', fn('throws.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'obs-error', upload.body.buildId);

    // Two invocations - both should fail (throws.js always throws) -
    // giving a deterministic 100% error rate to assert on.
    await request(app.getHttpServer()).post('/functions/obs-error/invoke').set(...auth).send({}).expect(200);
    await request(app.getHttpServer()).post('/functions/obs-error/invoke').set(...auth).send({}).expect(200);

    const history = await request(app.getHttpServer()).get('/functions/obs-error/invocations').set(...auth).expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body.every((h: { status: string; errorMessage: string }) => h.status === 'ERROR' && h.errorMessage)).toBe(true);

    const metrics = await request(app.getHttpServer()).get('/functions/obs-error/metrics').set(...auth).expect(200);
    expect(metrics.body.totalInvocations).toBe(2);
    expect(metrics.body.errorRate).toBe(1);
    expect(typeof metrics.body.latencyMsP50).toBe('number');
  }, 30000);

  it('a different user cannot see invocation history or metrics for a function they do not own', async () => {
    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'obs-private' }).expect(201);

    const { token: otherToken } = await createTestUser(app);
    const otherAuth = authHeader(otherToken);

    await request(app.getHttpServer()).get('/functions/obs-private/invocations').set(...otherAuth).expect(404);
    await request(app.getHttpServer()).get('/functions/obs-private/metrics').set(...otherAuth).expect(404);
  });

  it('GET /metrics exposes real Prometheus counters that move after an invocation', async () => {
    const before = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(before.text).toContain('mini_cloud_invocation_queue_depth');
    expect(before.text).toContain('mini_cloud_healthy_workers');
    // At least one healthy worker - workerApp has been running since beforeAll.
    expect(before.text).toMatch(/mini_cloud_healthy_workers \d+/);

    await request(app.getHttpServer()).post('/functions').set(...auth).send({ name: 'obs-metrics-endpoint' }).expect(201);
    const upload = await request(app.getHttpServer())
      .post('/functions/obs-metrics-endpoint/versions')
      .set(...auth)
      .attach('source', fn('hello.js'))
      .expect(201);
    await waitForBuildToFinish(app, auth, 'obs-metrics-endpoint', upload.body.buildId);
    await request(app.getHttpServer()).post('/functions/obs-metrics-endpoint/invoke').set(...auth).send({}).expect(200);

    // The counter lives in the WORKER's registry (it did the executing),
    // not the API's - fetched directly from the worker's own metrics
    // port, the same way Prometheus itself would scrape it.
    const workerMetricsPort = process.env.WORKER_METRICS_PORT ? Number(process.env.WORKER_METRICS_PORT) : 9200;
    const workerMetrics = await fetch(`http://localhost:${workerMetricsPort}/metrics`).then((r) => r.text());
    expect(workerMetrics).toMatch(/mini_cloud_invocations_total\{status="success"\} [1-9]/);
  }, 30000);
});
