import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { Injectable, Logger } from '@nestjs/common';
import { BuildExecutor, BuildExecutorParams, BuildExecutorResult } from './build-executor';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 100; // ~5 minutes - generous for a single-file function build

/**
 * The real AWS replacement for local `docker build` (Phase 13). Fargate
 * gives the API process no Docker daemon at all, so the build has to
 * happen somewhere that genuinely has one. AWS CodeBuild with privileged
 * mode is exactly that: a managed, ephemeral, Docker-capable build
 * environment, started fresh per build - this is the real architectural
 * upgrade Part 2's original AWS-mapping table already named at the very
 * start of this project ("Build Service -> CodeBuild"), not a
 * workaround invented under pressure.
 *
 * One shared CodeBuild Project (terraform/codebuild.tf) handles every
 * function's build - this class parameterizes each run entirely through
 * environmentVariablesOverride at StartBuild time; codebuild/buildspec.yml
 * reads those variables to know which S3 object to fetch and which ECR
 * tag to push.
 */
@Injectable()
export class CodeBuildExecutor implements BuildExecutor {
  private readonly logger = new Logger(CodeBuildExecutor.name);
  private readonly client = new CodeBuildClient({ region: process.env.S3_REGION });

  async build({ sourceObjectKey, functionName, versionNumber }: BuildExecutorParams): Promise<BuildExecutorResult> {
    const projectName = process.env.CODEBUILD_PROJECT_NAME;
    const bucket = process.env.S3_BUCKET;
    const functionsRepoUri = process.env.FUNCTIONS_ECR_REPO_URI;
    const runtimeImageUri = process.env.RUNTIME_IMAGE_URI;
    if (!projectName || !bucket || !functionsRepoUri || !runtimeImageUri) {
      throw new Error(
        'CodeBuildExecutor requires CODEBUILD_PROJECT_NAME, S3_BUCKET, FUNCTIONS_ECR_REPO_URI, and RUNTIME_IMAGE_URI',
      );
    }

    // ECR tags can't contain ":" - "-v" keeps this readable and distinct
    // from the local-executor's "name:version" scheme, which is fine:
    // the two schemes never need to interoperate, only containerExecutor.ts's
    // `docker run <imageRef>` needs to work with whichever one produced it.
    const imageTag = `${functionName}-v${versionNumber}`;
    const imageRef = `${functionsRepoUri}:${imageTag}`;

    const start = await this.client.send(
      new StartBuildCommand({
        projectName,
        environmentVariablesOverride: [
          { name: 'SOURCE_BUCKET', value: bucket },
          { name: 'SOURCE_KEY', value: sourceObjectKey },
          { name: 'RUNTIME_IMAGE_URI', value: runtimeImageUri },
          { name: 'IMAGE_URI', value: functionsRepoUri },
          { name: 'IMAGE_TAG', value: imageTag },
        ],
      }),
    );

    const buildId = start.build?.id;
    if (!buildId) {
      throw new Error('CodeBuild did not return a build id');
    }

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const status = await this.client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
      const build = status.builds?.[0];
      if (!build) continue;

      if (build.buildStatus === 'SUCCEEDED') {
        this.logger.log(`CodeBuild ${buildId} succeeded -> ${imageRef}`);
        return { imageRef };
      }
      if (build.buildStatus && build.buildStatus !== 'IN_PROGRESS') {
        throw new Error(`CodeBuild ${buildId} ended with status ${build.buildStatus}`);
      }
    }

    throw new Error(`CodeBuild ${buildId} did not finish within the poll window`);
  }
}
