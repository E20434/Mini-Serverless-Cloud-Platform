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
      throw new ConflictException(
        `Function "${name}" has no built version yet - upload one via POST /functions/${name}/versions first`,
      );
    }

    // Backpressure, from Phase 8's registry: if no healthy worker has
    // spare capacity, fail this request in milliseconds instead of
    // making the caller sit through the full dispatch timeout waiting
    // for a reply that was never going to come. Cheap, and a much better
    // experience than a multi-second hang ending in the same 503.
    if (!(await this.workerRegistry.hasSpareCapacity())) {
      throw new ServiceUnavailableException(`No worker has spare capacity to run "${name}" right now`);
    }

    try {
      // As of Phase 7, this is a queue dispatch, not a direct Docker
      // call - the container actually runs in a separate Worker process,
      // possibly on a different machine, communicating with this API
      // process only through Redis. Note the job payload carries no
      // userId at all - the Worker doesn't need to know or care whose
      // function this is, only what image to run.
      return await this.invocationDispatch.dispatch({
        imageTag: latestVersion.imageTag,
        event,
        timeoutMs: record.timeoutMs,
        memoryMb: record.memoryMb,
      });
    } catch {
      // dispatch() only ever throws for ONE reason: no worker replied
      // within the dispatch window. That's a PLATFORM-level failure -
      // nothing ran at all - categorically different from a function
      // legitimately timing out inside its own container (which comes
      // back as a normal ExecutionOutcome with status: 'timeout', not an
      // exception). 503 tells the caller "try again later," not "your
      // code is broken."
      throw new ServiceUnavailableException(`No worker was available to run "${name}"`);
    }
  }
}
