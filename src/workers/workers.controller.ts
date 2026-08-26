import { Controller, Get } from '@nestjs/common';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';

@Controller('workers')
export class WorkersController {
  constructor(private readonly registry: WorkerRegistryService) {}

  @Get()
  list() {
    return this.registry.listWorkers();
  }
}
