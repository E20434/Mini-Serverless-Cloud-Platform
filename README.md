# Mini Serverless Cloud Platform

A small, from-scratch, AWS-Lambda-*inspired* (not Lambda-cloned) serverless
platform, built in phases to learn cloud architecture, containers,
distributed systems, networking, security, and observability from the
inside out.

## Phase 1 - Local Function Executor (current)

Goal: given a JS file exporting a Lambda-style `exports.handler = async
(event) => {...}`, load and execute it in-process, safely enough that a
misbehaving handler (throws, hangs, isn't even shaped right) can never
crash the executor itself.

No HTTP, no database, no Docker yet - see `src/executor.ts` for the actual
task list.

### Setup

```
npm install
```

### Run

```
npm start -- functions/hello.js '{"name":"world"}'
npm start -- functions/throws.js
npm start -- functions/hangs.js
npm start -- functions/sync.js
npm start -- functions/no-handler.js
```

### Test

```
npm test
```

(Tests are currently stubbed with `it.todo(...)` in `tests/executor.test.ts`
- filling them in, alongside implementing `executeFunction` in
`src/executor.ts`, is the actual Phase 1 exercise.)
