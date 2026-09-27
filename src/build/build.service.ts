import crypto from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Build } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { BUILD_EXECUTOR, BuildExecutor } from './build-executor';

@Injectable()
export class BuildService {
  private readonly logger = new Logger(BuildService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
    @Inject(BUILD_EXECUTOR) private readonly executor: BuildExecutor,
  ) {}

  /**
   * The ONLY part of the build pipeline that runs on the HTTP request
   * path: store the uploaded bytes and record a PENDING build. Both are
   * fast (an object PUT, an INSERT) - the actual build, which can take
   * real time regardless of WHICH BuildExecutor runs it, happens later,
   * off this request, picked up by the stream consumer.
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
   * Runs ONE build attempt end-to-end. Called only by the stream
   * consumer, never directly by an HTTP request - this is the whole
   * reason the build pipeline is async at all. Delegates the actual
   * build mechanics to whichever BuildExecutor was injected (Phase 13) -
   * this method only owns the business logic: version numbers, and
   * recording SUCCESS/FAILED atomically with the resulting version.
   */
  async runBuild(build: Build): Promise<void> {
    try {
      const fn = await this.prisma.function.findUniqueOrThrow({ where: { id: build.functionId } });
      const versionNumber = await this.nextVersionNumber(build.functionId);

      const { imageRef } = await this.executor.build({
        sourceObjectKey: build.sourceObjectKey,
        functionName: fn.name,
        versionNumber,
      });

      // Both writes succeed or both fail together - a FunctionVersion
      // pointing at an image nobody recorded as SUCCESS (or a SUCCESS
      // build with no corresponding version) would each be a real,
      // silent correctness bug. This is the same "atomic multi-table
      // transition" reasoning from Part 4's original build-succeeded
      // transaction, now actually running.
      await this.prisma.$transaction([
        this.prisma.functionVersion.create({
          data: { functionId: build.functionId, versionNumber, imageTag: imageRef },
        }),
        this.prisma.build.update({
          where: { id: build.id },
          data: { status: 'SUCCESS', imageTag: imageRef, finishedAt: new Date() },
        }),
      ]);
      this.logger.log(`Build ${build.id} succeeded -> ${imageRef}`);
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
    }
  }

  private async nextVersionNumber(functionId: string): Promise<number> {
    // A real race exists here if two builds for the SAME function ever
    // ran concurrently. The @@unique([functionId, versionNumber])
    // constraint in the schema is the actual safety net: a genuine race
    // would surface as a loud unique-constraint failure here, not silent
    // data corruption.
    const latest = await this.prisma.functionVersion.findFirst({
      where: { functionId },
      orderBy: { versionNumber: 'desc' },
    });
    return (latest?.versionNumber ?? 0) + 1;
  }
}
