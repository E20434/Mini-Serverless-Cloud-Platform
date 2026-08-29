import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/guards/auth.guard';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';

// Authenticated, but NOT owner-scoped: the worker fleet is shared
// platform infrastructure, not a per-tenant resource - any authenticated
// principal can see it (a real system would likely gate this behind an
// admin role instead, once roles exist).
@UseGuards(AuthGuard)
@Controller('workers')
export class WorkersController {
  constructor(private readonly registry: WorkerRegistryService) {}

  @Get()
  list() {
    return this.registry.listWorkers();
  }
}
