// The Execution Runtime shim - runs INSIDE the container, as its
// entrypoint. Conceptually this is a miniature version of what AWS calls
// the "Runtime Interface Client": the small piece of code that adapts the
// platform's calling convention to the user's handler.
//
// Notice what's absent compared to Phase 1's executor: there is no
// timeout logic here. The container is the enforcement boundary now - if
// this process runs too long, the HOST kills the whole container from
// the outside. This file only needs to worry about running the handler
// once and reporting what happened.
const fs = require('fs');

async function main() {
  const start = Date.now();
  let outcome;

  try {
    const event = JSON.parse(fs.readFileSync('/var/task/event.json', 'utf8'));

    const handlerPath = '/var/task/handler.js';
    delete require.cache[require.resolve(handlerPath)];
    const mod = require(handlerPath);

    if (typeof mod.handler !== 'function') {
      throw new Error('Module does not export a "handler" function');
    }

    // Same normalization trick as Phase 1: this works whether handler.js
    // is sync or async.
    const result = await Promise.resolve().then(() => mod.handler(event));
    outcome = { status: 'success', result, durationMs: Date.now() - start };
  } catch (err) {
    outcome = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }

  // The ONLY write this process performs. /output is the sole writable
  // mount - everything else in the container is read-only, enforced by
  // the host's `docker run --read-only` flag.
  fs.writeFileSync('/output/result.json', JSON.stringify(outcome));
}

main();
