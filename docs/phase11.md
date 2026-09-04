# Phase 11 — Load Testing & Horizontal Scaling

## Phase 11 Recap

Phase 11 focused on **real load testing of the platform**.

The main goal was not simply to run automated tests, but to generate **real concurrent traffic against the running system** and observe how the platform behaves under load.

The tests were performed against the **real, running stack**, not mocked or simulated components.

The phase demonstrated that:

* The invocation pipeline can be load tested independently.
* Increasing the number of Workers can significantly improve capacity.
* A real Worker bottleneck existed.
* Concurrent traffic exposed bugs that were not visible during normal testing.
* Some bugs were fixed immediately because they were clearly incorrect.
* Other findings were deliberately documented for a future hardening phase because fixing them reactively during load testing would expand the scope unnecessarily.

---

# 1. Load Testing Tools

Two load-testing scripts were created:

```text
loadtest/
├── smoke.js
└── invoke-load.js
```

---

## 1.1 `loadtest/smoke.js`

The smoke test is a basic **pipeline sanity check**.

Its purpose is to verify that the invocation pipeline works before performing a larger load test.

Conceptually:

```text
Load Test
    |
    v
smoke.js
    |
    v
Invoke Function
    |
    v
Check Response
    |
    v
Pipeline Works
```

The smoke test answers a simple question:

> "Is the system basically working before I start generating significant traffic?"

This is important because there is no point performing a large load test if the basic invocation path is already broken.

---

# 2. `loadtest/invoke-load.js`

The second script performs the actual load test:

```text
loadtest/invoke-load.js
```

This test generates **concurrent virtual users (VUs)** against a function that has already been deployed.

The important architectural decision is that the function is **pre-deployed**.

The test therefore focuses specifically on the invocation path:

```text
Client
   |
   v
API
   |
   v
Queue
   |
   v
Worker
   |
   v
Function
```

It does not repeatedly build or deploy the function while testing.

---

## Why Isolating the Invoke Path Matters

If the load test included building the function every time, it would be difficult to determine what is actually causing performance problems.

For example:

```text
Build
  +
Deploy
  +
Queue
  +
Worker
  +
Function
```

would create too many variables.

Instead, Phase 11 tests:

```text
Pre-deployed Function
        |
        v
     Invoke
        |
        v
      Queue
        |
        v
      Worker
        |
        v
    Function
```

This isolates the **invocation path**.

Therefore, if performance degrades, the investigation can focus on the runtime invocation system rather than the build pipeline.

---

# 3. What Is a Virtual User?

A Virtual User, or **VU**, represents a simulated client generating traffic.

For example:

```text
1 VU
 |
 +-- Invoke Function


10 VUs
 |
 +-- VU 1  → Invoke
 +-- VU 2  → Invoke
 +-- VU 3  → Invoke
 +-- ...
 +-- VU 10 → Invoke
```

The important point is that the requests are generated concurrently.

This allows the system to be tested under conditions that normal sequential testing cannot reproduce.

---

# 4. The Horizontal Scaling Experiment

The most important experiment compared:

```text
1 Worker
```

against:

```text
5 Workers
```

The same load was used in both cases:

```text
10 VUs
```

The application code was not changed between the two tests.

The only change was the number of Worker processes.

---

## Test A — One Worker

The first test used:

```text
10 VUs
+
1 Worker
```

Results:

```text
Success Rate: 40.4%
p95 Latency: 7.7 seconds
```

That means only about 40% of the requests completed successfully during the test.

The system was therefore clearly struggling under concurrent load.

---

# 5. Test B — Five Workers

The second test used:

```text
10 VUs
+
5 Workers
```

The Workers were started as additional:

```text
npm run start:worker
```

processes.

No application code was changed.

Results:

```text
Success Rate: 93.7%
p95 Latency: 4.7 seconds
```

This is a major improvement.

---

# 6. Comparing the Results

| Configuration | VUs | Workers | Success Rate | p95 Latency |
| ------------- | --: | ------: | -----------: | ----------: |
| Test A        |  10 |       1 |        40.4% |        7.7s |
| Test B        |  10 |       5 |        93.7% |        4.7s |

The improvement was:

```text
Success Rate
40.4%
   ↓
93.7%
```

and:

```text
p95 Latency
7.7s
   ↓
4.7s
```

So adding Workers substantially increased the system's ability to process concurrent invocations.

