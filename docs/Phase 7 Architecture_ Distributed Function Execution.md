# Phase 7 Architecture: Distributed Function Execution

This architectural phase moves the platform from a monolithic **demo architecture** to a more **production-ready distributed system**.

It solves two main architectural problems:

1. **Process Coupling and Resource Starvation**
2. **Bridging Synchronous HTTP Requests with Asynchronous Processing**

---

## Problem 1: Process Coupling and Resource Starvation

### The Monolith Problem (Phase 5/6)

Previously, when an HTTP request reached the API through `FunctionsController`, the flow was:

```text
Client Request
      ↓
FunctionsController
      ↓
FunctionsService
      ↓
Spawn Docker Container
      ↓
Execute Function
      ↓
Return Result
```

The API server and Docker execution were running on the **same machine and process environment**.

### Why Is This a Problem?

Running Docker containers can consume significant:

- CPU
- Memory
- System resources

For example, imagine **50 users executing functions at the same time**.

The API server would need to handle:

```text
50 HTTP Requests
+
50 Docker Executions
```

This can cause **resource starvation**.

As a result:

- CPU usage may become very high.
- Memory may become exhausted.
- HTTP requests may become slow.
- New requests may be dropped.
- The entire control panel may appear unavailable.

---

## The Distributed Solution (Phase 7)

In Phase 7, the API and function execution are separated into **two independent processes**.

```text
                ┌─────────────────┐
                │   API PROCESS   │
                │                 │
Client ───────► │ Handles HTTP    │
                │ Requests Only   │
                └────────┬────────┘
                         │
                         ▼
                    Redis Queue
                         │
                         ▼
                ┌─────────────────┐
                │ WORKER PROCESS  │
                │                 │
                │ Executes Docker │
                │ Containers      │
                └─────────────────┘
```

### API Process

The API process is:

- Lightweight
- Fast
- Optimized for handling HTTP requests
- Responsible for receiving requests and sending jobs to Redis
- **Does not directly execute Docker containers**

### Worker Process

The Worker process is responsible for:

- Reading jobs from Redis
- Spawning Docker containers
- Executing user code
- Collecting execution results

Because the Worker is separate, it can be scaled independently.

```text
                 API Server
                      │
                      ▼
                Redis Stream
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
       Worker 1    Worker 2    Worker 3
```

If execution demand increases, more workers can be added without affecting the API's ability to respond to users.

---

# Problem 2: Bridging Synchronous and Asynchronous Processing

Separating the API and Worker creates another challenge.

The browser sends a normal synchronous HTTP request:

```text
Browser
   │
   │ "Execute this function"
   ▼
API
```

The browser expects a response.

However, the backend now works asynchronously:

```text
API
 │
 ├── Sends job to Redis
 │
 └── Worker executes it later
```

So the question becomes:

> **How does the API receive the execution result and send it back through the original HTTP request?**

The solution is a hybrid Redis architecture using:

- **Redis Streams** for job dispatch
- **Redis Pub/Sub** for sending the result back

---

# Overall Architecture

```text
[ Client Browser ]
       │  ▲
       │  │
       │  │ Synchronous HTTP Response
       ▼  │
┌─────────────────────────────────────────┐
│              1. API PROCESS             │
│                                         │
│  SUBSCRIBE to "reply:job_123"           │
│                                         │
│  XADD "jobs_stream" {job_123}           │
│                                         │
│  Wait for Pub/Sub result                │
└───────────────────┬─────────────────────┘
                    │
                    │ 2. Durable Job
                    ▼
          ┌──────────────────────┐
          │    Redis Stream      │
          │                      │
          │     jobs_stream      │
          └──────────┬───────────┘
                     │
                     │ 3. Worker fetches job
                     ▼
┌─────────────────────────────────────────┐
│            4. WORKER PROCESS            │
│                                         │
│  XREADGROUP → Read job                  │
│                                         │
│  Spawn Docker Container                 │
│                                         │
│  Execute Code                           │
│                                         │
│  Capture Output                         │
│                                         │
│  PUBLISH "reply:job_123" {payload}     │
└───────────────────┬─────────────────────┘
                    │
                    │ 5. Ephemeral Reply
                    ▼
             API receives result
                    │
                    ▼
             HTTP Response
                    │
                    ▼
              Client Browser
```

---

# Step-by-Step Flow

## Step 1: API Subscribes to the Reply Channel

When the client requests function execution, the API first subscribes to a unique Redis Pub/Sub channel:

