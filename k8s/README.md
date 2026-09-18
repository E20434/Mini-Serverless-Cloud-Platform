# Kubernetes (Phase 12)

## What this phase actually is

Most of what Kubernetes gives you, this project already built by hand, badly:

| Hand-built (which phase) | Kubernetes primitive |
|---|---|
| `WorkerRegistryService` heartbeats/staleness (Phase 8) | Node status / kubelet health |
| Manually starting extra `npm run start:worker` processes (Phase 11) | Deployment `replicas` / HPA |
| Nothing - a crashed worker just stayed dead | Pod restart policy |
| Redis Streams consumer-group delivery spreading jobs (Phase 6) | Service load-balancing |
| `.env` files copied by hand | ConfigMap / Secret |

This phase's job is translating those hand-built mechanisms into the standard primitives, not solving a new problem.

**Correction to a common misconception, stated plainly:** a `Secret` is base64-encoded, not encrypted. Real encryption-at-rest needs deliberate extra configuration. We use `Secret` here for RBAC/tooling separation from `ConfigMap`, not for cryptographic protection it doesn't provide.

## The Docker-in-Kubernetes problem

Both the API (its Build pipeline) and the Worker (every invocation) run real `docker build`/`docker run` commands. Once they're Pods, they still need a real Docker daemon to talk to - a container does not get one for free.

The pragmatic choice here is **Docker-outside-of-Docker (DooD)**: mount the host's actual `/var/run/docker.sock` into the Pod (`k8s/03-api-deployment.yaml`, `k8s/06-worker-deployment.yaml`), so `docker` CLI calls inside the Pod control containers as *siblings* on the same host daemon, rather than nesting a second daemon inside each Pod (Docker-in-Docker/DinD - more isolated, heavier, usually needs `--privileged`).

**Be clear about the real cost of this choice:** any Pod with that socket mounted has root-equivalent access to the host. This is completely unacceptable in a real multi-tenant cluster. It's exactly why real serverless platforms don't do this at all - AWS Lambda isolates with Firecracker microVMs (Part 2's isolation discussion) specifically so a tenant's code never needs anywhere near this level of host access. Treat this phase's approach as a legitimate *local learning-cluster* shortcut, not a production pattern.

## Deliberate scope cuts

- **Postgres/Redis/MinIO stay on the host**, reached via `host.docker.internal` (the same bridge Prometheus already used in Phase 10) - not redeployed in-cluster. A real cluster would run these as StatefulSets+PVCs, or more realistically use managed equivalents (RDS/ElastiCache/S3) - which is literally Phase 13's job.
- **The HPA here scales on CPU**, the only metric K8s understands without an adapter. Our Worker is I/O-bound (blocked on a Redis read or a `docker run`, not burning CPU) - Phase 11 already found the REAL bottleneck is concurrent capacity, not CPU. This HPA is a real, working taste of autoscaling, not the correct final answer. True capacity-aware scaling needs KEDA watching `mini_cloud_invocation_queue_depth` (the exact metric Phase 10 built and Phase 11 fixed) - that's Phase 14's job.
- **Ingress is written but not exercised live** - it needs a real ingress controller (ingress-nginx) installed to do anything; verification here uses the simpler NodePort from `04-api-service.yaml` instead.

## Running it locally (kind)

```
# 1. Create the cluster (mounts the host Docker socket per kind-config.yaml)
kind create cluster --config k8s/kind-config.yaml --name mini-cloud

# 2. Build and load the app images (kind can't pull from a registry for local-only images)
npm run build
docker build -f Dockerfile.api -t mini-cloud-api:local .
docker build -f Dockerfile.worker -t mini-cloud-worker:local .
kind load docker-image mini-cloud-api:local --name mini-cloud
kind load docker-image mini-cloud-worker:local --name mini-cloud

# 3. Apply manifests
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/01-configmap.yaml
kubectl apply -f k8s/02-secret.yaml
kubectl apply -f k8s/03-api-deployment.yaml
kubectl apply -f k8s/04-api-service.yaml
kubectl apply -f k8s/06-worker-deployment.yaml
# k8s/05-ingress.yaml and k8s/07-worker-hpa.yaml need an ingress
# controller / metrics-server respectively - see comments in each file

# 4. Verify
kubectl -n mini-cloud get pods
curl http://localhost:30080/health
```

## Teardown

```
kind delete cluster --name mini-cloud
```

**Important:** the cluster's Pods stay connected to the SAME host-run Postgres/Redis/MinIO the Jest suite uses (see "Deliberate scope cuts" above). Leaving the cluster running while also running `npx jest` causes real, confusing cross-contamination - the K8s Pods' own heartbeats and stream consumers are indistinguishable from the test suite's own fixtures. Delete the cluster before running the host test suite, or vice versa.

## What running this for real actually found

Verified live end-to-end: register → login → deploy (a real `docker build` running *inside* an API Pod) → invoke (a real `docker run` running *inside* a Worker Pod, writing its result back through a shared volume) → a correct JSON result, plus the Phase 10 invocation history and Phase 8 worker registry both correctly reflecting it. `kubectl scale deployment/mini-cloud-worker --replicas=5` (the direct K8s-native replacement for Phase 11's manual process-launching) reproduced Phase 11's exact finding - success rate rose from the single-worker baseline once real replicas existed - now driven by a Deployment's replica count instead of hand-typed commands.

Getting there surfaced **three real, load-bearing bugs**, none hypothesized - all found by literally running more than one replica for the first time in this project's history:

1. **`BuildStreamConsumerService`'s hardcoded single consumer name** (`'build-worker-1'`, unchanged since Phase 6, explicitly flagged even then as "a Phase 7-or-later problem"). Two API replicas both claiming the same Redis Streams consumer identity corrupted delivery bookkeeping - the same build got processed twice, visible as a `(function_id, version_number)` unique-constraint failure on the loser. Fixed the same way Phase 8 fixed the analogous problem for `WorkerService`: a unique identity per process (`src/build/build-stream.constants.ts`).
2. **`BuildOutboxRelayService`'s unlocked `SELECT`** - a *different* race, at the producer rather than the consumer: two relay instances (one per API replica) could both claim the same unpublished build before either's `UPDATE` committed, publishing it as two distinct stream messages that fix #1's unique-consumer-name change does nothing to prevent (they're genuinely different messages, not a redelivery). Fixed with the exact `SELECT ... FOR UPDATE SKIP LOCKED` pattern already proven for this shape of problem back in Phase 5.
3. **A Windows-host-vs-real-Linux-container permissions gap**, not a Docker-in-Kubernetes path problem as first suspected: every previous phase ran the Worker as a bare Windows process, where Docker Desktop's bind-mount translation silently ignored Linux UID/GID bits. Once the Worker became a real Linux container, the scratch directory it creates for each invocation (root-owned, mode `0755`) had its permissions *actually enforced* against the function container's non-root UID 1000 - a `chmod` alone didn't fix it, because the deeper issue was `docker run -v <path>:/output` requiring `<path>` to exist on the **daemon's own filesystem**, not the calling Pod's private one (`docker build`'s context-as-tar-stream sidesteps this entirely, which is why the Build pipeline worked immediately while invocation didn't). Fixed with a shared hostPath volume (`kind-config.yaml`'s second `extraMounts` entry + `HOST_SCRATCH_DIR` in `containerExecutor.ts`) that's genuinely the same physical directory on both sides of the mount.
