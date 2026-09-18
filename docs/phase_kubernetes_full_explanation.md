# Phase: Kubernetes Deployment, Docker-in-Docker/ Docker-outside-of-Docker, and Horizontal Scaling

## 1. What This Phase Was About

This phase moved the project from a setup where services were mainly started manually into a **real Kubernetes environment**.

The important point is that this was not a simulated Kubernetes exercise. The system was deployed to a real local Kubernetes cluster created with **kind (Kubernetes IN Docker)**.

The phase proved three major things:

1. The application can be containerized and deployed through Kubernetes.
2. The complete build-execution pipeline can run inside Kubernetes Pods.
3. The application can scale horizontally by changing Kubernetes Deployment replicas.

It also exposed several bugs that had remained hidden while the application only ran with a single API/Worker process.

---

# 2. Real Local Kubernetes Cluster

## 2.1 What is kind?

**kind** stands for **Kubernetes IN Docker**.

It allows us to run a real Kubernetes cluster locally, where Kubernetes nodes themselves run as Docker containers.

Conceptually:

```text
Your Computer
│
├── Docker
│
└── kind Kubernetes Cluster
    │
    ├── Control Plane Node
    │
    └── Worker Node(s)
        │
        ├── API Pod
        ├── Worker Pod
        ├── PostgreSQL connection
        ├── Redis connection
        └── Other application resources
```

This is different from simply running Docker containers manually.

With Docker alone:

```text
docker run api
docker run worker
```

With Kubernetes:

```text
kubectl apply -f deployment.yaml
```

Kubernetes becomes responsible for maintaining the desired state.

For example:

```yaml
replicas: 5
```

means:

> Kubernetes should continuously try to keep five instances of this workload running.

---

# 3. Full Containerization

Two Dockerfiles were created:

```text
Dockerfile.api
Dockerfile.worker
```

These define how the two major application processes are packaged.

## 3.1 API container

The API container contains the application responsible for receiving requests.

Conceptually:

```text
Client
   │
   ▼
Kubernetes Service / Ingress
   │
   ▼
API Pod
   │
   ├── Authentication
   ├── Registration
   ├── Build request
   └── Queue/outbox operations
```

## 3.2 Worker container

The worker container performs background build/execution work.

Conceptually:

```text
Queue
  │
  ▼
Worker Pod
  │
  ├── Receive build job
  ├── docker build
  ├── docker run
  └── Return/store result
```

The separation is important because API traffic and resource-heavy build execution should not necessarily consume the same process resources.

---

# 4. Kubernetes Manifest Set

The phase introduced a complete Kubernetes manifest set.

The major resources were:

```text
Namespace
ConfigMap
Secret
API Deployment
Worker Deployment
Service
Ingress
HPA
```

Each has a different responsibility.

---

# 5. Namespace

A Kubernetes **Namespace** provides logical isolation inside a cluster.

Example:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: mini-cloud
```

Instead of putting everything into the default namespace:

```text
default
 ├── api
 ├── worker
 ├── service
 └── config
```

we can have:

```text
mini-cloud namespace
 ├── api
 ├── worker
 ├── service
 ├── config
 └── secrets
```

This makes the Kubernetes environment easier to organize.

---

# 6. ConfigMap

A **ConfigMap** stores non-sensitive configuration.

For example:

```text
DATABASE_HOST=...
REDIS_HOST=...
PORT=...
```

The important distinction is:

```text
ConfigMap → normal configuration
Secret    → sensitive configuration
```

A ConfigMap should not be treated as a password store.

---

# 7. Secret

A Kubernetes **Secret** stores values such as:

```text
database password
API credentials
tokens
```

For example:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: mini-cloud-secret
```

However, a very important interview point is:

> A Kubernetes Secret is not a complete security boundary.

A Secret mainly provides a Kubernetes mechanism for storing and injecting sensitive values.

It does **not** automatically protect the value from a person who already has sufficient access to the cluster.

We discuss this in detail later.

---

# 8. Deployments

Two Deployments were created:

```text
mini-cloud-api
mini-cloud-worker
```

A Deployment manages Pods.

For example:

```yaml
spec:
  replicas: 3
```

means Kubernetes should maintain three API Pods.

The architecture becomes:

