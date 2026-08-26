/**
 * CLI entry point for Phase 2.
 *
 * Usage:
 *   npm run start:container -- functions/hello.js '{"name":"world"}'
 *
 * Pure plumbing around executeInContainer - the actual platform logic
 * lives in containerExecutor.ts.
 */
import { executeInContainer } from './containerExecutor';

async function main() {
  const [, , functionPath, eventArg] = process.argv;

  if (!functionPath) {
    console.error('Usage: npm run start:container -- <path-to-function.js> [eventJson]');
    process.exit(1);
  }

  let event: unknown = {};
  if (eventArg) {
    try {
      event = JSON.parse(eventArg);
    } catch {
      console.error('Event argument must be valid JSON');
      process.exit(1);
    }
  }

  const outcome = await executeInContainer(functionPath, event);
  console.log(JSON.stringify(outcome, null, 2));
}

main();
