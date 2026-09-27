import { spawn } from 'node:child_process';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';

/**
 * Only relevant on AWS (ECR_REGISTRY set - terraform/ecs.tf). A real,
 * non-obvious wrinkle found designing Phase 13, not before: ECS's own
 * image-pull machinery authenticates the ONE image a task definition
 * names when that task starts - it does nothing for arbitrary images
 * OUR OWN application code later asks the shared host daemon to
 * `docker run` (containerExecutor.ts, once per invocation, pulling
 * whichever per-function image CodeBuild just pushed). Without this,
 * every invocation's `docker run <ecr-image>` fails with an
 * authentication error the moment the image isn't already cached
 * locally. Logs in once at startup using the task's own IAM role -
 * sufficient for a short verification window; ECR tokens are valid 12
 * hours.
 */
export async function ensureEcrLogin(): Promise<void> {
  const registry = process.env.ECR_REGISTRY;
  if (!registry) return; // local dev / Kubernetes: images are local or already pulled, nothing to authenticate

  const ecr = new ECRClient({ region: process.env.AWS_REGION });
  const result = await ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = result.authorizationData?.[0];
  if (!authData?.authorizationToken) {
    throw new Error('ECR did not return an authorization token');
  }
  // The token is base64("AWS:<password>") - docker login wants the
  // password half only, piped via stdin so it never appears in argv
  // (visible to anyone who can list processes on the host).
  const password = Buffer.from(authData.authorizationToken, 'base64').toString('utf8').split(':')[1];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['login', '--username', 'AWS', '--password-stdin', registry]);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker login failed: ${stderr}`))));
    proc.stdin.write(password);
    proc.stdin.end();
  });
}