---

# 7. What This Proves

This experiment provides real evidence that **horizontal scaling improves the Worker bottleneck**.

The architecture can be thought of as:

```text
              Queue
                |
       +--------+--------+
       |        |        |
       v        v        v
    Worker   Worker   Worker
       |
       v
   Function
```

With only one Worker:

```text
Queue
  |
  v
Worker
  |
  +-- Job
  +-- Job
  +-- Job
  +-- Job
  +-- ...
```

The Worker becomes a bottleneck.

With five Workers:

```text
             Queue
               |
       +-------+-------+-------+-------+
       |       |       |       |       |
       v       v       v       v       v
      W1      W2      W3      W4      W5
```

Jobs can be distributed across multiple Worker processes.

Therefore:

```text
More Workers
     |
     v
More concurrent processing capacity
     |
     v
Less queueing pressure
     |
     v
Higher success rate
     |
     v
Lower tail latency
```

This is the fundamental idea behind **horizontal scaling**.

---

# 8. Why This Is Stronger Than Code Inspection

Before Phase 11, it might have been possible to look at the architecture and say:

> "The system probably has a Worker bottleneck."

But that would only be an assumption.

Phase 11 generated actual concurrent traffic.

The system was tested with:

```text
10 concurrent VUs
```

and produced measurable differences:

```text
1 Worker
→ 40.4% success
→ 7.7s p95


5 Workers
→ 93.7% success
→ 4.7s p95
```

Therefore, the bottleneck was demonstrated experimentally.

This is an important distinction:

```text
Code inspection
     |
     v
Hypothesis


Load testing
     |
     v
Measured evidence
```

---

# 9. Three Real Bugs Were Discovered

The load test discovered three real issues.

These were not merely identified by reading the source code.

They appeared when the system was subjected to **actual concurrent traffic**.

The three findings were:

1. Stale heartbeat-based backpressure
2. Incorrect queue-depth metric
3. Metrics-port collision between Workers

---

# 10. Bug #1 — Stale Heartbeat Backpressure

## The Problem

The Phase 8 backpressure mechanism checks Worker capacity using a heartbeat snapshot.

The problem is that the snapshot can be approximately **3 seconds old**.

Conceptually:

```text
Worker Capacity
      |
      v
Heartbeat
      |
      v
Capacity Snapshot
      |
      v
Scheduler
```

The Scheduler is therefore making a decision based on information that may no longer represent the Worker’s actual state.

---

# 11. Why a 3-Second Snapshot Is Dangerous

Imagine the Worker reports:

```text
Available Capacity = 10
```

The Scheduler stores that information.

But three seconds later, the real situation may be:

```text
Available Capacity = 2
```

The Scheduler may still believe:

```text
Available Capacity = 10
```

because it is using the older snapshot.

---

# 12. Burst Scenario

Suppose the Worker can safely process:

```text
10 jobs
```

The Scheduler sees:

```text
Capacity = 10
```

Then a burst of requests arrives.

Because the capacity information is stale, multiple requests can pass the backpressure check before the system gets another accurate heartbeat.

Conceptually:

```text
Heartbeat Snapshot
Capacity = 10
     |
     | 3 seconds pass
     |
     v
Real Capacity = 2
```

But the Scheduler still sees:

```text
Capacity = 10
```

and can therefore admit more work than the Worker can actually process.

---

# 13. What the Load Test Revealed

The result was that many requests did not fail quickly.

Instead, some "successful" invocations took approximately:

```text
3.5s – 8s
```

This is an important clue.

If backpressure were perfectly accurate, requests exceeding capacity could be rejected immediately.

Instead, the stale capacity information allowed too much work into the system.

That resulted in:

```text
Burst
  |
  v
Stale Capacity Snapshot
  |
  v
Too Many Jobs Admitted
  |
  v
Queue / Worker Pressure
  |
  v
Longer Latency
```

---

# 14. Why This Bug Was Not Fixed Immediately

The issue was deliberately **documented rather than patched during Phase 11**.

This was a scope decision.

The correct long-term solution is not simply to reduce the heartbeat interval or add another conditional.

The underlying problem is that a periodic snapshot is fundamentally weaker than an atomic capacity mechanism.

A proper solution would involve something like:

```text
Atomic Reserved-Capacity Counter
```

instead of relying on:

```text
Periodic Heartbeat Snapshot
```

