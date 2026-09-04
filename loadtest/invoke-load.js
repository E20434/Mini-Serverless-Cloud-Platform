/**
 * Load test: many virtual users repeatedly invoking ONE already-deployed
 * function. Deploying happens once, in setup() - not per VU - because
 * this test measures the INVOKE path's behavior under concurrency, not
 * the build pipeline's. Mixing the two would make it impossible to tell
 * which subsystem a slowdown actually came from.
 *
 * Honest framing before you run this: this system's worker capacity is
 * hardcoded to 1 concurrent execution per worker process (Phase 8).
 * Unless you've started more than one `npm run start:worker`, this test
 * is EXPECTED to produce a high rate of 503s the moment VUs exceed 1 -
 * that's Phase 8's backpressure check doing exactly its job, not a bug.
 * Run this once against a single worker, then again after starting
 * several more, and compare - the difference IS the point of the test.
 *
 * Run: k6 run loadtest/invoke-load.js
 * Run against a scaled fleet: k6 run -e VUS=20 loadtest/invoke-load.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TARGET_VUS = Number(__ENV.VUS || 10);

// Custom metrics, alongside k6's built-in http_req_duration/http_req_failed -
// these separate "the platform rejected this outright" (backpressure)
// from "the platform ran it and it succeeded/failed" (a function outcome),
// the exact platform-vs-function-error distinction from Part 3/Phase 3.
const successes = new Counter('invoke_success');
const backpressureRejections = new Counter('invoke_503_backpressure');
const successLatency = new Trend('invoke_success_duration_ms');

export const options = {
  stages: [
    { duration: '10s', target: TARGET_VUS }, // ramp up
    { duration: '30s', target: TARGET_VUS }, // hold
    { duration: '10s', target: 0 }, // ramp down
  ],
  thresholds: {
    // Deliberately NOT thresholding on overall error rate - with
    // capacity=1, a high 503 rate under real concurrency is the
    // EXPECTED, correct behavior being measured, not a failure. We DO
    // gate on latency for requests that actually got to run.
    invoke_success_duration_ms: ['p(95)<3000'],
  },
};

export function setup() {
  const email = `loadtest-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';

  http.post(`${BASE_URL}/auth/register`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const login = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const token = login.json('accessToken');
  const auth = { Authorization: `Bearer ${token}` };

  http.post(`${BASE_URL}/functions`, JSON.stringify({ name: 'loadtest-fn', timeoutMs: 3000 }), {
    headers: { ...auth, 'Content-Type': 'application/json' },
  });

  const source = 'exports.handler = async () => ({ message: "load test ok" });\n';
  const upload = http.post(
    `${BASE_URL}/functions/loadtest-fn/versions`,
    { source: http.file(source, 'handler.js', 'text/javascript') },
    { headers: auth },
  );
  const buildId = upload.json('buildId');

  let status = 'PENDING';
  for (let i = 0; i < 40 && status !== 'SUCCESS' && status !== 'FAILED'; i++) {
    sleep(0.5);
    const buildRes = http.get(`${BASE_URL}/functions/loadtest-fn/builds/${buildId}`, { headers: auth });
    status = buildRes.json('status');
  }
  if (status !== 'SUCCESS') {
    throw new Error(`Setup failed: build did not succeed (status: ${status})`);
  }

  return { auth };
}

export default function (data) {
  const res = http.post(`${BASE_URL}/functions/loadtest-fn/invoke`, JSON.stringify({}), {
    headers: { ...data.auth, 'Content-Type': 'application/json' },
  });

  if (res.status === 200) {
    successes.add(1);
    successLatency.add(res.timings.duration);
  } else if (res.status === 503) {
    backpressureRejections.add(1);
  }

  check(res, { 'status is 200 or 503 - never a 5xx surprise': (r) => r.status === 200 || r.status === 503 });
}
