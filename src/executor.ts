/**
 * The Execution Runtime - Phase 1.
 *
 * This is the smallest possible version of the box labelled "Execution
 * Runtime" in the platform architecture: given a path to a file that
 * exports a Lambda-style `handler`, load it and call it with an event,
 * safely enough that a misbehaving handler can never take this process
 * down with it.
 *
 * Nothing here talks to a network, a database, or a container - that's
 * later phases. This file's only job is the core loop:
 *   load code -> call handler(event) -> report what happened.
 */
import path from 'node:path';

export type ExecutionOutcome =
  | { status: 'success'; result: unknown; durationMs: number }
  | { status: 'error'; error: string; durationMs: number }
  | { status: 'timeout'; durationMs: number };

export interface ExecuteOptions {
  /** Milliseconds to wait before giving up on the handler. Default: 3000. */
  timeoutMs?: number;
}

/**
 * A private sentinel type. Promise.race() rejects with whatever the loser
 * rejected with - if a real handler error and "the timer went off" both
 * just threw generic Errors, we'd have no reliable way to tell them apart
 * afterwards other than fragile string-matching on the message. Using a
 * distinct subclass lets us tell them apart with `instanceof`.
 */
class TimeoutMarker extends Error {}

export async function executeFunction(
  functionPath: string,
  event: unknown,
  options: ExecuteOptions = {},
): Promise<ExecutionOutcome> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const start = Date.now();

  // --- Step 1 & 2: dynamically load the module, validate the contract ---
  let mod: { handler?: unknown };
  try {
    const resolved = require.resolve(path.resolve(functionPath));
    // require() caches modules by resolved absolute path. That's normally
    // a *feature* (it's the mechanism a later "warm start" will lean on -
    // load once, reuse the already-initialized module on every subsequent
    // invocation). Here, in a single short-lived CLI process, it's mostly
    // invisible - but it matters a lot in tests, where multiple test cases
    // run in one process and might load different content at the same
    // path over time. Deleting the cache entry before every load keeps
    // this function's behavior predictable regardless of caller.
    delete require.cache[resolved];
    mod = require(resolved);
  } catch (err) {
    // A module that fails to load (syntax error, file doesn't exist) is a
    // PLATFORM-detected failure - the user's code never got a chance to
    // run at all. It still needs to come back as a structured outcome,
    // never as an uncaught exception that kills this process.
    return {
      status: 'error',
      error: `Failed to load function module: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }

  if (typeof mod.handler !== 'function') {
    return {
      status: 'error',
      error: `Module at "${functionPath}" does not export a "handler" function`,
      durationMs: Date.now() - start,
    };
  }
  const handler = mod.handler as (event: unknown) => unknown;

  // --- Step 3: call the handler, whether it's async or plain-synchronous ---
  // Promise.resolve().then(() => handler(event)) normalizes every possible
  // shape of handler into a single Promise:
  //   - a synchronous return value  -> becomes an already-resolved promise
  //   - a synchronous throw         -> becomes a rejected promise
  //   - an async function's Promise -> passes through untouched
  // This is what lets functions/sync.js and functions/hello.js run through
  // exactly the same code path below.
  const handlerPromise = Promise.resolve().then(() => handler(event));

  // Attach a no-op rejection handler immediately. This does NOT swallow
  // the error for the logic below - Promise.race still observes the real
  // rejection. It only prevents Node from logging an
  // "UnhandledPromiseRejectionWarning" for the specific case where the
  // *timeout* wins the race first, and this promise goes on to reject on
  // its own schedule afterwards, with nothing else listening to it.
  handlerPromise.catch(() => {});

  // --- Step 4: race the handler against a timeout ---
  let timer!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutMarker()), timeoutMs);
  });

  try {
    const result = await Promise.race([handlerPromise, timeoutPromise]);
    return { status: 'success', result, durationMs: Date.now() - start };
  } catch (err) {
    // --- Step 5: tell "the timer won" apart from "the handler failed" ---
    if (err instanceof TimeoutMarker) {
      // Documented Phase 1 limitation: handlerPromise is still running in
      // the background right now, forever, in the case of functions/hangs.js.
      // We have no way to forcibly kill in-process JS execution - that gap
      // is exactly what process/container isolation closes in Phase 2.
      return { status: 'timeout', durationMs: Date.now() - start };
    }
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    // --- Step 6 (duration is measured throughout above) + cleanup ---
    // Always clear the timer, whichever side won the race. An uncleared
    // timer is a leaked handle - a small thing here, but "did you clean
    // up the resource regardless of which path you took" is the exact
    // habit the real Execution Manager (Part 3.8) depends on at scale.
    clearTimeout(timer);
  }
}