```text
                    ┌── API Pod 1
                    │
Ingress → Service ──┼── API Pod 2
                    │
                    └── API Pod 3
```

Similarly:

```text
Worker Deployment
        │
        ├── Worker Pod 1
        ├── Worker Pod 2
        ├── Worker Pod 3
        ├── Worker Pod 4
        └── Worker Pod 5
```

This is fundamentally different from manually running five processes.

Kubernetes is now responsible for the desired replica count.

---

# 9. Service

A Kubernetes **Service** gives Pods a stable network endpoint.

Pods are disposable.

A Pod can be:

- restarted
- recreated
- rescheduled
- replaced

Therefore, applications should not depend on a Pod's individual IP address.

Instead:

```text
Client
  │
  ▼
Service
  │
  ├── Pod 1
  ├── Pod 2
  └── Pod 3
```

The Service provides stable discovery and distributes traffic across matching Pods.

---

# 10. Ingress

An **Ingress** provides HTTP routing into the Kubernetes cluster.

Conceptually:

```text
Browser / Client
       │
       ▼
    Ingress
       │
       ▼
    Service
       │
       ▼
    API Pods
```

This gives us an external HTTP entry point rather than exposing individual Pods.

---

# 11. /health Endpoint

A `/health` endpoint was added to the API.

Example:

```text
GET /health
```

returns a simple successful response when the application is alive.

Why is this useful?

Because Kubernetes needs a way to determine whether an application is functioning.

Health endpoints can be used with:

- readiness probes
- liveness probes
- monitoring
- load balancers
- deployment verification

The interesting part is that Kubernetes gave the project a practical reason to add a health endpoint.

Before Kubernetes, there was less need for infrastructure-level health checking.

---

# 12. End-to-End Pipeline Inside Real Pods

The biggest proof of this phase was that the complete workflow worked inside Kubernetes.

The pipeline was:

```text
Register
   │
   ▼
Login
   │
   ▼
Request Build
   │
   ▼
API Pod
   │
   ▼
docker build
   │
   ▼
Worker / Build Environment
   │
   ▼
docker run
   │
   ▼
Correct Result
```

This was not mocked.

The commands actually executed inside containers running as Kubernetes Pods.

---

# 13. What Does Docker-in-Kubernetes Mean Here?

The application itself runs inside a container.

Inside that environment, it needs to interact with Docker.

This creates a nested relationship:

```text
Kubernetes
   │
   └── API Pod
        │
        └── Docker CLI
             │
             └── Docker daemon
```

and similarly for the Worker.

Strictly speaking, there are different ways people describe this architecture.

If the Pod uses the host's Docker daemon through:

```text
/var/run/docker.sock
```

the Docker daemon is technically outside the application container.

This is commonly called:

> Docker-outside-of-Docker (DooD)

rather than running a separate Docker daemon inside the application container.

The important practical point for this project is:

> A containerized application was able to invoke Docker operations against an available Docker daemon.

---

# 14. Why docker build Worked

The build operation looked approximately like:

```text
API Pod
  │
  │ docker build
  ▼
Docker daemon
  │
  ├── Read build context
  ├── Execute Dockerfile
  └── Create image
```

The Docker CLI inside the container does not necessarily need the Docker daemon itself to exist inside that same container.

It only needs access to a Docker daemon.

For example:

```text
Docker CLI
    │
    │ Docker API
    ▼
Docker daemon
```

This is why:

```bash
docker build .
```

can work from inside a container.

---

# 15. Why docker run Is More Complicated

The problem becomes much more interesting when using:

```bash
docker run -v hostpath:containerpath ...
```

Suppose the Worker executes:

```bash
docker run -v /some/host/path:/app/output image
```

The important question is:

> Whose filesystem does `/some/host/path` refer to?

If Docker CLI is running inside a Pod but the Docker daemon is somewhere else, the path is interpreted by the **Docker daemon's filesystem**, not necessarily the filesystem visible inside the Pod.

This creates two different filesystem perspectives.

```text
Pod filesystem
────────────────────
/workspace
/output
/tmp
/etc/...


Docker daemon filesystem
────────────────────
/host/path
/var/lib/docker
...
```

A path existing in one environment does not automatically mean that path exists in the other.

---

# 16. Why a Bind Mount Failed

Consider:

