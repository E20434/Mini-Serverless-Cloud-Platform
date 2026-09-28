# Mini-Cloud CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `mini-cloud` CLI (`cli/` package) that wraps the existing NestJS API so deploying and invoking a function is a first-class command-line workflow instead of hand-rolled `curl`.

**Architecture:** A standalone `cli/` package (own `package.json`/`tsconfig.json`), built on `commander`, with two shared modules (`config.ts` for local profile persistence, `api-client.ts` for a thin `fetch` wrapper with centralized error translation) that every command file depends on. No changes to the existing API.

**Tech Stack:** TypeScript, commander, Node's built-in `fetch`/`FormData`/`Blob` (Node 20, confirmed already in use elsewhere in this project — no HTTP client dependency needed), Jest + ts-jest for the two modules that have real logic.

**Spec:** `docs/superpowers/specs/2026-09-27-mini-cloud-cli-design.md`

## Global Constraints

- Node 20 (matches the rest of this project — confirmed via the Worker's own container logs). `fetch`, `Headers`, `FormData`, `Blob` are runtime globals; no HTTP client dependency.
- No new runtime dependency beyond `commander` (spec's non-goals: no axios, no chalk, no inquirer — YAGNI).
- API key scopes minted by `login` are exactly `["functions:read", "functions:write", "functions:invoke"]` (spec, verbatim).
- Config file path is exactly `~/.mini-cloud/config.json` (via `os.homedir()`), overridable via `MINI_CLOUD_CONFIG_DIR` for tests only.
- Package name `mini-cloud-cli`, bin name `mini-cloud` (spec, verbatim).
- Per the spec's Testing section: only `config.ts` and `api-client.ts` get Jest unit tests. Every command file is a thin wrapper verified manually (Task 10), not unit-tested — this was reviewed and approved as part of the spec, not a shortcut taken here.
- **Standing repo convention (overrides this skill's default "commit each task" step): do NOT run `git commit` for any step in this plan.** Stage changes with `git add` only. The user commits explicitly, separately, when they choose to. Do not add `Co-Authored-By` attribution to any commit message drafted here, if the user later asks you to commit.

## Review Focus

- **`deploy` on a function that already exists** — a reasonable user runs `deploy` again after editing their handler, expecting a new version, not a crash or a duplicate-registration error. Pinned in Task 6 (manual verification: deploy twice, confirm the second run skips registration and goes straight to upload).
- **No profile configured yet (fresh machine)** — running any command before `profile add` should give a clear instruction, not a stack trace reading `undefined.baseUrl`. Pinned in Task 2 (`resolveProfile` Jest test) and re-checked manually in Task 5.
- **`invoke --data` given malformed JSON** — a typo'd `--data '{bad'}` should fail with a clear message before any HTTP call, not an uncaught `JSON.parse` exception. Pinned in Task 7 (manual verification with exact expected output).
- **Build polling that never reaches a terminal status** — if the Worker or CodeBuild is down, `deploy` must give up and tell the user, not hang forever. This is a structural guarantee (`MAX_POLL_ATTEMPTS` is a finite, hard bound in the code — see Task 6) confirmed by code review rather than by forcing a real multi-minute hang in a manual QA pass, since that isn't practical to script reliably.
- **First run on a machine with no `~/.mini-cloud/` directory yet** — `profile add` must create the directory, not throw `ENOENT`. Pinned in Task 2 (`addProfile` Jest test).

---

### Task 1: Scaffold the `cli/` package

**Files:**
- Create: `cli/package.json`
- Create: `cli/tsconfig.json`
- Create: `cli/jest.config.js`
- Create: `cli/src/index.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a buildable, runnable package skeleton (`cli/dist/index.js` after `npm run build`), with a root `commander` program later tasks attach subcommands to.

- [ ] **Step 1: Create `cli/package.json`**

```json
{
  "name": "mini-cloud-cli",
  "version": "0.1.0",
  "private": true,
  "bin": {
    "mini-cloud": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "jest"
  },
  "dependencies": {
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.9",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.5",
    "typescript": "^5.5.3"
  }
}
```

- [ ] **Step 2: Create `cli/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`"DOM"` is in `lib` only so the compiler recognizes the built-in `fetch`/`FormData`/`Blob`/`Headers` globals Node 20 already provides at runtime — this pulls in some browser-only type declarations we'll never use, which is harmless; it's the standard pragmatic way to type Node's native fetch without adding a dependency.

- [ ] **Step 3: Create `cli/jest.config.js`**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
};
```

- [ ] **Step 4: Create `cli/src/index.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('mini-cloud')
  .description('CLI for the mini-cloud serverless platform')
  .version('0.1.0');

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 5: Install dependencies and build**

Run: `cd cli && npm install && npm run build`
Expected: `cli/dist/index.js` exists, no TypeScript errors.

- [ ] **Step 6: Verify the skeleton runs**

Run: `node cli/dist/index.js --help`
Expected: commander's default help output, showing `mini-cloud` as the program name and version `0.1.0`.

- [ ] **Step 7: Stage the change**

```bash
git add cli/package.json cli/tsconfig.json cli/jest.config.js cli/src/index.ts cli/package-lock.json
```

Do not commit (see Global Constraints).

---

### Task 2: `config.ts` — profile persistence

**Files:**
- Create: `cli/src/config.ts`
- Test: `cli/src/config.test.ts`

**Interfaces:**
- Consumes: nothing (pure `fs`/`os`/`path`).
- Produces (used by every command task after this):
  - `interface Profile { baseUrl: string; apiKey: string | null }`
  - `interface CliConfig { currentProfile: string | null; profiles: Record<string, Profile> }`
  - `loadConfig(): CliConfig`
  - `saveConfig(config: CliConfig): void`
  - `addProfile(name: string, baseUrl: string): void`
  - `useProfile(name: string): void`
  - `removeProfile(name: string): void`
  - `setApiKey(profileName: string, apiKey: string): void`
  - `resolveProfile(explicitName?: string): { name: string; profile: Profile }`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/config.test.ts`:

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addProfile,
  loadConfig,
  removeProfile,
  resolveProfile,
  setApiKey,
  useProfile,
} from './config';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cloud-cli-test-'));
  process.env.MINI_CLOUD_CONFIG_DIR = testDir;
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.MINI_CLOUD_CONFIG_DIR;
});

test('loadConfig returns an empty config when no file exists yet', () => {
  expect(loadConfig()).toEqual({ currentProfile: null, profiles: {} });
});

test('addProfile creates the config directory and file on first use', () => {
  addProfile('local', 'http://localhost:3000');
  const config = loadConfig();
  expect(config.profiles.local).toEqual({ baseUrl: 'http://localhost:3000', apiKey: null });
  expect(config.currentProfile).toBe('local');
});

test('addProfile does not overwrite an existing profile\'s saved apiKey', () => {
  addProfile('local', 'http://localhost:3000');
  setApiKey('local', 'mc_abc123');
  addProfile('local', 'http://localhost:4000');
  expect(loadConfig().profiles.local).toEqual({ baseUrl: 'http://localhost:4000', apiKey: 'mc_abc123' });
});

test('useProfile switches the current profile', () => {
  addProfile('local', 'http://localhost:3000');
  addProfile('aws', 'http://1.2.3.4:3000');
  useProfile('aws');
  expect(loadConfig().currentProfile).toBe('aws');
});

test('useProfile throws for an unknown profile name', () => {
  expect(() => useProfile('nope')).toThrow(/No profile named "nope"/);
});

test('resolveProfile falls back to the current profile when no explicit name is given', () => {
  addProfile('local', 'http://localhost:3000');
  const { name, profile } = resolveProfile();
  expect(name).toBe('local');
  expect(profile.baseUrl).toBe('http://localhost:3000');
});

test('resolveProfile throws a clear error when no profile is configured at all', () => {
  expect(() => resolveProfile()).toThrow(/No active profile/);
});

test('removeProfile clears currentProfile if it was the one removed', () => {
  addProfile('local', 'http://localhost:3000');
  removeProfile('local');
  expect(loadConfig().currentProfile).toBeNull();
  expect(loadConfig().profiles.local).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx jest src/config.test.ts`
Expected: FAIL — `Cannot find module './config'` (it doesn't exist yet).

- [ ] **Step 3: Write `cli/src/config.ts`**

```typescript
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Profile {
  baseUrl: string;
  apiKey: string | null;
}

export interface CliConfig {
  currentProfile: string | null;
  profiles: Record<string, Profile>;
}

// A function, not a frozen constant - re-read on every call so tests can
// point this at a throwaway directory via MINI_CLOUD_CONFIG_DIR instead of
// touching the real ~/.mini-cloud on the machine running the tests.
function configDir(): string {
  return process.env.MINI_CLOUD_CONFIG_DIR ?? path.join(os.homedir(), '.mini-cloud');
}

function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function loadConfig(): CliConfig {
  if (!fs.existsSync(configPath())) {
    return { currentProfile: null, profiles: {} };
  }
  return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as CliConfig;
}

export function saveConfig(config: CliConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

export function addProfile(name: string, baseUrl: string): void {
  const config = loadConfig();
  config.profiles[name] = { baseUrl, apiKey: config.profiles[name]?.apiKey ?? null };
  if (!config.currentProfile) {
    config.currentProfile = name;
  }
  saveConfig(config);
}

export function useProfile(name: string): void {
  const config = loadConfig();
  if (!config.profiles[name]) {
    throw new Error(`No profile named "${name}". Run "mini-cloud profile add ${name} --url <baseUrl>" first.`);
  }
  config.currentProfile = name;
  saveConfig(config);
}

export function removeProfile(name: string): void {
  const config = loadConfig();
  delete config.profiles[name];
  if (config.currentProfile === name) {
    config.currentProfile = null;
  }
  saveConfig(config);
}

export function setApiKey(profileName: string, apiKey: string): void {
  const config = loadConfig();
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new Error(`No profile named "${profileName}"`);
  }
  profile.apiKey = apiKey;
  saveConfig(config);
}

export function resolveProfile(explicitName?: string): { name: string; profile: Profile } {
  const config = loadConfig();
  const name = explicitName ?? config.currentProfile ?? undefined;
  if (!name) {
    throw new Error(
      'No active profile. Run "mini-cloud profile add <name> --url <baseUrl>" then "mini-cloud profile use <name>".',
    );
  }
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`No profile named "${name}". Run "mini-cloud profile list" to see available profiles.`);
  }
  return { name, profile };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && npx jest src/config.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Stage the change**

```bash
git add cli/src/config.ts cli/src/config.test.ts
```

Do not commit.

---

### Task 3: `api-client.ts` — thin fetch wrapper with centralized error translation

**Files:**
- Create: `cli/src/api-client.ts`
- Test: `cli/src/api-client.test.ts`

**Interfaces:**
- Consumes: `Profile` from `cli/src/config.ts` (Task 2).
- Produces (used by every command task after this):
  - `class ApiError extends Error { statusCode?: number }`
  - `interface ApiRequestOptions { method?: string; body?: unknown; formData?: FormData; headers?: Record<string, string> }`
  - `interface ApiResponse<T> { data: T; headers: Headers }`
  - `apiRequest<T>(profile: Profile, path: string, options?: ApiRequestOptions): Promise<ApiResponse<T>>`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/api-client.test.ts`:

```typescript
import { apiRequest, ApiError } from './api-client';
import type { Profile } from './config';

const profile: Profile = { baseUrl: 'http://example.test', apiKey: null };

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
});

test('throws a clear ApiError when the network request itself fails', async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
  await expect(apiRequest(profile, '/health')).rejects.toThrow(/Could not reach http:\/\/example\.test/);
});

test('translates a 401 into a re-login message regardless of body shape', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => '',
    headers: new Headers(),
  });
  await expect(apiRequest(profile, '/functions')).rejects.toThrow(/Run 'mini-cloud login' again/);
});

test('surfaces a Nest-style {message} body on other error statuses', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => JSON.stringify({ statusCode: 404, message: 'Function "foo" not found', error: 'Not Found' }),
    headers: new Headers(),
  });
  const err: ApiError = await apiRequest(profile, '/functions/foo').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.message).toBe('Function "foo" not found');
  expect(err.statusCode).toBe(404);
});

test('falls back to the raw response body when it is not JSON', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    text: async () => 'upstream connection failed',
    headers: new Headers(),
  });
  await expect(apiRequest(profile, '/functions')).rejects.toThrow('upstream connection failed');
});

test('sends the saved API key as a Bearer token by default', async () => {
  const authedProfile: Profile = { baseUrl: 'http://example.test', apiKey: 'mc_abc123' };
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    headers: new Headers(),
  });
  await apiRequest(authedProfile, '/functions');
  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers['Authorization']).toBe('Bearer mc_abc123');
});

test('an explicit Authorization header overrides the saved API key', async () => {
  const authedProfile: Profile = { baseUrl: 'http://example.test', apiKey: 'mc_stale' };
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    headers: new Headers(),
  });
  await apiRequest(authedProfile, '/auth/api-keys', {
    method: 'POST',
    headers: { Authorization: 'Bearer fresh-jwt' },
  });
  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(init.headers['Authorization']).toBe('Bearer fresh-jwt');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx jest src/api-client.test.ts`
Expected: FAIL — `Cannot find module './api-client'`.

- [ ] **Step 3: Write `cli/src/api-client.ts`**

```typescript
import type { Profile } from './config';

export class ApiError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  formData?: FormData;
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

export async function apiRequest<T>(
  profile: Profile,
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponse<T>> {
  const url = `${profile.baseUrl}${path}`;

  // Default to the saved API key, but let an explicit header win - the
  // one place this matters today is login.ts, which must authenticate its
  // second call (minting the API key) with the fresh JWT it just got back,
  // not whatever API key (possibly stale, possibly absent) is already on
  // the profile.
  const headers: Record<string, string> = {};
  if (profile.apiKey) {
    headers['Authorization'] = `Bearer ${profile.apiKey}`;
  }
  if (options.headers) {
    Object.assign(headers, options.headers);
  }

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, { method: options.method ?? 'GET', headers, body });
  } catch {
    throw new ApiError(`Could not reach ${profile.baseUrl} - is the profile URL correct and the service running?`);
  }

  if (!response.ok) {
    const text = await response.text();
    let message: string;
    if (response.status === 401) {
      message = "Invalid or expired API key. Run 'mini-cloud login' again.";
    } else {
      try {
        const parsed = JSON.parse(text) as { message?: string | string[] };
        message = Array.isArray(parsed.message) ? parsed.message.join(', ') : parsed.message ?? text;
      } catch {
        message = text || response.statusText;
      }
    }
    throw new ApiError(message, response.status);
  }

  const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  return { data, headers: response.headers };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && npx jest src/api-client.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Stage the change**

```bash
git add cli/src/api-client.ts cli/src/api-client.test.ts
```

Do not commit.

---

### Task 4: `profile` command

**Files:**
- Create: `cli/src/commands/profile.ts`

**Interfaces:**
- Consumes: `loadConfig`, `addProfile`, `useProfile`, `removeProfile` from `cli/src/config.ts` (Task 2).
- Produces: `registerProfileCommands(program: Command): void` (wired in Task 9).

- [ ] **Step 1: Create `cli/src/commands/profile.ts`**

```typescript
import { Command } from 'commander';
import { addProfile, loadConfig, removeProfile, useProfile } from '../config';

export function registerProfileCommands(program: Command): void {
  const profile = program.command('profile').description('Manage backend profiles');

  profile
    .command('add <name>')
    .requiredOption('--url <baseUrl>', 'Base URL of the mini-cloud API')
    .description('Add a new backend profile')
    .action((name: string, opts: { url: string }) => {
      addProfile(name, opts.url);
      console.log(`Added profile "${name}" (${opts.url})`);
    });

  profile
    .command('use <name>')
    .description('Set the active profile')
    .action((name: string) => {
      useProfile(name);
      console.log(`Now using profile "${name}"`);
    });

  profile
    .command('list')
    .description('List configured profiles')
    .action(() => {
      const config = loadConfig();
      const names = Object.keys(config.profiles);
      if (names.length === 0) {
        console.log('No profiles configured. Run "mini-cloud profile add <name> --url <baseUrl>".');
        return;
      }
      for (const name of names) {
        const marker = name === config.currentProfile ? '*' : ' ';
        console.log(`${marker} ${name}  ${config.profiles[name].baseUrl}`);
      }
    });

  profile
    .command('remove <name>')
    .description('Remove a profile')
    .action((name: string) => {
      removeProfile(name);
      console.log(`Removed profile "${name}"`);
    });
}
```

This task has no Jest tests of its own (Global Constraints) — it is manually verified in Task 9, once it's wired into `index.ts` and there's a real binary to run.

- [ ] **Step 2: Stage the change**

```bash
git add cli/src/commands/profile.ts
```

Do not commit.

---

### Task 5: `register` and `login` commands

**Files:**
- Create: `cli/src/commands/register.ts`
- Create: `cli/src/commands/login.ts`

**Interfaces:**
- Consumes: `apiRequest` from `cli/src/api-client.ts` (Task 3); `resolveProfile`, `setApiKey` from `cli/src/config.ts` (Task 2).
- Produces: `registerRegisterCommand(program: Command): void`, `registerLoginCommand(program: Command): void` (wired in Task 9).

- [ ] **Step 1: Create `cli/src/commands/register.ts`**

```typescript
import { Command } from 'commander';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

export function registerRegisterCommand(program: Command): void {
  program
    .command('register')
    .description('Create a new account on the active backend')
    .requiredOption('--email <email>')
    .requiredOption('--password <password>')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(async (opts: { email: string; password: string; profile?: string }) => {
      const { profile } = resolveProfile(opts.profile);
      const { data } = await apiRequest<{ userId: string }>(profile, '/auth/register', {
        method: 'POST',
        body: { email: opts.email, password: opts.password },
      });
      console.log(`Account created (userId: ${data.userId}). Run "mini-cloud login" next.`);
    });
}
```

- [ ] **Step 2: Create `cli/src/commands/login.ts`**

```typescript
import { Command } from 'commander';
import * as os from 'node:os';
import { apiRequest } from '../api-client';
import { resolveProfile, setApiKey } from '../config';

// Fixed, not user-configurable - matches the spec exactly. A CLI session
// needs every scope the CLI itself might use across its commands.
const CLI_KEY_SCOPES = ['functions:read', 'functions:write', 'functions:invoke'];

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Log in and save a long-lived API key for future commands')
    .requiredOption('--email <email>')
    .requiredOption('--password <password>')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(async (opts: { email: string; password: string; profile?: string }) => {
      const { name, profile } = resolveProfile(opts.profile);

      const loginResult = await apiRequest<{ accessToken: string }>(profile, '/auth/login', {
        method: 'POST',
        body: { email: opts.email, password: opts.password },
      });

      // Authenticate THIS call with the fresh JWT explicitly - profile.apiKey
      // may be null (first login) or a stale previous key (re-login); either
      // way it must not be what authorizes minting the new one.
      const keyResult = await apiRequest<{ id: string; name: string; scopes: string[]; rawKey: string }>(
        profile,
        '/auth/api-keys',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${loginResult.data.accessToken}` },
          body: { name: `cli-${os.hostname()}`, scopes: CLI_KEY_SCOPES },
        },
      );

      setApiKey(name, keyResult.data.rawKey);
      console.log(`Logged in. Saved API key "${keyResult.data.name}" to profile "${name}".`);
    });
}
```

- [ ] **Step 3: Build and manually verify against the local stack**

Prerequisite: the local docker-compose stack is running (`npm run compose:up` from the repo root) and an account exists (or create one with the CLI itself once Task 9 wires everything together — for now, this step can wait until Task 9/10 if no account exists yet; if one already exists from earlier manual testing, verify now).

Run: `cd cli && npm run build`
Expected: no TypeScript errors.

Full functional verification of `login` (does it actually reach `/auth/login` and `/auth/api-keys` and save the key) happens in Task 9 once `index.ts` wires this command in — this step only confirms it compiles cleanly against `api-client.ts`'s and `config.ts`'s real types.

- [ ] **Step 4: Stage the change**

```bash
git add cli/src/commands/register.ts cli/src/commands/login.ts
```

Do not commit.

---

### Task 6: `deploy` command

**Files:**
- Create: `cli/src/commands/deploy.ts`

**Interfaces:**
- Consumes: `apiRequest`, `ApiError` from `cli/src/api-client.ts` (Task 3); `resolveProfile` from `cli/src/config.ts` (Task 2).
- Produces: `registerDeployCommand(program: Command): void` (wired in Task 9).

- [ ] **Step 1: Create `cli/src/commands/deploy.ts`**

```typescript
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ApiError, apiRequest } from '../api-client';
import { resolveProfile } from '../config';

interface FunctionRecord {
  id: string;
  userId: string;
  name: string;
  memoryMb: number;
  timeoutMs: number;
  createdAt: string;
}

interface BuildRecord {
  id: string;
  functionId: string;
  sourceObjectKey: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  imageTag: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const POLL_INTERVAL_MS = 2000;
// A hard, finite bound - 2 minutes. If a build hasn't reached SUCCESS or
// FAILED by then (Worker down, CodeBuild stuck), the CLI gives up and says
// so rather than hanging forever. Both CodeBuild and the local Docker
// executor finish well under this in normal operation.
const MAX_POLL_ATTEMPTS = 60;

export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <file>')
    .description('Deploy a function: create it if needed, upload source, and wait for the build')
    .requiredOption('--name <name>', 'Function name')
    .option('--memory <mb>', 'Memory in MB (first deploy only)', (v) => Number(v))
    .option('--timeout <ms>', 'Timeout in ms (first deploy only)', (v) => Number(v))
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(
      async (
        file: string,
        opts: { name: string; memory?: number; timeout?: number; profile?: string },
      ) => {
        const { profile } = resolveProfile(opts.profile);

        try {
          await apiRequest<FunctionRecord>(profile, `/functions/${opts.name}`);
          console.log(`Function "${opts.name}" already exists, deploying a new version.`);
        } catch (err) {
          if (err instanceof ApiError && err.statusCode === 404) {
            await apiRequest<FunctionRecord>(profile, '/functions', {
              method: 'POST',
              body: { name: opts.name, memoryMb: opts.memory, timeoutMs: opts.timeout },
            });
            console.log(`Function "${opts.name}" registered (first deploy).`);
          } else {
            throw err;
          }
        }

        const absolutePath = path.resolve(file);
        const fileBuffer = fs.readFileSync(absolutePath);
        const formData = new FormData();
        formData.append('source', new Blob([fileBuffer]), path.basename(absolutePath));

        const { data: build } = await apiRequest<{ buildId: string; status: string }>(
          profile,
          `/functions/${opts.name}/versions`,
          { method: 'POST', formData },
        );
        console.log(`Source uploaded (${fileBuffer.length} bytes). Build queued...`);

        for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          const { data: current } = await apiRequest<BuildRecord>(
            profile,
            `/functions/${opts.name}/builds/${build.buildId}`,
          );

          if (current.status === 'SUCCESS') {
            console.log(`Build succeeded. Image: ${current.imageTag}`);
            return;
          }
          if (current.status === 'FAILED') {
            console.error(`Build failed: ${current.errorMessage}`);
            process.exitCode = 1;
            return;
          }
          console.log('Build running...');
        }

        console.error(
          `Build did not finish within ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s - check the platform's build logs.`,
        );
        process.exitCode = 1;
      },
    );
}
```

- [ ] **Step 2: Build**

Run: `cd cli && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 3: Manually verify the "already exists" path (Review Focus item 1)**

This needs the full CLI wired up, so if Task 9 isn't done yet, come back to this step after it is. Once wired:

Run:
```bash
echo 'module.exports.handler = async (e) => ({ v: 1, input: e });' > /tmp/h.js
mini-cloud deploy /tmp/h.js --name review-focus-fn
mini-cloud deploy /tmp/h.js --name review-focus-fn
```
Expected: first run prints `Function "review-focus-fn" registered (first deploy).`; second run prints `Function "review-focus-fn" already exists, deploying a new version.` — no error, no duplicate-registration failure, on either run.

- [ ] **Step 4: Stage the change**

```bash
git add cli/src/commands/deploy.ts
```

Do not commit.

---

### Task 7: `invoke` command

**Files:**
- Create: `cli/src/commands/invoke.ts`

**Interfaces:**
- Consumes: `apiRequest` from `cli/src/api-client.ts` (Task 3); `resolveProfile` from `cli/src/config.ts` (Task 2).
- Produces: `registerInvokeCommand(program: Command): void` (wired in Task 9).

- [ ] **Step 1: Create `cli/src/commands/invoke.ts`**

```typescript
import { Command } from 'commander';
import * as fs from 'node:fs';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

interface InvokeResponse {
  result?: unknown;
  errorMessage?: string;
  durationMs: number;
}

export function registerInvokeCommand(program: Command): void {
  program
    .command('invoke <name>')
    .description('Invoke a deployed function')
    .option('--data <json>', 'Inline JSON event body')
    .option('--file <path>', 'Path to a JSON file containing the event body')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(
      async (
        name: string,
        opts: { data?: string; file?: string; profile?: string },
      ) => {
        const { profile } = resolveProfile(opts.profile);

        let event: unknown = {};
        if (opts.data) {
          try {
            event = JSON.parse(opts.data);
          } catch {
            console.error(`--data is not valid JSON: ${opts.data}`);
            process.exitCode = 1;
            return;
          }
        } else if (opts.file) {
          const raw = fs.readFileSync(opts.file, 'utf8');
          try {
            event = JSON.parse(raw);
          } catch {
            console.error(`${opts.file} does not contain valid JSON`);
            process.exitCode = 1;
            return;
          }
        }

        const { data, headers } = await apiRequest<InvokeResponse>(profile, `/functions/${name}/invoke`, {
          method: 'POST',
          body: event,
        });

        const functionError = headers.get('x-function-error');
        if (functionError) {
          console.error(`${RED}${functionError}: ${data.errorMessage}${RESET}`);
          process.exitCode = 1;
          return;
        }

        console.log(JSON.stringify(data.result, null, 2));
        console.log(`(${data.durationMs}ms)`);
      },
    );
}
```

`Headers.get()` is case-insensitive per the Fetch spec, so `'x-function-error'` matches regardless of how the server cased it.

- [ ] **Step 2: Build**

Run: `cd cli && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 3: Manually verify malformed `--data` (Review Focus item 3)**

Once wired up in Task 9:

Run: `mini-cloud invoke some-fn --data '{bad'`
Expected: prints `--data is not valid JSON: {bad` and exits non-zero — no raw `JSON.parse` stack trace, and no HTTP request is made (verify by checking there's no matching entry in the API's access logs for this attempt, if you want to be thorough).

- [ ] **Step 4: Stage the change**

```bash
git add cli/src/commands/invoke.ts
```

Do not commit.

---

### Task 8: `list`, `get`, `logs`, `metrics`, `rm` commands

**Files:**
- Create: `cli/src/commands/list.ts`
- Create: `cli/src/commands/get.ts`
- Create: `cli/src/commands/logs.ts`
- Create: `cli/src/commands/metrics.ts`
- Create: `cli/src/commands/rm.ts`

**Interfaces:**
- Consumes: `apiRequest` from `cli/src/api-client.ts` (Task 3); `resolveProfile` from `cli/src/config.ts` (Task 2).
- Produces: `registerListCommand`, `registerGetCommand`, `registerLogsCommand`, `registerMetricsCommand`, `registerRmCommand` (each `(program: Command): void`, wired in Task 9).

These five are grouped into one task because they're structurally identical (GET-or-DELETE, print) — a reviewer would not meaningfully approve one while rejecting another.

- [ ] **Step 1: Create `cli/src/commands/list.ts`**

```typescript
import { Command } from 'commander';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

interface FunctionSummary {
  name: string;
  memoryMb: number;
  timeoutMs: number;
  createdAt: string;
}

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List your functions')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .option('--json', 'Print raw JSON instead of a table')
    .action(async (opts: { profile?: string; json?: boolean }) => {
      const { profile } = resolveProfile(opts.profile);
      const { data } = await apiRequest<FunctionSummary[]>(profile, '/functions');

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (data.length === 0) {
        console.log('No functions deployed yet. Run "mini-cloud deploy <file> --name <fn>".');
        return;
      }
      for (const fn of data) {
        console.log(`${fn.name}  memory=${fn.memoryMb}MB  timeout=${fn.timeoutMs}ms  created=${fn.createdAt}`);
      }
    });
}
```

- [ ] **Step 2: Create `cli/src/commands/get.ts`**

```typescript
import { Command } from 'commander';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

export function registerGetCommand(program: Command): void {
  program
    .command('get <name>')
    .description('Show details for a single function')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(async (name: string, opts: { profile?: string }) => {
      const { profile } = resolveProfile(opts.profile);
      const { data } = await apiRequest<Record<string, unknown>>(profile, `/functions/${name}`);
      console.log(JSON.stringify(data, null, 2));
    });
}
```

- [ ] **Step 3: Create `cli/src/commands/logs.ts`**

```typescript
import { Command } from 'commander';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

interface InvocationRecord {
  id: string;
  status: string;
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
}

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <name>')
    .description('Show recent invocations for a function')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .option('--json', 'Print raw JSON instead of a table')
    .action(async (name: string, opts: { profile?: string; json?: boolean }) => {
      const { profile } = resolveProfile(opts.profile);
      const { data } = await apiRequest<InvocationRecord[]>(profile, `/functions/${name}/invocations`);

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (data.length === 0) {
        console.log('No invocations yet.');
        return;
      }
      for (const inv of data) {
        const errSuffix = inv.errorMessage ? ` - ${inv.errorMessage}` : '';
        console.log(`${inv.createdAt}  ${inv.status}  ${inv.durationMs}ms${errSuffix}`);
      }
    });
}
```

- [ ] **Step 4: Create `cli/src/commands/metrics.ts`**

```typescript
import { Command } from 'commander';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

export function registerMetricsCommand(program: Command): void {
  program
    .command('metrics <name>')
    .description('Show a rolling metrics summary for a function')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(async (name: string, opts: { profile?: string }) => {
      const { profile } = resolveProfile(opts.profile);
      const { data } = await apiRequest<Record<string, unknown>>(profile, `/functions/${name}/metrics`);
      console.log(JSON.stringify(data, null, 2));
    });
}
```

- [ ] **Step 5: Create `cli/src/commands/rm.ts`**

```typescript
import { Command } from 'commander';
import * as readline from 'node:readline/promises';
import { apiRequest } from '../api-client';
import { resolveProfile } from '../config';

export function registerRmCommand(program: Command): void {
  program
    .command('rm <name>')
    .description('Delete a function')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--profile <name>', 'Profile to use instead of the current one')
    .action(async (name: string, opts: { yes?: boolean; profile?: string }) => {
      const { profile } = resolveProfile(opts.profile);

      if (!opts.yes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          `Delete function "${name}"? This cannot be undone. Type "yes" to confirm: `,
        );
        rl.close();
        if (answer.trim().toLowerCase() !== 'yes') {
          console.log('Aborted.');
          return;
        }
      }

      await apiRequest(profile, `/functions/${name}`, { method: 'DELETE' });
      console.log(`Deleted function "${name}".`);
    });
}
```

- [ ] **Step 6: Build**

Run: `cd cli && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Stage the change**

```bash
git add cli/src/commands/list.ts cli/src/commands/get.ts cli/src/commands/logs.ts cli/src/commands/metrics.ts cli/src/commands/rm.ts
```

Do not commit.

---

### Task 9: Wire everything into `index.ts`, `npm link`, and `cli/README.md`

**Files:**
- Modify: `cli/src/index.ts`
- Create: `cli/README.md`

**Interfaces:**
- Consumes: every `register*Command`/`registerProfileCommands` function from Tasks 4–8.
- Produces: a real, globally-runnable `mini-cloud` command.

- [ ] **Step 1: Rewrite `cli/src/index.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { registerDeployCommand } from './commands/deploy';
import { registerGetCommand } from './commands/get';
import { registerInvokeCommand } from './commands/invoke';
import { registerListCommand } from './commands/list';
import { registerLoginCommand } from './commands/login';
import { registerLogsCommand } from './commands/logs';
import { registerMetricsCommand } from './commands/metrics';
import { registerProfileCommands } from './commands/profile';
import { registerRegisterCommand } from './commands/register';
import { registerRmCommand } from './commands/rm';

const program = new Command();
program.name('mini-cloud').description('CLI for the mini-cloud serverless platform').version('0.1.0');

registerProfileCommands(program);
registerRegisterCommand(program);
registerLoginCommand(program);
registerDeployCommand(program);
registerInvokeCommand(program);
registerListCommand(program);
registerGetCommand(program);
registerLogsCommand(program);
registerMetricsCommand(program);
registerRmCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Build and link**

Run: `cd cli && npm run build && npm link`
Expected: npm reports a global symlink created; `mini-cloud --help` (run from anywhere, not just `cli/`) now lists all ten command groups (`profile`, `register`, `login`, `deploy`, `invoke`, `list`, `get`, `logs`, `metrics`, `rm`).

- [ ] **Step 3: Create `cli/README.md`**

```markdown
# mini-cloud CLI

A command-line client for the mini-cloud serverless platform's REST API -
wraps auth, function deployment, and invocation so day-to-day use doesn't
require hand-rolled `curl`.

## Install

```bash
cd cli
npm install
npm run build
npm link
```

This puts a `mini-cloud` command on your PATH (via npm's global bin
directory), without publishing anywhere.

## Quick start

```bash
# Point a profile at a backend - your local docker-compose stack, or a
# real deployment (e.g. the AWS one from Phase 13).
mini-cloud profile add local --url http://localhost:3000
mini-cloud profile use local

# One-time account creation on that backend.
mini-cloud register --email you@example.com --password 'Sup3rSecret!'

# Logs in, then mints and saves a long-lived API key - no re-login every
# 2 hours the way a raw JWT would require.
mini-cloud login --email you@example.com --password 'Sup3rSecret!'

# Deploy: creates the function on first use, uploads the source, waits
# for the build.
mini-cloud deploy ./handler.js --name my-fn

# Invoke it.
mini-cloud invoke my-fn --data '{"hello":"world"}'

# Everything else.
mini-cloud list
mini-cloud get my-fn
mini-cloud logs my-fn
mini-cloud metrics my-fn
mini-cloud rm my-fn
```

## Multiple backends

```bash
mini-cloud profile add aws --url http://<api-public-ip>:3000
mini-cloud profile use aws
# ...or run a single command against a non-default profile:
mini-cloud list --profile local
```

Profiles (including saved API keys) are stored in `~/.mini-cloud/config.json`.
```

- [ ] **Step 4: Manually verify the full command set against the local stack**

Prerequisite: `npm run compose:up` from the repo root (Postgres/Redis/MinIO/Worker/API all up locally on `http://localhost:3000`).

Run, in order:
```bash
mini-cloud profile add local --url http://localhost:3000
mini-cloud profile use local
mini-cloud register --email cli-smoke@example.com --password 'Sup3rSecret!'
mini-cloud login --email cli-smoke@example.com --password 'Sup3rSecret!'
mini-cloud list
```
Expected: `register` prints a `userId`; `login` prints "Logged in. Saved API key..."; `list` prints "No functions deployed yet." (empty account).

- [ ] **Step 5: Stage the change**

```bash
git add cli/src/index.ts cli/README.md
```

Do not commit.

---

### Task 10: End-to-end verification against the local docker-compose stack

**Files:** none (verification only).

**Interfaces:** none — this task consumes the fully-wired CLI from Task 9 and produces confidence, not code.

- [ ] **Step 1: Full deploy + invoke round trip**

Continuing from Task 9's Step 4 (profile configured, logged in):

```bash
cat > /tmp/e2e-handler.js <<'EOF'
module.exports.handler = async (event) => {
  return { message: "hello from the mini-cloud CLI", input: event };
};
EOF

mini-cloud deploy /tmp/e2e-handler.js --name cli-e2e-fn
mini-cloud invoke cli-e2e-fn --data '{"ping":"pong"}'
mini-cloud logs cli-e2e-fn
mini-cloud metrics cli-e2e-fn
mini-cloud get cli-e2e-fn
```

Expected:
- `deploy` prints "registered (first deploy)", then "Source uploaded...", then "Build running..." zero or more times, then "Build succeeded. Image: ...".
- `invoke` prints `{"message": "hello from the mini-cloud CLI", "input": {"ping": "pong"}}` and a duration in parentheses, exit code 0.
- `logs` shows one `SUCCESS` row with a duration.
- `metrics` prints a JSON object with `totalInvocations: 1`.
- `get` prints the function's JSON record.

- [ ] **Step 2: Re-deploy (Review Focus item 1, end-to-end)**

```bash
mini-cloud deploy /tmp/e2e-handler.js --name cli-e2e-fn
```
Expected: prints "already exists, deploying a new version." (not "registered"), then proceeds through the same upload/build sequence, ending in a second successful build.

- [ ] **Step 3: Error-path invoke**

```bash
cat > /tmp/e2e-throws.js <<'EOF'
module.exports.handler = async () => {
  throw new Error("deliberate failure for CLI verification");
};
EOF
mini-cloud deploy /tmp/e2e-throws.js --name cli-e2e-throws
mini-cloud invoke cli-e2e-throws
```
Expected: `invoke` prints the error line in red (`Unhandled: deliberate failure for CLI verification`) and exits non-zero — confirming the `X-Function-Error` header path works end-to-end, not just against a mocked response.

- [ ] **Step 4: Clean up the test functions**

```bash
mini-cloud rm cli-e2e-fn --yes
mini-cloud rm cli-e2e-throws --yes
mini-cloud list
```
Expected: `list` no longer shows either function.

- [ ] **Step 5: Report results**

No commit for this task (verification only, no files changed). If any step's actual output didn't match "Expected," stop and report the mismatch instead of proceeding — this is the plan's real acceptance test for the whole feature.

---

## Self-Review

**Spec coverage:** Every command in the spec's table (profile add/list/use/remove, register, login, deploy, invoke, list, get, logs, metrics, rm) has an owning task. The login flow, deploy flow, invoke flow, error handling, config model, and testing approach all match the spec's corresponding sections exactly (including the `rawKey` field name and 404-based existence check, both confirmed by reading the actual API source rather than assumed).

**Placeholder scan:** No TBD/TODO; every step shows real code or an exact command with an exact expected output.

**Type consistency:** `Profile`/`CliConfig` (Task 2) are the same shape imported by Task 3 (`ApiError`, `apiRequest`) and every command task. `apiRequest<T>`'s signature (Task 3) is used identically by every command task (login, register, deploy, invoke, list, get, logs, metrics, rm). `resolveProfile`'s return shape (`{ name, profile }`) matches its usage in `login.ts` (needs `name` to call `setApiKey`) and every other command (only needs `profile`).

**Review Focus:** all five items are pinned — two by Jest tests in Task 2, two by manual verification steps with exact expected output (Task 6 Step 3, Task 7 Step 3, both repeated end-to-end in Task 10), and one (build-polling timeout) by a structural code guarantee explicitly called out as such rather than falsely claimed as tested.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-27-mini-cloud-cli.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, then one fresh reviewer checks the whole branch at the end. Cheapest and fastest; no independent review until the end.

For this plan I recommend **Native**: the tasks are small, mostly independent thin wrappers around an API that's already fully built and tested elsewhere, and a mistake here (a wrong field name, say) would show up immediately in Task 9/10's manual verification rather than silently — the cost of a shipped mistake is low and cheap to catch, so the extra cost of a fresh subagent + reviewer per task isn't buying much here.
