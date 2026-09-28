# Mini-Cloud CLI — Design Spec

## Purpose

The mini-cloud platform (Phases 1–13) is only usable today via raw `curl`:
manual JWT copy-paste, multipart uploads by hand, polling a build ID with a
second `curl`. This is fine for verifying the platform works, but it is not
how a real user would experience "deploying a serverless function." Phase 14
adds a CLI that wraps the existing REST API so the developer workflow feels
like `vercel deploy` / `sam deploy` / `aws lambda invoke` — while requiring
zero changes to the existing API.

**Audience / success criteria:** the project owner, using this both as their
own day-to-day tool against the platform (local docker-compose stack and the
live AWS deployment) and as a portfolio artifact. Success = `mini-cloud
login`, `mini-cloud deploy ./handler.js --name foo`, and `mini-cloud invoke
foo` work end to end against either backend, with no manual token handling.

## Non-goals

- No changes to the existing NestJS API, its auth model, or its scopes.
- No local function execution/testing inside the CLI (that's the platform's
  job, via the Worker) — the CLI is a thin HTTP client only.
- No packaging/publishing to npm's public registry — `npm link` for a real
  local `mini-cloud` command is sufficient.

## Architecture

A new, independent package at `cli/`, with no dependency on the main app's
`src/` — it only talks HTTP to whatever backend a profile points at.

```
mini-cloud/
  src/            <- existing API/worker, untouched
  cli/
    package.json  <- "mini-cloud-cli", bin: { "mini-cloud": "./dist/index.js" }
    tsconfig.json
    src/
      index.ts            <- commander setup, registers all commands
      config.ts           <- read/write ~/.mini-cloud/config.json, profile model
      api-client.ts       <- thin fetch wrapper: baseUrl + apiKey -> typed calls, error translation
      commands/
        profile.ts        (add/list/use/remove)
        register.ts
        login.ts
        deploy.ts
        invoke.ts
        list.ts
        get.ts
        logs.ts           (invocations)
        metrics.ts
        rm.ts
```

Built on **commander** (small, minimal magic, appropriate for ~9 commands).

### Config model

Persisted at `~/.mini-cloud/config.json`:

```json
{
  "currentProfile": "aws",
  "profiles": {
    "local": { "baseUrl": "http://localhost:3000", "apiKey": null },
    "aws":   { "baseUrl": "http://32.197.229.232:3000", "apiKey": "mc_xxxxx" }
  }
}
```

Every command resolves the active profile as: `--profile <name>` flag if
given, else `currentProfile`, else an error telling the user to run `profile
add`. Same mental model as `kubectl config` / AWS CLI named profiles.

## Commands

| Command | Endpoint(s) | Notes |
|---|---|---|
| `profile add <name> --url <baseUrl>` | none | local config edit |
| `profile use <name>` | none | local config edit |
| `profile list` | none | local config edit |
| `profile remove <name>` | none | local config edit |
| `register --email --password` | `POST /auth/register` | one-time per backend |
| `login --email --password` | `POST /auth/login`, then `POST /auth/api-keys` | see below |
| `deploy <file> --name <fn> [--memory] [--timeout]` | `GET/POST /functions`, `POST /functions/:name/versions`, poll `GET /functions/:name/builds/:buildId` | see below |
| `invoke <name> [--data '<json>'\|--file event.json]` | `POST /functions/:name/invoke` | reads `X-Function-Error` header |
| `list` | `GET /functions` | table or `--json` |
| `get <name>` | `GET /functions/:name` | table or `--json` |
| `logs <name>` | `GET /functions/:name/invocations` | table or `--json` |
| `metrics <name>` | `GET /functions/:name/metrics` | table or `--json` |
| `rm <name>` | `DELETE /functions/:name` | confirms unless `--yes` |

### `login` flow

`POST /auth/login` gets a JWT. The CLI immediately uses that JWT to call
`POST /auth/api-keys` with:

```json
{ "name": "cli-<hostname>", "scopes": ["functions:read", "functions:write", "functions:invoke"] }
```

The returned API key (`mc_...`) is saved into the active profile; the JWT is
discarded and never stored. Every subsequent command sends `Authorization:
Bearer <apiKey>`. `AuthGuard` (`src/auth/guards/auth.guard.ts`) already
accepts either a JWT or an `mc_`-prefixed API key on the same header — this
was confirmed by reading the guard, not assumed — so this requires no API
changes. This avoids the JWT's 2-hour expiry ever interrupting a CLI session.

### `deploy` flow

1. `GET /functions/:name`. A 404 means first deploy: `POST /functions
   {name, memoryMb?, timeoutMs?}` first.
2. Always `POST /functions/:name/versions` (multipart, file under the
   `source` field), returning `{buildId, status}`.
3. Poll `GET /functions/:name/builds/:buildId` every ~2s, printing a status
   line, until `status` is `SUCCESS` (print the resulting `imageTag`, exit 0)
   or `FAILED` (print `errorMessage`, exit 1).

### `invoke` flow

`POST /functions/:name/invoke` with the given JSON body (default `{}`). The
platform reports a function's own unhandled error via the
`X-Function-Error` response header on an HTTP 200 (not a 5xx) — mirroring
AWS Lambda's real Invoke API. The CLI must check this header explicitly:
present → print `errorMessage` in red, exit 1; absent → print `result`,
exit 0.

## Error handling

Centralized in `api-client.ts` so every command gets consistent behavior:

- Network failure → `Could not reach <baseUrl> — is the profile URL correct and the service running?`
- `401` → `Invalid or expired API key. Run 'mini-cloud login' again.`
- Other 4xx/5xx with a JSON `{message}` body (Nest's default shape) → print that message directly.
- Anything else → print status code + raw body as a fallback.

## Testing

The CLI has no business logic of its own — builds, invocation, and scopes
are already implemented and tested in the API. Coverage:

- Jest unit tests for `config.ts` (profile read/write/switch logic) and
  `api-client.ts`'s error-translation branching (mocked fetch, one test per
  status/shape).
- Manual end-to-end verification against the local docker-compose stack
  (and optionally the live AWS deployment) once built, the same way every
  previous phase in this project was verified.

## Open questions / risks

None outstanding — the design was walked through interactively (backend
targeting, auth model, deploy UX, framework, packaging) and each decision
was confirmed before writing this spec.