This belongs more naturally in a future:

```text
Scheduler Hardening Phase
```

rather than being patched reactively during the load test.

---

# 15. Better Future Design — Atomic Capacity Reservation

A stronger architecture would maintain something similar to:

```text
Available Capacity
+
Reserved Capacity
=
Total Capacity
```

When a request is accepted, the system atomically reserves capacity.

Conceptually:

```text
Request
   |
   v
Atomic Reserve
   |
   +---- Success → Queue Job
   |
   +---- Failure → Reject Immediately
```

This prevents multiple concurrent requests from all believing that the same capacity is available.

The important word is:

> **Atomic**

The reservation operation must happen as one indivisible operation so concurrent requests cannot over-admit work.

---

# 16. Bug #2 — Incorrect Queue Depth Metric

The second bug was found in the Phase 10 Prometheus metric:

```text
mini_cloud_invocation_queue_depth
```

The metric was intended to represent the current number of queued invocations.

However, it was calculated using:

```text
XLEN
```

---

# 17. Why `XLEN` Was Wrong

The queue uses a Redis Stream.

A Stream contains messages that have been added over time.

`XLEN` represents the number of entries currently stored in the Stream.

It does **not** represent:

> "How many messages are currently waiting to be processed?"

This distinction is extremely important.

---

# 18. Example of the Problem

Suppose the system receives:

```text
Job 1
Job 2
Job 3
```

The Stream contains:

```text
Job 1
Job 2
Job 3
```

So:

```text
XLEN = 3
```

Now the Workers process all three jobs.

The queue has no unprocessed work.

But unless those Stream entries are deleted, the Stream still contains:

```text
Job 1
Job 2
Job 3
```

Therefore:

```text
XLEN = 3
```

even though:

```text
Actual pending work = 0
```

---

# 19. Why This Makes the Metric Incorrect

The metric was intended to represent:

```text
Current Queue Depth
```

But `XLEN` effectively represented:

```text
Total Stream Entries
```

which does not necessarily decrease as jobs are consumed.

Therefore:

```text
XLEN ≠ Current Backlog
```

---

# 20. The Fix — Consumer Group Lag

The metric was changed to use the Redis consumer group's:

```text
lag
```

Lag is much closer to the concept required here:

```text
How much work remains to be consumed?
```

Conceptually:

```text
Redis Stream
      |
      v
Consumer Group
      |
      v
Lag
      |
      v
Pending / Unconsumed Work
```

---

# 21. Live Verification of the Queue Metric

The fix was not merely made based on code inspection.

It was confirmed using a real burst of traffic.

During the burst:

```text
Traffic increases
       |
       v
Queue backlog increases
       |
       v
Lag increases
```

As Workers process the jobs:

```text
Workers consume jobs
       |
       v
Backlog decreases
       |
       v
Lag decreases
```

Therefore, the metric now behaves as expected:

```text
Burst
  ↓
Lag rises
  ↓
Workers process
  ↓
Lag drains
```

This is what a useful queue-depth metric should do.

---

# 22. Why Bug #2 Was Fixed Immediately

This bug was considered:

```text
Cheap to fix
+
Unambiguously incorrect
```

The metric was simply measuring the wrong thing.

Unlike the backpressure issue, there was no large architectural decision required.

Therefore, it was appropriate to fix it immediately during Phase 11.

---

# 23. Bug #3 — Worker Metrics Port Collision

The third bug involved the Worker metrics server.

Each Worker exposes Prometheus metrics through a metrics port.

Originally, multiple Workers attempted to use the same hardcoded port.

For example:

```text
Worker 1 → Port 9100
Worker 2 → Port 9100
Worker 3 → Port 9100
Worker 4 → Port 9100
Worker 5 → Port 9100
```

Only one process can normally bind to a particular IP/port combination.

---

# 24. What Happened

The first Worker successfully started:

```text
Worker 1
   |
   v
Port 9100
   |
   v
SUCCESS
```

Then another Worker attempted:

```text
Worker 2
   |
   v
Port 9100
   |
   v
EADDRINUSE
```

`EADDRINUSE` means:

```text
Address already in use
```

The port was already occupied by another process.

---

# 25. Why This Was More Serious Than a Metrics Problem

At first glance, this might look like a simple observability problem:

```text
Metrics unavailable
```

But the original behavior caused the Worker itself to crash.

That creates:

