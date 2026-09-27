/**
 * What it takes to turn one function's uploaded source into a runnable,
 * versioned image - deliberately abstracted from HOW that happens.
 * Phase 13 is the reason this exists: Fargate gives the API process no
 * Docker daemon at all, so "run `docker build` locally" (Phase 5's
 * original, and still the default everywhere else) genuinely cannot be
 * the only implementation anymore. BuildService owns the business logic
 * (version numbers, recording SUCCESS/FAILED) and doesn't need to know
 * or care which BuildExecutor is doing the actual work.
 */
export interface BuildExecutorParams {
  sourceObjectKey: string;
  functionName: string;
  versionNumber: number;
}

export interface BuildExecutorResult {
  /** Whatever `containerExecutor.ts` needs to hand to `docker run` later - a local tag, or a full ECR image URI:tag. */
  imageRef: string;
}

export interface BuildExecutor {
  build(params: BuildExecutorParams): Promise<BuildExecutorResult>;
}

export const BUILD_EXECUTOR = Symbol('BUILD_EXECUTOR');
