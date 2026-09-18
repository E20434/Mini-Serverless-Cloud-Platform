import crypto from 'node:crypto';

export const BUILD_STREAM_KEY = 'builds:pending';
export const BUILD_CONSUMER_GROUP = 'build-workers';
// Was a single fixed 'build-worker-1' from Phase 6 through Phase 11,
// flagged even then as a Phase-7-or-later problem once more than one
// instance existed. Phase 12's `replicas: 2` on the API Deployment is
// what actually exercised it for real: two Pods both claiming the same
// consumer NAME corrupted Redis's per-consumer Pending Entries List
// bookkeeping, and the same build got processed twice - live proof
// visible as a `(function_id, version_number)` unique-constraint failure
// on the second, redundant transaction. Fixed the same way Phase 8 fixed
// the analogous problem for WorkerService: a unique identity per process.
export const BUILD_CONSUMER_NAME = `build-worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
