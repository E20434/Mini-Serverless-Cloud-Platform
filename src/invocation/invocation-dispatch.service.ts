import crypto from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ExecutionOutcome } from '../containerExecutor';
import { REDIS_CLIENT } from '../queue/redis.module';
import { INVOCATION_STREAM_KEY, invocationResultChannel } from '../worker/invocation-stream.constants';

export interface InvocationJob {
  imageTag: string;
  event: unknown;
  timeoutMs: number;
  memoryMb: number;
}

const DISPATCH_TIMEOUT_BUFFER_MS = 5000;

/**
 * The API-process half of the request-reply-over-a-queue pattern.
 * Publishing the job (a Stream XADD) and waiting for the reply (a Pub/Sub
 * subscription) are two DIFFERENT Redis primitives used for two
 * different jobs - see the Phase 7 write-up for why a durable log is the
 * wrong tool for "wake up the one specific waiter."
 */
@Injectable()
export class InvocationDispatchService implements OnModuleInit, OnModuleDestroy {
  // Pub/Sub requires a DEDICATED connection: once a client calls
  // .subscribe(), that connection can no longer issue normal commands.
  // duplicate() clones the connection settings into a second, independent
  // client, so the main REDIS_CLIENT stays free for XADD and everything
  // else the app does.
  private readonly subscriber: Redis;
  private readonly waiters = new Map<string, (outcome: ExecutionOutcome) => void>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    this.subscriber = this.redis.duplicate();
  }

  onModuleInit() {
    this.subscriber.on('message', (channel: string, message: string) => {
      const resolve = this.waiters.get(channel);
      if (resolve) {
        this.waiters.delete(channel);
        resolve(JSON.parse(message));
      }
    });
  }

  async onModuleDestroy() {
    await this.subscriber.quit();
  }

  /**
   * Dispatches one invocation and waits for its reply. Throws (never
   * returns an ExecutionOutcome) if NO worker responds within the
   * dispatch window - that is a PLATFORM-level failure ("nobody was
   * available to even try"), categorically different from a function
   * legitimately timing out inside its own container, and callers must
   * be able to tell the two apart.
   */
  async dispatch(job: InvocationJob): Promise<ExecutionOutcome> {
    const correlationId = crypto.randomUUID();
    const channel = invocationResultChannel(correlationId);
    const dispatchTimeoutMs = Number(
      process.env.INVOCATION_DISPATCH_TIMEOUT_MS ?? job.timeoutMs + DISPATCH_TIMEOUT_BUFFER_MS,
    );

    const resultPromise = new Promise<ExecutionOutcome>((resolve, reject) => {
      this.waiters.set(channel, resolve);
      setTimeout(() => {
        if (this.waiters.delete(channel)) {
          reject(new Error('No worker responded in time'));
        }
      }, dispatchTimeoutMs);
    });
    // Same trap as Phase 1's handlerPromise guard: the code below doesn't
    // reach `await resultPromise` until AFTER subscribing and XADD-ing,
    // both of which yield to the event loop. If the timeout above fires
    // during that gap (very possible with a short dispatchTimeoutMs
    // under load), resultPromise rejects before anything has attached a
    // handler to it - a real, Node-level unhandled rejection, even
    // though the `await resultPromise` a few lines down would have
    // caught it perfectly fine once execution got there. Attaching a
    // no-op handler immediately closes that gap without affecting the
    // real `await resultPromise` result below - multiple handlers on one
    // promise all run independently.
    resultPromise.catch(() => {});

    // MUST subscribe before publishing. Pub/Sub has no memory of
    // messages sent before a subscriber existed - if a worker somehow
    // replied before this line ran, that reply would simply vanish, and
    // this request would hang until its own timeout fired for no reason.
    await this.subscriber.subscribe(channel);
    try {
      await this.redis.xadd(
        INVOCATION_STREAM_KEY, '*',
        'correlationId', correlationId,
        'imageTag', job.imageTag,
        'event', JSON.stringify(job.event ?? {}),
        'timeoutMs', String(job.timeoutMs),
        'memoryMb', String(job.memoryMb),
      );
      return await resultPromise;
    } finally {
      await this.subscriber.unsubscribe(channel);
    }
  }
}
