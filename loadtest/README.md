# Load Testing (Phase 11)

Uses [k6](https://k6.io/). Install via `winget install GrafanaLabs.k6` (Windows) or see k6.io for other platforms.

## Scripts

- `smoke.js` — 1 VU, one full pass through register → login → deploy → invoke. Run this before any real load test; if it fails, a load test's results are meaningless noise.
- `invoke-load.js` — ramps to `VUS` concurrent virtual users (default 10) repeatedly invoking one pre-deployed function. Deploys once in `setup()`, not per VU, so the test measures the **invoke** path specifically, not the build pipeline.

```
k6 run loadtest/smoke.js
k6 run -e VUS=10 loadtest/invoke-load.js
k6 run -e BASE_URL=http://localhost:3000 -e VUS=20 loadtest/invoke-load.js
```

Requires the API, at least one Worker, and the docker-compose infra (Postgres/Redis/MinIO) all running.

## What running this actually found (2026-08-30)

**With 1 worker (capacity=1, per Phase 8's honest default), 10 concurrent VUs for 50s:**

| | |
|---|---|
| Success rate | 40.4% (55/136) |
| Backpressure/timeout rate | 59.6% (81/136) |
| p95 latency (successful requests) | 7738ms |

**Identical test, 5 workers, no code changes:**

| | |
|---|---|
| Success rate | 93.7% (104/111) |
| Backpressure/timeout rate | 6.3% (7/111) |
| p95 latency (successful requests) | 4678ms |

The remaining ~4.7s p95 with 5 workers is dominated by real per-invocation Docker cold-start cost (Phase 2 - there is still no warm container pool), not queueing. That's the honest next bottleneck a real Scaling phase would target.

## A real bug this test found, not hypothesized

The first run's numbers looked odd: many "successful" requests took 3.5-8s, right up against the 8-second dispatch timeout - not what a clean, fast backpressure rejection should look like. Digging in with `redis-cli XINFO GROUPS invocations:pending` while a scaled-down repro ran showed why: `FunctionsService`'s backpressure check (`WorkerRegistryService.hasSpareCapacity()`) reads each worker's **last heartbeat snapshot**, refreshed only every 3 seconds - not the worker's true instantaneous state. A burst of concurrent requests arriving within the same 3-second window can all observe the same stale "capacity available" snapshot and get admitted together, overwhelming the one real worker instead of being cleanly rejected up front. Most eventually got served (or timed out) via the dispatch-timeout path rather than the fast backpressure path - explaining both the high failure rate AND the surprisingly slow successes. A tighter fix (an atomically-reserved capacity counter, incremented at dispatch time rather than read from a periodic snapshot) is a legitimate, scoped enhancement for a future Scheduler-hardening or Autoscaling pass - not fixed here, but now a known, documented, load-test-verified limitation instead of a guess.

A second, smaller bug **was** fixed immediately, because it was cheap and clearly wrong: `mini_cloud_invocation_queue_depth` (Phase 10) was computed via `XLEN`, which counts a Redis Stream's entire history and never shrinks as messages are consumed - a monotonically growing number, useless as a "current backlog" gauge. Fixed to use the consumer group's `lag` (via `XINFO GROUPS`) - entries added to the stream that have never been delivered to any worker at all, which is what "queue depth" actually means. Confirmed live: it now rises to 3-4 during a real burst and drains back to 0 afterward, instead of climbing forever.

A third, operational finding: running multiple workers on one host with a single hardcoded `WORKER_METRICS_PORT` crashed every worker after the first with an unhandled `EADDRINUSE` - an **uncaught exception on the metrics side-channel was taking down real invocation-processing capacity**, violating the same "observability must be a soft dependency" principle held since Phase 1's logging design. Fixed by catching the server's `error` event and logging a warning instead of crashing; a real deployment would instead give each worker its own port or its own container/host entirely.