```text
Metrics Port Collision
       |
       v
Unhandled EADDRINUSE
       |
       v
Worker Crashes
       |
       v
Processing Capacity Decreases
```

This means an **observability side-channel was able to take down actual processing capacity**.

That is dangerous.

---

# 26. Observability Should Be a Soft Dependency

Monitoring should ideally never be capable of destroying the main application.

The principle is:

```text
Application Processing
        |
        +---- Primary Functionality
        |
        +---- Observability
```

If observability fails:

```text
Metrics Failure
      |
      v
Log Warning
      |
      v
Application Continues
```

rather than:

```text
Metrics Failure
      |
      v
Application Crashes
```

This follows the same **soft-dependency principle** established earlier in the project's logging design.

---

# 27. The Fix

The metrics-port collision behavior was changed.

Instead of allowing:

```text
EADDRINUSE
    |
    v
Worker Crash
```

the Worker now handles the collision gracefully:

```text
EADDRINUSE
    |
    v
Log Warning
    |
    v
Worker Continues Running
```

Therefore, a metrics problem no longer destroys the Worker.

---

# 28. Why This Fix Matters During Horizontal Scaling

This bug became particularly important because Phase 11 intentionally runs multiple Workers.

For example:

```text
Worker 1
Worker 2
Worker 3
Worker 4
Worker 5
```

Horizontal scaling means starting multiple processes.

If each process assumes it owns the same metrics port, scaling itself can cause failures.

Therefore:

```text
Horizontal Scaling
       |
       v
Multiple Workers
       |
       v
Metrics Port Collision
```

could completely undermine the scaling experiment.

The fix makes the monitoring layer more resilient.

---

# 29. Three Bugs — Summary

| Bug                    | Cause                                     | Impact                                           | Action                                    |
| ---------------------- | ----------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| Stale backpressure     | 3-second-old heartbeat snapshot           | Burst can over-admit work and cause long latency | Documented for future Scheduler hardening |
| Incorrect queue depth  | Used `XLEN` instead of consumer-group lag | Queue metric did not represent actual backlog    | Fixed immediately                         |
| Metrics port collision | Every Worker used same hardcoded port     | Worker crashed with `EADDRINUSE`                 | Fixed immediately                         |

---

# 30. Why Load Testing Was Necessary

These bugs demonstrate why load testing needs to be treated as its own engineering phase.

Normal tests may verify:

```text
One request
     |
     v
Expected response
```

But load testing introduces:

```text
Many requests
      |
      +---- Concurrent execution
      +---- Queue pressure
      +---- Capacity races
      +---- Multiple Workers
      +---- Metrics pressure
      +---- Timing issues
```

Distributed systems often behave differently under concurrency than they do under sequential testing.

---

# 31. What Could Not Be Seen Easily Without Load

The stale heartbeat problem depends on timing:

```text
Heartbeat
    ↓
Time passes
    ↓
Burst arrives
    ↓
Capacity changes
```

The queue metric problem becomes obvious when:

```text
Burst
    ↓
Queue grows
    ↓
Workers drain queue
```

The metrics-port problem appears when:

```text
Worker 1 starts
Worker 2 starts
Worker 3 starts
...
```

Therefore, these issues are strongly associated with the conditions created by real load testing.

---

# 32. How This Relates to AWS Lambda

These findings are representative of the kinds of problems large serverless platforms must deal with internally.

A system like AWS Lambda has to handle issues involving:

```text
Concurrency
Capacity
Backpressure
Queues
Worker Pools
Retries
Metrics
Distributed State
Burst Traffic
```

The specific implementation here is obviously much smaller than AWS Lambda, but the **class of engineering problems is similar**.

For example:

```text
Burst Traffic
     |
     v
Capacity Decision
     |
     +---- Race Conditions
     |
     +---- Queue Backlog
     |
     +---- Worker Scaling
     |
     +---- Metrics Accuracy
```

These are not glamorous problems, but they are fundamental distributed-systems problems.

---

# 33. Why Load Testing Is Its Own Phase

The Phase 11 experience demonstrates the reason load testing should not simply be treated as:

```text
"Run some tests at the end."
```

Instead:

```text
Development
    |
    v
Functional Testing
    |
    v
Integration Testing
    |
    v
Load Testing
    |
    v
Hardening
```

Each stage discovers different classes of problems.

Functional tests answer:

