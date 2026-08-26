/**
 * CLI entry point for Phase 1.
 *
 * Usage:
 *   npm start -- functions/hello.js '{"name":"world"}'
 *
 * This file is just plumbing (argv parsing, printing) around
 * `executeFunction` - the actual platform logic lives in executor.ts.
 */
import { executeFunction } from './executor';

async function main() {
  const [, , functionPath, eventArg] = process.argv;

  if (!functionPath) {
    console.error('Usage: npm start -- <path-to-function.js> [eventJson]');
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

  const outcome = await executeFunction(functionPath, event);
  console.log(JSON.stringify(outcome, null, 2));
}

main();
