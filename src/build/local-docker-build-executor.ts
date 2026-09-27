import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '../storage/object-storage.service';
import { BuildExecutor, BuildExecutorParams, BuildExecutorResult } from './build-executor';

const BASE_RUNTIME_IMAGE = 'mini-cloud-runtime:latest';

/**
 * Phase 5's original build path, unchanged in behavior - fetch the
 * source, generate the same two-line Dockerfile, run a local
 * `docker build`. Still the default everywhere except the AWS
 * deployment (see codebuild-executor.ts), which is the whole point of
 * this being one implementation of BuildExecutor rather than the only
 * possible one.
 */
@Injectable()
export class LocalDockerBuildExecutor implements BuildExecutor {
  constructor(private readonly storage: ObjectStorageService) {}

  async build({ sourceObjectKey, functionName, versionNumber }: BuildExecutorParams): Promise<BuildExecutorResult> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cloud-build-'));
    try {
      const source = await this.storage.getObject(sourceObjectKey);
      fs.writeFileSync(path.join(workDir, 'handler.js'), source);
      fs.writeFileSync(
        path.join(workDir, 'Dockerfile'),
        `FROM ${BASE_RUNTIME_IMAGE}\nCOPY handler.js /var/task/handler.js\n`,
      );

      const imageRef = `mini-cloud-fn-${functionName}:${versionNumber}`;
      await this.dockerBuild(workDir, imageRef);
      return { imageRef };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private dockerBuild(contextDir: string, imageTag: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['build', '-t', imageTag, contextDir]);
      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker build exited with code ${code}: ${stderr.slice(-1000)}`));
        }
      });
    });
  }
}
