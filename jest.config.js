/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.e2e-spec.ts'],
  // dotenv/config loads DATABASE_URL from .env before anything else runs -
  // Jest, unlike `node --env-file`, has no built-in .env support.
  setupFiles: ['dotenv/config', 'reflect-metadata'],
  // Container cold starts (Phase 3's e2e suite spins up real Docker
  // containers) comfortably exceed Jest's 5000ms default per-test timeout.
  testTimeout: 20000,
  // Every e2e file boots its own full Nest app against the SAME shared
  // Postgres/MinIO/Redis - and since Phase 6, each of those apps also
  // starts a BuildStreamConsumerService hardcoded to the same consumer
  // name ('build-worker-1') reading the same physical Redis stream.
  // Running test files in parallel Jest workers turns that into a real
  // cross-PROCESS race for message delivery - caught directly by
  // build-queue.e2e-spec.ts's reclaim test flaking under concurrent load
  // (a different process's already-blocked consumer occasionally won
  // delivery of a message this test needed to control precisely). This
  // is the exact scenario the "each real worker needs a unique consumer
  // name" comment in build-stream.constants.ts already calls out as a
  // Phase 7 problem - it just arrived one phase early, via the test
  // suite instead of production. Fix: serialize test files so only one
  // app/consumer is ever alive at a time. Trades suite wall-clock time
  // for determinism against shared external state - a normal, common
  // tradeoff for integration suites hitting real shared infrastructure.
  maxWorkers: 1,
  // functions/hangs.js deliberately leaks a live setInterval to simulate a
  // real stuck process (see the comment in that file). Phase 1's executor
  // has no isolation boundary, so that leaked timer survives in THIS same
  // process after the test finishes - Jest would otherwise hang forever
  // waiting for it. forceExit is a test-runner workaround, not a fix: it's
  // standing proof that Phase 1 cannot reclaim a leaked resource, which is
  // exactly the problem Phase 2's container boundary solves for real.
  forceExit: true,
};
