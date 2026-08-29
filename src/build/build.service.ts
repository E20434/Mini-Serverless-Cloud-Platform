import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Build } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';

const BASE_RUNTIME_IMAGE = 'mini-cloud-runtime:latest';

@Injectable()
export class BuildService {
  private readonly logger = new Logger(BuildService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  /**
   * The ONLY part of the build pipeline that runs on the HTTP request
   * path: store the uploaded bytes and record a PENDING build. Both are
   * fast (an object PUT, an INSERT) - the actual `docker build`, which
   * can take real time, happens later, off this request, picked up by
   * BuildWorkerService's polling loop.
   */
  async submitBuild(functionId: string, sourceBuffer: Buffer): Promise<Build> {
    const sourceObjectKey = `functions/${functionId}/${crypto.randomUUID()}.js`;
    await this.storage.putObject(sourceObjectKey, sourceBuffer);

    return this.prisma.build.create({
      data: { functionId, sourceObjectKey, status: 'PENDING' },
    });
  }

  async getBuild(functionId: string, buildId: string): Promise<Build> {
    const build = await this.prisma.build.findUnique({ where: { id: buildId } });
    // Real Phase 9 bug, worth naming: checking ONLY "does this build
    // exist" and separately "does the function in the URL belong to me"
    // would still let a caller read any OTHER function's build (even one
    // owned by a different user entirely) just by guessing/enumerating a
    // build ID - the function-name ownership check alone never
    // constrains which build a caller can ask about. Requiring the
    // build's OWN functionId to match closes that gap.
    if (!build || build.functionId !== functionId) {
      throw new NotFoundException(`Build "${buildId}" not found`);
    }
    return build;
  }

  listVersions(functionId: string) {
    return this.prisma.functionVersion.findMany({
      where: { functionId },
      orderBy: { versionNumber: 'asc' },
    });
  }

  /**
   * Runs ONE build attempt end-to-end. Called only by the polling worker,
   * never directly by an HTTP request - this is the whole reason the
   * build pipeline is async at all.
   */
  async runBuild(build: Build): Promise<void> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cloud-build-'));
    try {
      const source = await this.storage.getObject(build.sourceObjectKey);
      fs.writeFileSync(path.join(workDir, 'handler.js'), source);
      // A per-function image is just this one extra layer on top of
      // Phase 2's base runtime image - the shared shim and all the
      // isolation setup already live in mini-cloud-runtime; this build
      // only ever adds the user's code.
      fs.writeFileSync(
        path.join(workDir, 'Dockerfile'),
        `FROM ${BASE_RUNTIME_IMAGE}\nCOPY handler.js /var/task/handler.js\n`,
      );

      const fn = await this.prisma.function.findUniqueOrThrow({ where: { id: build.functionId } });
      const versionNumber = await this.nextVersionNumber(build.functionId);
      const imageTag = `mini-cloud-fn-${fn.name}:${versionNumber}`;

      await this.dockerBuild(workDir, imageTag);

      // Both writes succeed or both fail together - a FunctionVersion
      // pointing at an image nobody recorded as SUCCESS (or a SUCCESS
      // build with no corresponding version) would each be a real,
      // silent correctness bug. This is the same "atomic multi-table
      // transition" reasoning from Part 4's original build-succeeded
      // transaction, now actually running.
      await this.prisma.$transaction([
        this.prisma.functionVersion.create({
          data: { functionId: build.functionId, versionNumber, imageTag },
        }),
        this.prisma.build.update({
          where: { id: build.id },
          data: { status: 'SUCCESS', imageTag, finishedAt: new Date() },
        }),
      ]);
      this.logger.log(`Build ${build.id} succeeded -> ${imageTag}`);
    } catch (err) {
      await this.prisma.build.update({
        where: { id: build.id },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        },
      });
      this.logger.warn(`Build ${build.id} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async nextVersionNumber(functionId: string): Promise<number> {
    // A real race exists here if two builds for the SAME function ever
    // ran concurrently (they don't yet - the worker processes one build
    // at a time). The @@unique([functionId, versionNumber]) constraint in
    // the schema is the actual safety net: a genuine race would surface
    // as a loud unique-constraint failure here, not silent data
    // corruption. Worth revisiting when Phase 7 adds worker concurrency.
    const latest = await this.prisma.functionVersion.findFirst({
      where: { functionId },
      orderBy: { versionNumber: 'desc' },
    });
    return (latest?.versionNumber ?? 0) + 1;
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
