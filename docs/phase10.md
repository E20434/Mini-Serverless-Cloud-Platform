# Observability & Invocation Monitoring — Implementation Summary

## What Was Built and Proven

The observability and invocation-monitoring layer was successfully implemented and verified with:

* **32/32 tests passing**
* **2 clean full-suite test runs**
* **Live Prometheus scraping demonstration**
* Real PostgreSQL invocation data
* Real percentile-based metrics
* Metrics exposed independently by both API and Worker
* End-to-end verification that Prometheus receives the same data as PostgreSQL

---

# 1. Durable, Tenant-Scoped Invocation History

A persistent `Invocation` table was introduced in PostgreSQL to store information about every function execution.

For example, when a function is invoked:

```http
POST /functions/sendEmail
```

the system records information such as:

```text
Invocation
├── id
├── tenantId
├── functionName
├── correlationId
├── status
├── startedAt
├── completedAt
└── duration
```

## Tenant Scoping

The invocation history is scoped to the tenant that owns the function.

For example:

```text
Tenant A
├── Function A
├── Invocation 1
└── Invocation 2

Tenant B
├── Function B
├── Invocation 3
└── Invocation 4
```

Tenant A should only be able to access its own invocation history.

This prevents one tenant from accessing another tenant's execution data.

---

# 2. Worker Maintains the "Zero PostgreSQL Access" Design

An important architectural decision was preserved:

> The Worker does not directly access PostgreSQL.

Instead, the API is responsible for writing invocation information to PostgreSQL.

The architecture is approximately:

```text
Client
   |
   v
 API
   |
   +------------------> PostgreSQL
   |                       |
   |                       +-- Invocation History
   |
   v
 Queue
   |
   v
 Worker
```

The Worker focuses on executing functions/jobs rather than directly querying or writing to PostgreSQL.

This keeps the Worker lightweight and preserves the previously defined **"zero Postgres access"** architecture.

---

# 3. Invocation History API

A new endpoint was implemented:

```http
GET /functions/:name/invocations
```

For example:

```http
GET /functions/sendEmail/invocations
```

This endpoint retrieves the execution history of a function.

A response could look like:

```json
[
  {
    "id": "123",
    "status": "SUCCESS",
    "duration": 250,
    "createdAt": "2026-08-30T10:00:00Z"
  },
  {
    "id": "124",
    "status": "SUCCESS",
    "duration": 320,
    "createdAt": "2026-08-30T10:05:00Z"
  }
]
```

This provides a durable history of function executions instead of relying only on temporary logs or in-memory data.

---

# 4. Percentile-Based Function Metrics

Another endpoint was implemented:

```http
GET /functions/:name/metrics
```

For example:

```http
GET /functions/sendEmail/metrics
```

Instead of returning individual invocations, this endpoint calculates useful performance statistics.

A response could contain:

```json
{
  "count": 100,
  "averageDuration": 250,
  "p50": 200,
  "p95": 600,
  "p99": 1200
}
```

## What Are Percentiles?

### P50

P50 is the median.

It means approximately:

```text
50% of requests completed faster than this value.
```

For example:

```text
P50 = 200 ms
```

means roughly half of the invocations completed in 200 ms or less.

---

### P95

P95 represents the 95th percentile.

```text
95% of requests completed faster than this value.
```

For example:

```text
P95 = 600 ms
```

means approximately 95% of requests completed within 600 ms.

This is useful for understanding the experience of slower requests.

---

### P99

P99 represents the 99th percentile.

```text
99% of requests completed faster than this value.
```

For example:

```text
P99 = 1200 ms
```

This helps identify extreme latency cases.

---

## Why Percentiles Are Better Than Only Averages

Consider these execution times:

```text
100 ms
120 ms
150 ms
200 ms
250 ms
300 ms
500 ms
2000 ms
```

An average alone can hide the fact that some requests are extremely slow.

Percentiles give a better understanding of the actual latency distribution:

```text
P50 → Typical request
P95 → Slow requests
P99 → Very slow/extreme requests
```

This makes the `/metrics` endpoint more useful for monitoring production performance.

---

# 5. Real Prometheus Metrics

Prometheus metrics were implemented using:

```text
prom-client
```

Both the API and Worker expose their own metrics.

The architecture is:

```text
API Process
└── Prometheus Registry
    ├── HTTP metrics
    └── Function invocation metrics

Worker Process
└── Prometheus Registry
    ├── Job processing metrics
    └── Worker execution metrics
```

---

# 6. Why Separate Prometheus Registries Are Used

The API and Worker are separate processes.

For example:

```text
Process 1
└── API

Process 2
└── Worker
```

Each process has its own memory space.

Therefore, the API and Worker cannot simply share an in-memory Prometheus registry.

Instead:

```text
API
 |
 +--> API Prometheus Registry
 |
 +--> /metrics


Worker
 |
 +--> Worker Prometheus Registry
 |
 +--> /metrics
```

Prometheus can then scrape each process independently.

---

# 7. API Metrics Server

The API uses NestJS to expose its Prometheus endpoint.