```text
reply:job_123
```

This is important because the API must be ready to receive the result **before** the Worker finishes execution.

```text
API
 │
 └── SUBSCRIBE → reply:job_123
```

---

## Step 2: API Adds the Job to Redis Stream

After subscribing, the API creates a job and adds it to the Redis Stream.

```text
XADD jobs_stream * jobId job_123 ...
```

Conceptually:

```text
API
 │
 └── Redis Stream
       │
       └── job_123
```

Redis Streams provide durability, so the job is not lost if a Worker is temporarily unavailable.

---

## Step 3: Worker Fetches the Job

The Worker listens to the Redis Stream using a Consumer Group.

```text
XREADGROUP
```

The Worker retrieves:

```text
job_123
```

Then starts processing it.

---

## Step 4: Worker Executes the Function

The Worker:

```text
Receives Job
     ↓
Starts Docker Container
     ↓
Executes User Code
     ↓
Captures Output
     ↓
Creates Result Payload
```

For example:

```json
{
  "jobId": "job_123",
  "success": true,
  "output": "Hello World"
}
```

---

## Step 5: Worker Publishes the Result

After execution is complete, the Worker publishes the result to:

```text
reply:job_123
```

```text
PUBLISH reply:job_123 {payload}
```

Because the API is already listening to this channel, it immediately receives the result.

```text
Worker
   │
   │ PUBLISH
   ▼
reply:job_123
   │
   ▼
API wakes up
   │
   ▼
HTTP Response
   │
   ▼
Browser
```

---

# Why Use Two Different Redis Features?

Redis Streams and Redis Pub/Sub solve different problems.

| Feature | Redis Streams | Redis Pub/Sub |
|---|---|---|
| **Purpose** | Send jobs to Workers | Send results back to API |
| **Communication** | Durable queue-like messaging | Real-time event messaging |
| **Durability** | High | None |
| **Message Storage** | Messages are persisted | Messages disappear after publishing |
| **Consumers** | Multiple Workers using Consumer Groups | A specific listening subscriber |
| **Failure Recovery** | Possible using `XAUTOCLAIM` | Not possible if nobody is listening |
| **Best For** | Important execution jobs | Temporary execution replies |

---

# Why Redis Streams Are Used for Job Dispatch

The execution job is important.

For example:

```text
API sends job
      ↓
Worker crashes
```

If normal Pub/Sub was used, the job could be lost.

With Redis Streams:

```text
Job remains in the Stream
        ↓
Another Worker can recover it
        ↓
Execution continues
```

Features such as:

```text
Consumer Groups
XACK
XAUTOCLAIM
```

help manage workers and recover jobs that were assigned to a Worker that crashed or stopped responding.

---

# Why Redis Pub/Sub Is Used for Replies

The execution result is different from the original job.

The API already guarantees this sequence:

```text
1. Subscribe to reply:job_123
2. Send job_123 to Redis Stream
3. Wait for the result
```

Therefore, when the Worker publishes:

```text
reply:job_123
```

the API is already listening.

There is no need to permanently store the reply.

The flow is:

```text
Worker publishes result
        ↓
API immediately receives it
        ↓
API sends HTTP response
        ↓
Request is completed
```

The message is temporary and does not need long-term storage.

---

# Why Not Use Another Redis Stream for Replies?

Using a second Redis Stream for replies would add unnecessary complexity.

A Stream would require managing:

- Old reply messages
- Memory usage
- Message cleanup
- `XDEL`
- Stream trimming
- Consumer state

For a one-time response to an already waiting API request, this is unnecessary.

Pub/Sub provides a simpler flow:

```text
Worker
   │
   ▼
PUBLISH result
   │
   ▼
Waiting API receives it immediately
   │
   ▼
HTTP request completes
```

---

# Core Architecture Logic

The key idea is:

```text
                IMPORTANT WORK
                     │
                     ▼
               Redis Streams
                     │
          Durable + Recoverable
                     │
                     ▼
                  Workers


                TEMPORARY REPLY
                     │
                     ▼
                Redis Pub/Sub
                     │
              Instant Delivery
                     │
                     ▼
                Waiting API
```

## In Simple Terms

- **Redis Stream** = "Make sure the Worker eventually receives and processes this important job."
- **Redis Pub/Sub** = "The result is ready — wake up the API that is currently waiting for it."

This separation allows the system to handle heavy Docker execution without blocking or overloading the API server, while still allowing the client to receive the execution result through a normal HTTP request.