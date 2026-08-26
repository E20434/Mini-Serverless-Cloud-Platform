export const BUILD_STREAM_KEY = 'builds:pending';
export const BUILD_CONSUMER_GROUP = 'build-workers';
// A single fixed consumer name, because there's genuinely only one build
// worker process today. Once Phase 7 runs more than one, each real
// process needs its OWN unique consumer name (e.g. derived from
// hostname+pid) - two consumers sharing one name would corrupt Redis's
// per-consumer Pending Entries List bookkeeping.
export const BUILD_CONSUMER_NAME = 'build-worker-1';
