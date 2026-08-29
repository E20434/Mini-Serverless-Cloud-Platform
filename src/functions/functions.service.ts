import crypto from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, Function as FunctionRecord } from '@prisma/client';
import { ExecutionOutcome } from '../containerExecutor';
import { InvocationDispatchService } from '../invocation/invocation-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { RegisterFunctionDto } from './dto/register-function.dto';

export type { FunctionRecord };

@Injectable()
export class FunctionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invocationDispatch: InvocationDispatchService,
    private readonly workerRegistry: WorkerRegistryService,
  ) {}

  async register(userId: string, dto: RegisterFunctionDto): Promise<FunctionRecord> {
    try {
      return await this.prisma.function.create({
        data: {
          userId,
          name: dto.name,
          memoryMb: dto.memoryMb ?? 128,
          timeoutMs: dto.timeoutMs ?? 3000,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Unique constraint is now (userId, name) - this fires only for
        // a conflict within the SAME account. Someone else's function
        // named identically is invisible to this check entirely, by
        // design.
        throw new ConflictException(`Function "${dto.name}" already exists`);
      }
      throw err;
    }
  }

  list(userId: string): Promise<FunctionRecord[]> {
    return this.prisma.function.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async get(userId: string, name: string): Promise<FunctionRecord> {
    // Scoping by (userId, name) TOGETHER in the WHERE clause - not "look
    // it up by name, then separately check ownership" - is what actually
    // matters here. The second approach would still work correctly, but
    // scoping the query itself means there is no code path where a row
    // belonging to a different user is ever fetched into memory at all,
    // even transiently.
    const record = await this.prisma.function.findUnique({ where: { userId_name: { userId, name } } });
    if (!record) {
      throw new NotFoundException(`Function "${name}" not found`);
    }
    return record;
  }

  async remove(userId: string, name: string): Promise<void> {
    try {
      await this.prisma.function.delete({ where: { userId_name: { userId, name } } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException(`Function "${name}" not found`);
      }
      throw err;
    }
  }

  async invoke(userId: string, name: string, event: unknown): Promise<ExecutionOutcome> {
    const record = await this.get(userId, name); // 404 if unknown OR owned by someone else - both look identical from outside

    // "Active version" = highest versionNumber that has ever built
    // successfully. There's no explicit promotion/rollback yet - see the
    // schema comment in prisma/schema.prisma for why that's a deliberate
    // scope cut, not an oversight.
    const latestVersion = await this.prisma.functionVersion.findFirst({
      where: { functionId: record.id },
      orderBy: { versionNumber: 'desc' },
    });

    if (!latestVersion) {
      // Also platform-level: the function exists, but nobody has
      // successfully built and deployed any code for it yet. This is a
      // different situation from "function not found" and deserves a
      // different, clearer status than a generic 404 would give a caller.
      // NOT recorded as an Invocation row - dispatch was never attempted,
      // this is a validation failure, same reasoning as the 404 above.
      throw new ConflictException(
        `Function "${name}" has no built version yet - upload one via POST /functions/${name}/versions first`,
      );
    }

    const start = Date.now();

    // Backpressure, from Phase 8's registry: if no healthy worker has
    // spare capacity, fail this request in milliseconds instead of
    // making the caller sit through the full dispatch timeout waiting
    // for a reply that was never going to come. Cheap, and a much better
    // experience than a multi-second hang ending in the same 503.
    if (!(await this.workerRegistry.hasSpareCapacity())) {
      await this.recordInvocation(record.id, latestVersion.id, 'NO_WORKER', Date.now() - start, 'No healthy worker had spare capacity');
      throw new ServiceUnavailableException(`No worker has spare capacity to run "${name}" right now`);
    }

    try {
      // As of Phase 7, this is a queue dispatch, not a direct Docker
      // call - the container actually runs in a separate Worker process,
      // possibly on a different machine, communicating with this API
      // process only through Redis. Note the job payload carries no
      // userId at all - the Worker doesn't need to know or care whose
      // function this is, only what image to run.
      const outcome = await this.invocationDispatch.dispatch({
        imageTag: latestVersion.imageTag,
        event,
        timeoutMs: record.timeoutMs,
        memoryMb: record.memoryMb,
      });

      // Written here, in the API process, NOT the Worker - the Worker
      // stays exactly as ignorant of Postgres/userId as Phase 7 designed
      // it to be. This process already holds every fact needed (who
      // asked, which function, which version) the moment the reply
      // arrives, so it's the natural, and only, place to record it.
      await this.recordInvocation(
        record.id,
        latestVersion.id,
        outcome.status === 'success' ? 'SUCCESS' : outcome.status === 'timeout' ? 'TIMEOUT' : 'ERROR',
        outcome.durationMs,
        outcome.status === 'success' ? null : outcome.status === 'timeout' ? 'Function timed out' : outcome.error,
      );

      return outcome;
    } catch {
      // dispatch() only ever throws for ONE reason: no worker replied
      // within the dispatch window. That's a PLATFORM-level failure -
      // nothing ran at all - categorically different from a function
      // legitimately timing out inside its own container (which comes
      // back as a normal ExecutionOutcome with status: 'timeout', not an
      // exception). 503 tells the caller "try again later," not "your
      // code is broken."
      await this.recordInvocation(record.id, latestVersion.id, 'NO_WORKER', Date.now() - start, 'No worker responded within the dispatch window');
      throw new ServiceUnavailableException(`No worker was available to run "${name}"`);
    }
  }

  listInvocations(userId: string, name: string) {
    return this.get(userId, name).then((record) =>
      this.prisma.invocation.findMany({
        where: { functionId: record.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );
  }

  /**
   * The exact query shape sketched back in Part 4's original design -
   * error rate and latency percentiles over a rolling window, now
   * actually runnable against a real Invocation table. percentile_cont
   * needs raw SQL - Prisma's query builder has no percentile primitive.
   */
  async getMetricsSummary(userId: string, name: string) {
    const record = await this.get(userId, name);
    const rows = await this.prisma.$queryRaw<
      { total: bigint; error_rate: number | null; p50: number | null; p95: number | null; p99: number | null }[]
    >`
      SELECT
        count(*) AS total,
        (count(*) FILTER (WHERE status != 'SUCCESS'))::float / NULLIF(count(*), 0) AS error_rate,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99
      FROM invocations
      WHERE function_id = ${record.id}
        AND created_at > now() - interval '1 hour'
    `;
    const row = rows[0];
    return {
      windowHours: 1,
      totalInvocations: Number(row.total),
      errorRate: row.error_rate ?? 0,
      latencyMsP50: row.p50 ?? null,
      latencyMsP95: row.p95 ?? null,
      latencyMsP99: row.p99 ?? null,
    };
  }

  private async recordInvocation(
    functionId: string,
    versionId: string,
    status: 'SUCCESS' | 'ERROR' | 'TIMEOUT' | 'NO_WORKER',
    durationMs: number,
    errorMessage: string | null,
  ): Promise<void> {
    // Logging/metrics recording is a soft dependency of serving the
    // request, same principle as Phase 1's logging design - a failure
    // writing this row must never surface as a failure of the invocation
    // itself, which already completed (or definitively failed) by the
    // time this runs.
    try {
      await this.prisma.invocation.create({
        data: {
          functionId,
          versionId,
          requestId: crypto.randomUUID(),
          status,
          durationMs,
          errorMessage: errorMessage ?? undefined,
        },
      });
    } catch {
      // Deliberately swallowed - see comment above.
    }
  }
}