```bash
docker run \
  -v /workspace/result:/app/result \
  image
```

The application may see:

```text
Pod
└── /workspace/result
```

But Docker may interpret the source path from the daemon's filesystem.

Therefore:

```text
Pod filesystem:
    /workspace/result       ✓ exists

Docker daemon filesystem:
    /workspace/result       ✗ doesn't exist
```

The Docker daemon cannot create the expected mount correctly.

This explains why:

```text
docker build
```

worked while:

```text
docker run -v ...
```

failed.

`docker build` mainly needs access to the build context.

A bind mount introduces a second problem:

> The source directory must be meaningful from the Docker daemon's point of view.

---

# 17. Why chmod Was Not Enough

The first attempted solution involved changing permissions:

```bash
chmod ...
```

But permissions were not the complete problem.

The deeper issue was:

```text
"Does the Docker daemon actually see this filesystem path?"
```

Even if permissions are:

```text
777
```

that does not help if the Docker daemon is looking at a different filesystem.

The final solution required a real shared volume using a Kubernetes `hostPath`.

Conceptually:

```text
Host filesystem
      │
      ▼
hostPath volume
      │
      ├──────────► API/Worker Pod
      │
      └──────────► Docker daemon's visible filesystem
```

The important lesson:

> Permissions answer "can I access this path?"  
> Shared filesystem mapping answers "does this environment even have this path?"

---

# 18. Scaling Test

The project then used:

```bash
kubectl scale deployment/mini-cloud-worker --replicas=5
```

This changes the desired Worker replica count to five.

Kubernetes then creates additional Pods:

```text
Before:

Worker Deployment
      │
      └── Worker 1


After:

Worker Deployment
      │
      ├── Worker 1
      ├── Worker 2
      ├── Worker 3
      ├── Worker 4
      └── Worker 5
```

The exact k6 load test from Phase 11 was then executed again.

This was important because it connected three pieces of the project:

```text
Phase 11
   │
   └── Load testing proved scaling behavior

This phase
   │
   └── Kubernetes Deployment controls replica count

Result
   │
   └── Same scaling behavior reproduced using real Pods
```

So the earlier scaling experiment was no longer dependent on manually starting processes.

---

# 19. Why Multiple Replicas Exposed New Bugs

Running one API and one Worker can hide concurrency problems.

For example:

```text
One consumer
    │
    └── processes messages
```

There is no competition.

But with:

```text
API 1 ──┐
API 2 ──┤
API 3 ──┤──> same queue/database
API 4 ──┘
```

multiple processes can attempt the same work.

This is where distributed-system bugs become visible.

The phase discovered three important bugs.

---

# 20. Bug #1 — Hardcoded Consumer Name

`BuildStreamConsumerService` had a hardcoded consumer name.

This had already been identified as a potential future problem during Phase 6.

With one API replica:

```text
API 1
  │
  └── Consumer = "build-consumer"
```

Everything appears fine.

But after scaling:

```text
API 1 → Consumer = "build-consumer"
API 2 → Consumer = "build-consumer"
```

Now two independent processes are pretending to be the same consumer.

Depending on the queue/stream implementation, this can cause:

- consumer conflicts
- incorrect ownership
- duplicate processing
- unexpected message behavior

The fix was to give each process a unique consumer identity.

This followed the same design principle already used to fix `WorkerService` in Phase 8.

---

# 21. Bug #2 — BuildOutboxRelayService Race

Fixing the consumer identity did **not** completely solve duplicate processing.

A different race existed on the producer side.

The problematic operation was an unlocked:

```sql
SELECT
```

Imagine two API replicas:

```text
API 1                         API 2
  │                             │
  │ SELECT pending job          │
  │                             │
  ├──────────────┐              │
  │              │              │
  │ sees job A   │              │
  │              │              │
  │                             │ SELECT pending job
  │                             │
  │                             └── sees job A
  │
  ▼
Publish A
                              ▼
                              Publish A
```

Both processes read the same record before either one had claimed it.

Therefore:

```text
One logical job
       │
       ├── API 1 publishes it
       └── API 2 publishes it
```

The result is duplicate processing.

---

# 22. Why SKIP LOCKED Solves This

The project had already proven a solution in Phase 5:

```sql
FOR UPDATE SKIP LOCKED
```

The basic idea is:

> Lock rows being processed and make other workers skip those locked rows.

Conceptually:

```text
Database
┌────────────────────┐
│ Job A              │
│ Job B              │
│ Job C              │
└────────────────────┘

Worker 1
   │
   └── locks Job A

Worker 2
   │
   └── skips Job A
       processes Job B
```

Without locking:

```text
Worker 1 ──> Job A
Worker 2 ──> Job A
```

With `SKIP LOCKED`:

```text
Worker 1 ──> locks Job A
Worker 2 ──> skips Job A ──> Job B
```

This is a database-level coordination mechanism.

---

# 23. Why Two Different Fixes Were Required

This is one of the most important interview concepts.

The two bugs produced a similar visible symptom:

```text
duplicate processing
```

But they happened at different layers.

## Bug 1

```text
BuildStreamConsumerService
        │
        └── consumer identity problem
```

The problem was:

> Multiple API replicas had the same consumer identity.

The fix was:

> Make the consumer identity unique per process/instance.

---

## Bug 2

```text
BuildOutboxRelayService
        │
        └── database producer race
```

The problem was:

> Multiple producers could select the same database record simultaneously.

The fix was:

> Atomically claim rows using database locking and `SKIP LOCKED`.

---

## Key lesson

Same symptom does not mean same root cause.

```text
Duplicate processing
       │
       ├── Consumer identity bug
       │
       └── Database row-claiming race
```

Distributed systems often require debugging the exact point where duplication occurs.

---

# 24. Bug #3 — Transaction Interrupted During Test Teardown

After fixing the database race, another smaller issue surfaced.

The application had asynchronous work still running when the test environment was being destroyed.

Conceptually:

```text
Test
 │
 ├── Start async database work
 │
 ├── Test completes
 │
 └── Destroy resources
          │
          └── Database connection closed
```

But the asynchronous operation had not finished.

Then the operation attempted:

```text
database query
```

against a connection that was already being destroyed.

---

# 25. The Fix: Await In-Flight Work

The solution followed lessons from earlier phases.

Before destroying the application:

```text
Stop accepting new work
        │
        ▼
Wait for in-flight work
        │
        ▼
Close resources
```

Instead of:

```text
destroy()
```

while work is still running.

The application/test lifecycle becomes:

```text
Start
  │
  ▼
Process work
  │
  ▼
Wait for pending async work
  │
  ▼
Destroy resources
```

---

# 26. Why Attach `.catch()` Immediately?

Another important lesson is that asynchronous operations should have error handling attached immediately.

Bad pattern:

```javascript
const promise = doSomethingAsync();

// lots of other work

await promise;
```

If the Promise rejects before the `await` is reached, the rejection can become temporarily unhandled.

A safer pattern is to attach the error handler immediately:

```javascript
const promise = doSomethingAsync().catch(handleError);
```

The general lesson is:

> Any asynchronous operation that can reject should have its rejection handled as soon as the operation is started.

This was another lesson carried forward from earlier phases.

---

# 27. The Complete Bug Chain

The debugging progression can be visualized as:

```text
Scale to 2+ API replicas
          │
          ▼
Bug #1
Hardcoded consumer name
          │
          ▼
Fix consumer identity
          │
          ▼
Run again
          │
          ▼
Bug #2
Unlocked outbox SELECT
          │
          ▼
Fix with SKIP LOCKED
          │
          ▼
Run tests again
          │
          ▼
Bug #3
Async work interrupted during teardown
          │
          ▼
Await in-flight work
+
Attach .catch() immediately
          │
          ▼
Stable test
```

This is a good example of why distributed systems often reveal problems progressively.

Fixing one race can expose the next race.

---

# 28. Kubernetes Secret — Why It Is Not a Full Security Boundary

A common interview mistake is saying:

> "Kubernetes Secrets keep passwords secure."

That is incomplete.

A Secret provides a Kubernetes object for sensitive configuration, but someone who already has sufficiently powerful cluster access may be able to retrieve or inspect it.

For example, someone with appropriate permissions may be able to:

```bash
kubectl get secret ...
```

or create a Pod that is allowed to access the Secret.

The real security model is therefore:

```text
Secret
   +
RBAC
   +
Namespace isolation
   +
Least privilege
   +
Encryption at rest
   +
External secret management
```