Conceptually:

```text
API
 |
 v
NestJS HTTP Server
 |
 +-- /functions/...
 |
 +-- /metrics
```

Prometheus can request:

```http
GET /metrics
```

and receive metrics in Prometheus's expected format.

---

# 8. Worker Metrics Server

The Worker does not have an Express instance.

Therefore, Express was not added just to expose metrics.

Instead, a basic Node.js HTTP server was used:

```javascript
http.createServer(...)
```

The architecture is:

```text
Worker
 |
 v
Node.js http.Server
 |
 +-- /metrics
```

This keeps the Worker lightweight.

The important point is:

> The Worker can expose Prometheus metrics without introducing Express or another unnecessary HTTP framework.

---

# 9. Live End-to-End Prometheus Proof

One of the most important parts of the implementation was proving that the metrics work in a real environment.

The system was not only tested using internal assertions.

Instead, the complete flow was tested.

## Step 1 — Invoke a Function Three Times

A function was invoked three times:

```text
Function Invocation #1
Function Invocation #2
Function Invocation #3
```

Total:

```text
3 invocations
```

---

## Step 2 — Verify PostgreSQL

The invocation data was checked in PostgreSQL.

The database showed:

```text
Invocation Count = 3
```

This confirmed that the API correctly recorded the executions.

---

## Step 3 — Verify the Percentile Metrics

The application's metrics endpoint was then checked.

The percentile summary reported the same invocation count:

```text
Count = 3
```

---

## Step 4 — Independently Query Prometheus

Prometheus itself was queried through its query API:

```http
GET /api/v1/query
```

Prometheus returned:

```text
Value = 3
```

Therefore:

```text
PostgreSQL
    |
    +-- Invocation count = 3


Prometheus
    |
    +-- Metric count = 3
```

The two independent systems agreed.

---

# 10. End-to-End Data Flow

The complete metrics flow can be represented as:

```text
Client
   |
   | Function Invocation
   v
API
   |
   +------------------------+
   |                        |
   v                        v
PostgreSQL              Metrics
   |                        |
   |                        v
   |                  /metrics
   |                        |
   |                        v
   |                   Prometheus
   |                        |
   |                        v
   |                  /api/v1/query
   |                        |
   +------------------------+
            |
            v
        Count = 3
```

This proves that the metric was not simply calculated locally.

The metric actually flowed through the monitoring system and was stored/queryable by Prometheus.

---

# 11. Why This Is Stronger Than a Normal Unit Test

A simple unit test could do something like:

```javascript
expect(counter).toBe(3);
```

However, this only proves that the application believes the counter is `3`.

It does not prove that:

* Prometheus can reach the metrics endpoint
* Prometheus successfully scrapes the endpoint
* Prometheus stores the metric
* Prometheus can query the metric
* The metric value survives the complete monitoring pipeline

The live demonstration proved the complete path:

```text
Application
     |
     v
Metrics Endpoint
     |
     v
Prometheus Scraper
     |
     v
Prometheus Storage
     |
     v
Prometheus Query API
```

That is why the result can be described as:

> **Live proof, not just assertion.**

---

# 12. A Real Bug Discovered by the Tests

The tests discovered a real initialization problem.

Originally, metrics startup existed only in the application's entrypoint.

For example, conceptually:

```typescript
async function bootstrap() {
  startMetrics();
  await app.listen(3000);
}
```

The problem is that tests may not execute the production entrypoint.

Production:

```text
Production Startup
       |
       v
    main.ts
       |
       v
startMetrics()
       |
       v
Metrics Running
```

But tests may do:

```text
Test
 |
 v
Create AppModule
 |
 v
Run Tests
```

without executing:

```text
main.ts
```

Therefore:

```text
Production → Metrics initialized
Tests      → Metrics may not initialize
```

This creates inconsistent behavior between production and tests.

---

# 13. The Fix: Module Lifecycle Initialization

Metrics startup was moved into the application's module lifecycle.

Conceptually:

```typescript
@Injectable()
export class MetricsService implements OnModuleInit {
  onModuleInit() {
    this.startMetrics();
  }
}
```

Now both production and testing go through the same initialization path:

```text
Production
    |
    v
Module Initialization
    |
    v
Metrics Start


Tests
    |
    v
Module Initialization
    |
    v
Metrics Start
```

This ensures consistent behavior regardless of how the application is started.

The architectural principle is:

> Important application behavior should be tied to the application's lifecycle rather than only to the production entrypoint.

---

# 14. Test Results

The implementation was verified with:

```text
32 / 32 tests passing
```

The complete test suite was also executed twice:

```text
Run 1
32 passed
0 failed


Run 2
32 passed
0 failed
```

Running the full suite twice provides additional confidence that the implementation is stable.

It helps reduce the possibility that the result depends on:

* Shared state
* Database leftovers
* Metrics not being reset
* Initialization order
* Race conditions
* Test execution order

---

# 15. OpenTelemetry Was Intentionally Not Implemented

OpenTelemetry/distributed tracing was deliberately excluded from this implementation.