> "Does it work?"

Load tests answer:

> "Does it continue to work when many things happen at the same time?"

---

# 34. What Is Still Missing?

Phase 11 did not attempt unlimited stress testing.

The following tests were not performed:

```text
100 VUs
1,000 VUs
10,000 VUs
```

This is considered reasonable at the current scale.

---

# 35. Why 100/1,000/10,000 VU Tests Were Not Necessary Yet

The 1-vs-5 Worker experiment already demonstrated the dominant bottleneck.

The results changed dramatically:

```text
1 Worker
40.4% success
7.7s p95


5 Workers
93.7% success
4.7s p95
```

This clearly showed that Worker processing capacity was a major limiting factor.

Running increasingly large tests immediately would likely produce more of the same evidence without answering a new architectural question.

Therefore, the decision was to stop rather than generate large amounts of additional load without a clear purpose.

---

# 36. Future Stress Testing

A future stress-testing phase could progressively increase load:

```text
10 VUs
   ↓
50 VUs
   ↓
100 VUs
   ↓
500 VUs
   ↓
1,000 VUs
   ↓
10,000 VUs
```

At each level, metrics such as these could be monitored:

```text
Success Rate
p50
p95
p99
Queue Lag
Worker CPU
Worker Memory
API CPU
API Memory
Database Load
Redis Load
```

This would allow the true system capacity to be measured.

---

# 37. Resource Exhaustion Is Also Still Missing

Another area not fully tested is what happens when even five Workers are insufficient.

For example:

```text
Traffic
   |
   v
5 Workers
   |
   v
Capacity Exhausted
   |
   v
What happens?
```

Questions that remain for future testing include:

* What happens when all Workers are saturated?
* Does the queue continue growing?
* Does backpressure reject requests?
* Does latency increase indefinitely?
* Does memory usage remain stable?
* Does CPU reach saturation?
* Do Workers crash?
* Does Redis become the bottleneck?
* Does PostgreSQL become the bottleneck?
* Does the API become the bottleneck?
* What happens when the Docker daemon itself becomes saturated?

---

# 38. Docker / Host Resource Exhaustion

The system has another possible bottleneck:

```text
Docker / Host
```

Even if the application is architecturally capable of running many Workers, the physical machine has finite resources.

For example:

```text
CPU
RAM
Disk
Network
Docker daemon
```

Eventually:

```text
More Workers
      |
      v
More Resource Usage
      |
      v
Host Saturation
      |
      v
Performance Degradation
```

This should be tested in a future phase.

---

# 39. Recommended Future Sequence

A logical progression would be:

```text
Phase 11
Load Testing
     |
     v
Identify Bottlenecks
     |
     v
Scheduler Hardening
     |
     v
Fix Atomic Capacity Reservation
     |
     v
Stress Testing
     |
     v
Resource Exhaustion Testing
```

In particular, the stale heartbeat issue should be addressed before attempting extremely aggressive stress tests.

---

# 40. Final Architecture After Phase 11

The system can now be visualized as:

```text
                         Client
                           |
                           v
                    +-------------+
                    |     API     |
                    +------+------+
                           |
                           v
                    +-------------+
                    |   Queue     |
                    | Redis/SQS   |
                    +------+------+
                           |
             +-------------+-------------+
             |             |             |
             v             v             v
         +-------+     +-------+     +-------+
         |Worker |     |Worker |     |Worker |
         |   1   |     |   2   | ... |   5   |
         +---+---+     +---+---+     +---+---+
             |             |             |
             +-------------+-------------+
                           |
                           v
                    Function Execution
```

Prometheus observes the system separately:

```text
API
 |
 +---- /metrics
 |
 v
Prometheus


Worker 1
 |
 +---- /metrics
 |
 v
Prometheus


Worker 2
 |
 +---- /metrics
 |
 v
Prometheus


...
```

Monitoring failures should not stop processing:

```text
Metrics Failure
      |
      v
Warning
      |
      v
Worker Continues
```

---

# 41. Final Phase 11 Results

## Load Testing

```text
10 VUs
```

### One Worker

```text
Success Rate: 40.4%
p95 Latency: 7.7s
```

### Five Workers

```text
Success Rate: 93.7%
p95 Latency: 4.7s
```

This provides real evidence that horizontal Worker scaling improves the system's capacity.

---

# 42. Bugs Discovered

### Bug 1 — Stale Backpressure

