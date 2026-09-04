/**
 * Smoke test: 1 virtual user, one pass through the whole deploy+invoke
 * pipeline. This exists to catch WIRING problems (wrong URL, expired
 * token, a broken build) before spending time on a real load run - if
 * this fails, the load test's results would be meaningless noise, not a
 * real signal about capacity.
 *
 * Run: k6 run loadtest/smoke.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const email = `smoke-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';

  const register = http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(register, { 'register: 201': (r) => r.status === 201 });

  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(login, { 'login: 200': (r) => r.status === 200 });
  const token = login.json('accessToken');
  const auth = { Authorization: `Bearer ${token}` };

  const register_fn = http.post(
    `${BASE_URL}/functions`,
    JSON.stringify({ name: 'smoke-fn' }),
    { headers: { ...auth, 'Content-Type': 'application/json' } },
  );
  check(register_fn, { 'create function: 201': (r) => r.status === 201 });

  const source = 'exports.handler = async () => ({ message: "smoke test ok" });\n';
  const upload = http.post(
    `${BASE_URL}/functions/smoke-fn/versions`,
    { source: http.file(source, 'handler.js', 'text/javascript') },
    { headers: auth },
  );
  check(upload, { 'upload version: 201': (r) => r.status === 201 });
  const buildId = upload.json('buildId');

  let status = 'PENDING';
  for (let i = 0; i < 40 && status !== 'SUCCESS' && status !== 'FAILED'; i++) {
    sleep(0.5);
    const buildRes = http.get(`${BASE_URL}/functions/smoke-fn/builds/${buildId}`, { headers: auth });
    status = buildRes.json('status');
  }
  check(status, { 'build succeeded': (s) => s === 'SUCCESS' });

  const invoke = http.post(
    `${BASE_URL}/functions/smoke-fn/invoke`,
    JSON.stringify({}),
    { headers: { ...auth, 'Content-Type': 'application/json' } },
  );
  check(invoke, {
    'invoke: 200': (r) => r.status === 200,
    'invoke: correct result': (r) => r.json('result.message') === 'smoke test ok',
  });
}