A Secret by itself is not enough.

---

# 29. Why Docker Socket Mounting Is Dangerous

A common DooD setup mounts:

```text
/var/run/docker.sock
```

into a container.

This allows the container's Docker CLI to communicate with the host Docker daemon.

It looks convenient:

```text
Pod
 │
 │ /var/run/docker.sock
 ▼
Host Docker daemon
```

But the Docker socket is extremely powerful.

If a process can control the Docker daemon, it may effectively control the host.

For example, Docker can be instructed to:

- start privileged containers
- mount host directories
- access sensitive host files
- manipulate containers
- potentially escape normal application isolation

Therefore:

> Giving an untrusted workload access to the Docker socket can be equivalent to giving that workload very high privileges over the node.

---

# 30. Why This Is Unacceptable in a Multi-Tenant Cluster

Imagine a Kubernetes cluster hosting:

```text
Tenant A
Tenant B
Tenant C
Tenant D
```

Suppose Tenant A's Pod has:

```text
/var/run/docker.sock
```

mounted.

If that Pod can control the node's Docker daemon, Tenant A may potentially gain access to resources belonging to:

```text
Tenant B
Tenant C
Tenant D
```

That breaks the isolation expected from a multi-tenant cluster.

The security boundary becomes:

```text
Expected:

Tenant A Pod
     │
     └── isolated

Actual with Docker socket:

Tenant A Pod
     │
     ▼
Host Docker daemon
     │
     ├── Tenant A
     ├── Tenant B
     ├── Tenant C
     └── Host resources
```

This is why directly exposing the host Docker daemon to untrusted workloads is considered dangerous.

---

# 31. Why Serverless Platforms Use Firecracker

The project intentionally accepted the Docker socket security tradeoff for this local environment.

That is reasonable for a controlled development setup.

But production multi-tenant compute platforms need stronger isolation.

One approach used by serverless/container infrastructure is **Firecracker microVMs**.

Instead of:

```text
Untrusted code
      │
      ▼
Host Docker daemon
      │
      ▼
Host
```

the architecture is closer to:

```text
Untrusted workload
      │
      ▼
MicroVM
      │
      ▼
Virtualized isolation
      │
      ▼
Host
```

Firecracker provides lightweight virtual-machine isolation designed for running workloads with stronger boundaries than ordinary containers.

This connects back to the earlier Part 2 discussion:

```text
Need to execute untrusted code
            │
            ▼
Containers are convenient
            │
            ▼
But container isolation has limitations
            │
            ▼
Stronger isolation required
            │
            ▼
MicroVM / Firecracker approach
```

---

# 32. How AWS Handles This Differently

The local Kubernetes phase is effectively the **manual learning version** of infrastructure that AWS services manage for you.

For example, managed platforms handle many responsibilities such as:

```text
Scheduling
Scaling
Networking
Health checking
Load balancing
Container lifecycle
Resource isolation
Infrastructure management
```

With local kind, you have to understand and configure these pieces yourself.

Conceptually:

```text
Local project

You
 │
 ├── Docker
 ├── kind
 ├── Kubernetes manifests
 ├── Deployment
 ├── Service
 ├── Ingress
 └── HPA
```

Whereas managed AWS infrastructure provides managed control planes and compute infrastructure.

The important learning outcome is not simply:

> "I know kubectl."

It is:

> "I understand what the managed platform is doing for me."

---

# 33. What Is Still Missing?

This phase intentionally did not containerize every dependency.

PostgreSQL, Redis, and MinIO still live on the host.

Conceptually:

```text
Kubernetes
│
├── API Pods
├── Worker Pods
├── Service
├── Ingress
└── HPA
       │
       └──────────────┐
                      │
Host                 │
├── PostgreSQL ◄─────┤
├── Redis ◄──────────┤
└── MinIO ◄──────────┘
```

This was deliberate.

The next phase is responsible for moving these infrastructure dependencies into a more complete Kubernetes deployment model.

---

# 34. Why CPU-Based HPA Is Not Ideal

The current HPA scales based on CPU utilization.

For example:

```text
CPU > threshold
       │
       ▼
Increase replicas
```

This works well when CPU is the bottleneck.

But the project's actual bottleneck is more **I/O and queue related**.

The worker may spend significant time:

