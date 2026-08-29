import 'reflect-metadata';
import crypto from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const freshEmail = () => `auth-test-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  it('registers and logs in, returning a usable access token', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    expect(typeof login.body.accessToken).toBe('string');

    // The token actually works against a real protected route.
    await request(app.getHttpServer())
      .get('/functions')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
  });

  it('rejects registering the same email twice with 409', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(409);
  });

  it('rejects login with the wrong password, and with an unknown email, identically', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'not the right password' })
      .expect(401);
    const unknownEmail = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: freshEmail(), password })
      .expect(401);

    // Deliberately the SAME message for both - see auth.service.ts:
    // telling "wrong password" apart from "no such account" would let an
    // attacker enumerate registered emails.
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it('creates an API key, uses it to authenticate, and never returns its hash or raw value again', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const jwt = login.body.accessToken;

    const created = await request(app.getHttpServer())
      .post('/auth/api-keys')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ name: 'ci-key', scopes: ['functions:read', 'functions:invoke'] })
      .expect(201);
    expect(created.body.rawKey).toMatch(/^mc_[0-9a-f]{48}$/);

    // The raw key itself authenticates, standing in for the JWT.
    await request(app.getHttpServer())
      .get('/functions')
      .set('Authorization', `Bearer ${created.body.rawKey}`)
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/auth/api-keys')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    const listedKey = list.body.find((k: { id: string }) => k.id === created.body.id);
    expect(listedKey).toBeDefined();
    expect(listedKey.rawKey).toBeUndefined();
    expect(listedKey.keyHash).toBeUndefined();
  });

  it('enforces scopes: a read+invoke-only key cannot create a function (403), but can still list (200)', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);

    const created = await request(app.getHttpServer())
      .post('/auth/api-keys')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ name: 'read-only-key', scopes: ['functions:read'] })
      .expect(201);
    const limitedAuth = ['Authorization', `Bearer ${created.body.rawKey}`] as [string, string];

    await request(app.getHttpServer()).get('/functions').set(...limitedAuth).expect(200);
    const forbidden = await request(app.getHttpServer())
      .post('/functions')
      .set(...limitedAuth)
      .send({ name: 'should-not-be-allowed' })
      .expect(403);
    expect(forbidden.body.message).toMatch(/functions:write/);
  });

  it('revoking an API key makes it stop working immediately', async () => {
    const email = freshEmail();
    await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
    const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);
    const jwtAuth = ['Authorization', `Bearer ${login.body.accessToken}`] as [string, string];

    const created = await request(app.getHttpServer())
      .post('/auth/api-keys')
      .set(...jwtAuth)
      .send({ name: 'to-be-revoked', scopes: ['functions:read'] })
      .expect(201);
    const keyAuth = ['Authorization', `Bearer ${created.body.rawKey}`] as [string, string];

    await request(app.getHttpServer()).get('/functions').set(...keyAuth).expect(200);

    await request(app.getHttpServer()).delete(`/auth/api-keys/${created.body.id}`).set(...jwtAuth).expect(204);

    await request(app.getHttpServer()).get('/functions').set(...keyAuth).expect(401);
  });
});
