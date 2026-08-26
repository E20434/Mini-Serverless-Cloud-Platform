export const INVOCATION_STREAM_KEY = 'invocations:pending';
export const INVOCATION_CONSUMER_GROUP = 'invocation-workers';
// Same caveat as the build queue's consumer name: one fixed name because
// there's genuinely only one worker process today. Phase 8 (the
// Scheduler) is exactly where this gets replaced with a unique per-worker
// identity, once "which of several workers should run this" is a real
// question.
export const INVOCATION_CONSUMER_NAME = 'worker-1';

export function invocationResultChannel(correlationId: string): string {
  return `invocation-result:${correlationId}`;
}
