/**
 * The Execution Runtime - Docker-backed.
 *
 * Same job as Phase 1's executor.ts (load code, run handler(event), report
 * what happened) - but the "load and run" step happens inside a
 * throwaway, isolated container instead of this process, and the timeout
 * is enforced by killing that container from the outside rather than by
 * racing a Promise.
 *
 * Two ways to get code into that container, both real, different
 * tradeoffs:
 *   - executeInContainer(): Phase 2's original approach - one shared
 *     generic image, user code bind-mounted in at run time. Simple, fast
 *     to iterate on, but only works when the code and the Docker daemon
 *     are on the same machine.
 *   - executeVersionedFunction(): Phase 5's approach - a per-function
 *     image with the code baked in as a layer (built by build.service.ts).
 *     Portable: any worker that can pull the image can run it, regardless
 *     of where the source originally came from. This is what the real
 *     invoke path uses now.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ExecutionOutcome =
  | { status: 'success'; result: unknown; durationMs: number }
  | { status: 'error'; error: string; durationMs: number }
  | { status: 'timeout'; durationMs: number };

export interface ExecuteOptions {
  /** Milliseconds to wait before killing the container. Default: 3000. */
  timeoutMs?: number;
  /** Hard memory ceiling in MB, enforced by a cgroup. Default: 128. */
  memoryMb?: number;
  /** CPU share, in cores (can be fractional, e.g. 0.5). Default: 0.5. */
  cpus?: number;
}

const RUNTIME_IMAGE = 'mini-cloud-runtime:latest';

export async function executeInContainer(
  functionPath: string,
  event: unknown,
  options: ExecuteOptions = {},
): Promise<ExecutionOutcome> {
  const absFunctionPath = path.resolve(functionPath);
  return runIsolatedContainer(
    RUNTIME_IMAGE,
    (eventPath) => [`-v`, `${absFunctionPath}:/var/task/handler.js:ro`, `-v`, `${eventPath}:/var/task/event.json:ro`],
    event,
    options,
  );
}

export async function executeVersionedFunction(
  imageTag: string,
  event: unknown,
  options: ExecuteOptions = {},
): Promise<ExecutionOutcome> {
  // No handler.js mount at all - the code is already baked into imageTag
  // as a layer, built by build.service.ts. Only the event still crosses
  // the boundary as a mount; the result still comes back the same way.
  return runIsolatedContainer(imageTag, (eventPath) => [`-v`, `${eventPath}:/var/task/event.json:ro`], event, options);
}

/**
 * Shared machinery for both entry points above: isolation flags, timeout
 * enforcement via `docker kill`, and result-file parsing. The only thing
 * that differs between the two public functions is which image to run
 * and which extra bind mounts (if any) deliver the code.
 */
async function runIsolatedContainer(
  image: string,
  extraMounts: (eventPath: string) => string[],
  event: unknown,
  options: ExecuteOptions,
): Promise<ExecutionOutcome> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const memoryMb = options.memoryMb ?? 128;
  const cpus = options.cpus ?? 0.5;
  const start = Date.now();

  // HOST_SCRATCH_DIR overrides where per-invocation scratch files live -
  // needed ONLY when this process (the Worker) is itself a container
  // calling a Docker daemon it doesn't own (Docker-outside-of-Docker, see
  // k8s/kind-config.yaml's comment): `docker run -v <path>:/output`
  // requires <path> to exist on the DAEMON's own filesystem, not this
  // process's private one, so the scratch directory must live somewhere
  // both sides genuinely share. On a bare host (every phase before this
  // one), this process and the daemon already share one real filesystem,
  // so the default os.tmpdir() is correct and this variable is unset.
  const scratchRoot = process.env.HOST_SCRATCH_DIR || os.tmpdir();
  const workDir = fs.mkdtempSync(path.join(scratchRoot, 'mini-cloud-'));
  const eventPath = path.join(workDir, 'event.json');
  const outputDir = path.join(workDir, 'output');
  fs.mkdirSync(outputDir);
  // Phase 12, found running for real inside a Kubernetes Pod, not
  // hypothesized: on every previous bare-Windows-host run, Docker
  // Desktop's bind-mount translation silently ignored Linux UID/GID
  // permission bits, so this never mattered. Once the Worker itself
  // became a real Linux container, this directory (created here as
  // root, default mode 0755) is a genuine Linux filesystem entry with
  // genuinely enforced permissions - and the function container writes
  // to it as UID 1000 (Phase 2's --user flag), which can read a 0755
  // root-owned directory but cannot write into one. This is a
  // short-lived, per-invocation scratch directory only the local Docker
  // daemon ever touches, so making it world-writable is a negligible
  // concern next to the docker.sock mount this whole deployment already
  // requires (see k8s/README.md).
  fs.chmodSync(outputDir, 0o777);
  fs.writeFileSync(eventPath, JSON.stringify(event ?? {}));

  const containerName = `mini-cloud-${crypto.randomUUID()}`;

  const args = [
    'run',
    '--rm',
    '--name', containerName,

    // --- isolation & resource limits ---
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:size=16m',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', `${memoryMb}m`,
    '--memory-swap', `${memoryMb}m`,
    '--cpus', String(cpus),

    // --- crossing the boundary ---
    ...extraMounts(eventPath),
    '-v', `${outputDir}:/output`,

    image,
  ];

  const outcome = await new Promise<ExecutionOutcome>((resolve) => {
    const proc = spawn('docker', args);

    let settled = false;
    const timer = setTimeout(() => {
      spawn('docker', ['kill', containerName]);
    }, timeoutMs);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const durationMs = Date.now() - start;
      const resultPath = path.join(outputDir, 'result.json');

      if (fs.existsSync(resultPath)) {
        const shimOutcome = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        resolve({ ...shimOutcome, durationMs });
        return;
      }

      if (exitCode === 137) {
        resolve({ status: 'timeout', durationMs });
        return;
      }

      resolve({
        status: 'error',
        error: `Container exited with code ${exitCode} before producing a result. stderr: ${stderr.slice(0, 500)}`,
        durationMs,
      });
    });
  });

  fs.rmSync(workDir, { recursive: true, force: true });
  return outcome;
}