```text
Cause:
3-second-old heartbeat snapshot

Result:
Burst traffic could be over-admitted

Observed:
Some successful requests took 3.5–8 seconds

Decision:
Documented for future Scheduler hardening
```

---

### Bug 2 — Incorrect Queue Depth

```text
Cause:
Used Redis XLEN

Problem:
XLEN represents Stream entries, not current backlog

Fix:
Use consumer-group lag

Verification:
Lag increased during a real burst and drained as Workers processed jobs
```

---

### Bug 3 — Metrics Port Collision

```text
Cause:
All Workers used the same hardcoded metrics port

Result:
EADDRINUSE crashed additional Workers

Fix:
Metrics-port collision now produces a warning instead of terminating the Worker
```

---

# 43. Key Engineering Lessons

## Lesson 1 — Concurrency Exposes Different Bugs

A system that works correctly for one request may behave differently when many requests arrive simultaneously.

```text
Sequential Execution
        |
        v
Looks Correct


Concurrent Execution
        |
        v
Race Conditions
Capacity Problems
Queue Pressure
```

---

## Lesson 2 — Scaling Can Be Demonstrated Experimentally

Rather than claiming:

> "Multiple Workers should improve performance."

The test demonstrated it:

```text
1 Worker
40.4% success
7.7s p95

        ↓

5 Workers
93.7% success
4.7s p95
```

This is measured evidence.

---

## Lesson 3 — Metrics Must Represent the Correct Thing

A metric can exist and still be wrong.

For example:

```text
Metric:
mini_cloud_invocation_queue_depth
```

If it uses:

```text
XLEN
```

it may not represent:

```text
Actual Queue Backlog
```

The correct metric must match the actual system concept being measured.

---

## Lesson 4 — Observability Must Not Become a Failure Dependency

Monitoring should help the system rather than become a reason for the system to fail.

Bad:

```text
Metrics Server
     |
     X
Port Collision
     |
     X
Worker Crash
```

Better:

```text
Metrics Server
     |
     X
Port Collision
     |
     v
Warning
     |
     v
Worker Continues
```

---

## Lesson 5 — Not Every Finding Needs an Immediate Fix

The stale heartbeat issue is a good example.

It was identified and understood, but fixing it properly requires a broader Scheduler-hardening design.

Therefore:

```text
Finding
   |
   v
Understand Root Cause
   |
   v
Determine Scope
   |
   +---- Small + Clearly Wrong → Fix Now
   |
   +---- Architectural Change → Document for Future Phase
```

This prevents uncontrolled scope expansion during testing.

---

# 44. Overall Conclusion

Phase 11 successfully moved the project from:

```text
"It appears to work."
```

toward:

```text
"We generated real concurrent traffic,
measured the system,
identified the bottleneck,
scaled the Workers,
and discovered real distributed-system bugs."
```

The most important result was the 1-worker versus 5-worker comparison:

```text
                  1 Worker       5 Workers
                  --------       ---------
VUs                  10              10
Success Rate        40.4%           93.7%
p95 Latency          7.7s            4.7s
```

This demonstrates that horizontal scaling materially improves the invocation system.

At the same time, the load test exposed three important issues:

```text
1. Stale capacity information
2. Incorrect queue-depth measurement
3. Fragile metrics-port handling
```

The second and third issues were fixed immediately because their corrections were clear and contained.

The first issue was deliberately documented for a future Scheduler-hardening phase because the proper solution requires an atomic capacity-reservation mechanism rather than a reactive patch.

The remaining work is primarily deeper stress testing and resource-exhaustion testing:

```text
Phase 11
   |
   +-- Load testing                         ✓
   |
   +-- Horizontal scaling proof             ✓
   |
   +-- Real concurrency bugs                ✓
   |
   +-- Queue metric correction               ✓
   |
   +-- Metrics failure isolation             ✓
   |
   +-- 100/1,000/10,000 VU stress            Future
   |
   +-- Scheduler hardening                   Future
   |
   +-- Docker/host exhaustion testing        Future
```

## Final Takeaway

**Phase 11 proved that the platform's behavior changes meaningfully under real concurrency and that horizontal Worker scaling is an effective solution to the dominant processing bottleneck. More importantly, the load test uncovered issues that normal functional and integration tests could not reveal, demonstrating why load testing is a separate engineering phase rather than an afterthought.**