```text
waiting for queue messages
waiting for database
waiting for Docker
waiting for filesystem
```

CPU could remain low:

```text
CPU = 25%
Queue = 500 jobs
```

The HPA might conclude:

> "Everything is fine."

But the user experience says:

> "There are hundreds of jobs waiting."

---

# 35. Why Queue Depth Is a Better Metric

The project already has queue-related metrics.

A better scaling signal is:

```text
Queue depth
```

For example:

```text
Queue = 10 jobs
    │
    └── 2 workers may be enough

Queue = 1,000 jobs
    │
    └── Need many more workers
```

The desired architecture for the next phase is therefore something like:

```text
Queue
  │
  │ queue depth metric
  ▼
KEDA
  │
  ▼
Worker Deployment
  │
  ├── Worker 1
  ├── Worker 2
  ├── Worker 3
  ├── ...
  └── Worker N
```

KEDA is designed for event-driven autoscaling and is a much better fit for workloads where queue length is a meaningful scaling signal.

---

# 36. Phase Roadmap

The overall progression is now:

```text
Earlier phases
      │
      ▼
Application works
      │
      ▼
Async processing
      │
      ▼
Load testing
      │
      ▼
Real Kubernetes deployment
      │
      ▼
Multi-replica bugs discovered
      │
      ▼
Concurrency bugs fixed
      │
      ▼
Next:
Infrastructure dependencies
      │
      ▼
PostgreSQL + Redis + MinIO
      │
      ▼
Then:
Queue-aware autoscaling
      │
      ▼
KEDA + queue depth
```

---

# 37. Interview Questions and Strong Answers

## Question 1: Why does `docker build` work fine nested inside a container while `docker run -v hostpath:containerpath` doesn't, without a shared volume?

### Short answer

Because `docker build` primarily needs access to the build context, while a bind mount requires the Docker daemon to resolve the source path.

The important distinction is:

```text
Docker CLI location ≠ Docker daemon filesystem
```

If the CLI is inside a Pod but the Docker daemon is outside it, this:

```bash
docker build .
```

can work because the build context can be sent to the Docker daemon.

But this:

```bash
docker run -v /pod/path:/container/path ...
```

requires `/pod/path` to exist from the Docker daemon's filesystem perspective.

If:

```text
Pod:
    /pod/path       ✓

Docker daemon:
    /pod/path       ✗
```

the bind mount fails.

### Interview-quality explanation

> "`docker build` transfers a build context to the Docker daemon, so the CLI and daemon don't have to share the same filesystem path. A bind mount is different because the mount source is interpreted by the Docker daemon. Therefore, a path that exists only inside the Pod isn't automatically visible to the daemon. We needed a real shared hostPath-backed filesystem so both sides could reference the same underlying path."

---

# 38. Question 2: Why were two different fixes needed for the build pipeline's duplicate-processing bug?

Because the two duplicate-processing problems had different root causes.

### First problem

```text
BuildStreamConsumerService
```

Multiple API replicas used the same consumer identity.

```text
API 1 → consumer-A
API 2 → consumer-A
```

The fix:

```text
API 1 → unique consumer identity
API 2 → unique consumer identity
```

### Second problem

```text
BuildOutboxRelayService
```

Multiple producers could select the same database row simultaneously.

```text
Producer 1 → SELECT job A
Producer 2 → SELECT job A
```

The fix:

```sql
FOR UPDATE SKIP LOCKED
```

This allows one producer to claim the row while other producers skip it.

### Interview-quality answer

> "They looked like the same symptom—duplicate processing—but they were different races at different layers. The first was a consumer identity problem, so making the consumer identity unique fixed it. The second was a producer-side database race caused by an unlocked SELECT, so it required transactional row locking with SKIP LOCKED. Fixing the first could not prevent the second because they occurred at different stages of the pipeline."

---

# 39. Question 3: Why is a Kubernetes Secret not really a security control against someone who already has cluster access?

Because Kubernetes authorization determines who can access the Secret.

A Secret does not magically make the value inaccessible to administrators or sufficiently privileged workloads.

Think about the security layers:

```text
Cluster access
      │
      ▼
RBAC permissions
      │
      ▼
Can this identity access Secret?
      │
      ├── Yes → Secret can potentially be retrieved
      └── No  → Access denied
```

