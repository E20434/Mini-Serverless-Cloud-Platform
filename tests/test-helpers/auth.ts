import crypto from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ALL_SCOPES } from '../../src/auth/scopes';

/**
 * Registers a fresh, uniquely-emailed test user against the given app and
 * logs in, returning a Bearer token with every scope (a real logged-in
 * account, not a scope-limited API key). Every e2e file gets its own
 * isolated tenant this way - no cross-file or cross-run collisions on
 * email uniqueness, and no reliance on cleaning up a shared fixture user.
 */
export async function createTestUser(app: INestApplication): Promise<{ email: string; token: string }> {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const password = 'correct horse battery staple';

  await request(app.getHttpServer()).post('/auth/register').send({ email, password }).expect(201);
  const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(200);

  return { email, token: login.body.accessToken as string };
}

export function authHeader(token: string): [string, string] {
  return ['Authorization', `Bearer ${token}`];
}

// Re-exported so tests asserting on scope behavior don't have to
// duplicate the literal list.
export { ALL_SCOPES };