The existing system already has a:

```text
correlationId
```

This identifier informally connects a single invocation across the system.

For example:

```text
API
 |
 | correlationId = abc-123
 v
Queue
 |
 | correlationId = abc-123
 v
Worker
 |
 | correlationId = abc-123
 v
Function Execution
```

This makes it possible to follow a particular invocation through logs.

For example:

```text
[API]
correlationId=abc-123
Invocation created


[QUEUE]
correlationId=abc-123
Message published


[WORKER]
correlationId=abc-123
Function started


[WORKER]
correlationId=abc-123
Function completed
```

---

# 16. Correlation IDs vs OpenTelemetry

A `correlationId` is useful for connecting logs.

However, it is not equivalent to proper distributed tracing.

OpenTelemetry would provide a structured trace such as:

```text
Trace: abc-123

├── API Request
│   └── 20 ms
│
├── PostgreSQL Write
│   └── 15 ms
│
├── Queue Publish
│   └── 10 ms
│
└── Worker Execution
    └── 500 ms
```

With proper spans:

```text
Trace
 |
 +-- API Span
 |    |
 |    +-- PostgreSQL Span
 |    |
 |    +-- Queue Span
 |
 +-- Worker Span
      |
      +-- Function Execution Span
```

Implementing this properly would require additional work such as:

* Trace propagation
* Span creation
* Context propagation
* Exporters
* Tracing backend
* Instrumentation

Therefore, OpenTelemetry was intentionally left as a future improvement rather than implementing it incompletely.

---

# 17. Why This Scope Cut Was Deliberate

The decision was:

```text
Current Implementation
        |
        v
correlationId-based invocation tracking


Future Enhancement
        |
        v
OpenTelemetry distributed tracing
```

This avoids adding a shallow tracing implementation simply for the sake of claiming that tracing exists.

The better approach is to implement proper span-based tracing as a separate future milestone.

---

# 18. Overall Architecture

The completed architecture can be summarized as:

```text
                         +----------------+
                         |     Client     |
                         +-------+--------+
                                 |
                                 v
                         +---------------+
                         |      API      |
                         |               |
                         | Authentication|
                         | Invocation DB |
                         | Metrics       |
                         +-------+-------+
                                 |
                +----------------+----------------+
                |                                 |
                v                                 v
        +---------------+                  +---------------+
        |  PostgreSQL   |                  | Queue / SQS   |
        |               |                  +-------+-------+
        |  Invocation   |                          |
        |  History      |                          v
        +---------------+                  +---------------+
                                          |    Worker     |
                                          |               |
                                          | No PostgreSQL |
                                          | Function Exec |
                                          +-------+-------+
                                                  |
                                                  v
                                          +---------------+
                                          |   /metrics    |
                                          +-------+-------+
                                                  |
                                                  v
                                          +---------------+
                                          |  Prometheus   |
                                          |               |
                                          | Scrapes API & |
                                          | Worker        |
                                          +---------------+
```

---

# 19. What Was Ultimately Proven

The implementation proves the following:

### 1. Durable invocation history

Function executions are permanently stored in PostgreSQL.

### 2. Tenant isolation

Invocation history is scoped to individual tenants.

### 3. Worker isolation

The Worker maintains the **zero PostgreSQL access** architecture.

### 4. Invocation history API

The system provides:

```http
GET /functions/:name/invocations
```

### 5. Percentile-based metrics

The system provides:

```http
GET /functions/:name/metrics
```

with real performance statistics such as:

```text
Count
P50
P95
P99
```

### 6. Prometheus integration

Both API and Worker expose real Prometheus metrics using `prom-client`.

### 7. Independent Worker metrics server

The Worker exposes metrics using a bare Node.js `http.Server` without Express.

### 8. End-to-end monitoring verification

Three real function invocations were performed and verified through:

```text
PostgreSQL → 3
Prometheus  → 3
```

### 9. Test-discovered bug

The tests identified that metrics initialization was incorrectly tied only to the production entrypoint.

The implementation was corrected by moving initialization into the module lifecycle.

### 10. Stable test suite

The final result was:

```text
32 / 32 tests passing
2 complete clean test-suite runs
```

### 11. Deliberate OpenTelemetry scope cut

OpenTelemetry was intentionally excluded.

The existing `correlationId` provides basic invocation correlation, while proper distributed tracing remains a clean future enhancement.

---

# Final Summary

This milestone adds a complete **observability foundation** to the platform.

The system can now:

```text
Execute Functions
       |
       v
Record Invocations
       |
       v
Calculate Performance Metrics
       |
       v
Expose Prometheus Metrics
       |
       v
Prometheus Scrapes Metrics
       |
       v
Metrics Can Be Queried Externally
```

Most importantly, the implementation was not only written but **verified end-to-end with real data**.

The combination of:

```text
32/32 passing tests
        +
2 clean full-suite runs
        +
PostgreSQL verification
        +
Live Prometheus scraping
        +
Independent Prometheus query
```

provides strong evidence that the invocation history and observability system is functioning correctly.