Therefore:

> The Secret is a storage/configuration mechanism, while RBAC and the broader cluster security model determine who can actually access it.

For stronger security, production environments often combine:

```text
RBAC
+
least privilege
+
encryption at rest
+
external secret manager
+
audit logging
```

---

# 40. Question 4: Why is mounting the host Docker socket into a Pod unacceptable in a real multi-tenant cluster?

Because access to the Docker socket can provide control over the host Docker daemon.

That can allow a malicious workload to manipulate containers and potentially access host resources.

The dangerous relationship is:

```text
Tenant Pod
    │
    ▼
Docker socket
    │
    ▼
Host Docker daemon
    │
    ├── Other containers
    ├── Host filesystem
    └── Host resources
```

This can destroy the isolation between tenants.

### Interview-quality answer

> "The Docker socket isn't just a normal filesystem file. It is an API to the Docker daemon. If an untrusted Pod can access it, the Pod can request highly privileged Docker operations, including starting containers with host mounts or other dangerous configurations. In a multi-tenant cluster, that can turn compromise of one workload into compromise of the node and potentially other tenants. That's why exposing the host Docker socket is generally unacceptable for untrusted workloads."

---

# 41. Key Concepts to Remember

If you need to remember this phase for an interview, focus on these concepts:

## Kubernetes

```text
Deployment → manages Pods
Service → stable networking
Ingress → HTTP entry point
ConfigMap → non-secret configuration
Secret → sensitive configuration
HPA → automatic replica scaling
Namespace → logical isolation
```

## Docker + Kubernetes

```text
Docker CLI
    │
    ▼
Docker daemon
    │
    ▼
Images / containers
```

The CLI and daemon do not necessarily share the same filesystem.

## Concurrency

```text
1 replica
   ↓
Few races visible

2+ replicas
   ↓
Concurrency appears

Concurrency
   ↓
Race conditions become visible
```

## Database locking

```sql
FOR UPDATE SKIP LOCKED
```

means:

```text
Worker A locks row
Worker B skips locked row
```

## Async lifecycle

```text
Start async work
      ↓
Wait for it
      ↓
Handle errors
      ↓
Destroy resources
```

Do not destroy dependencies while asynchronous work is still using them.

## Security

```text
Docker socket
    ↓
Very powerful
    ↓
Dangerous for untrusted workloads
```

## Autoscaling

```text
CPU-based HPA
     ↓
Good for CPU-bound workloads

Queue-based scaling
     ↓
Better for queue/I/O-bound workloads
```

---

# 42. The Biggest Lesson From This Phase

The most important lesson is not Kubernetes syntax.

It is that **scaling changes the correctness requirements of an application**.

With one process:

```text
Everything looks simple.
```

With multiple processes:

```text
Shared state
     +
Concurrent consumers
     +
Concurrent producers
     +
Transactions
     +
Filesystem boundaries
     +
Resource lifecycle
```

create new failure modes.

That is exactly what happened here.

The project went from:

```text
"Does the application work?"
```

to:

```text
"Does the application remain correct when
multiple independent instances work on the
same data and infrastructure?"
```

That is the transition from a single-process application toward a distributed system.

---

# 43. Final Architecture

The resulting local architecture can be summarized as:

```text
                         Client
                           │
                           ▼
                       Ingress
                           │
                           ▼
                       API Service
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
          API Pod       API Pod       API Pod
             │             │             │
             └─────────────┼─────────────┘
                           │
                    Database / Outbox
                           │
                           ▼
                     Build Stream
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
        Worker Pod     Worker Pod     Worker Pod
             │             │             │
             └─────────────┼─────────────┘
                           │
                      Docker daemon
                           │
                           ▼
                    Build / Run Result


Kubernetes control plane
          │
          ├── Deployments
          ├── Services
          ├── Ingress
          ├── ConfigMap
          ├── Secrets
          └── HPA
```

The cluster therefore proved that the platform can run its actual API/build/worker pipeline using real Kubernetes Pods, survive multi-replica execution after fixing concurrency bugs, and scale workers through Kubernetes rather than manual process management.

The remaining architectural work is to move PostgreSQL/Redis/MinIO into the Kubernetes environment and replace CPU-based autoscaling with queue-aware event-driven scaling using KEDA.
