import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * A thin Nest wrapper around PrismaClient so the connection lifecycle
 * (connect when the module starts, disconnect when it stops) is managed
 * by Nest's DI container instead of scattered manual connect/disconnect
 * calls sprinkled through the app. Every other service should inject
 * THIS, never do `new PrismaClient()` itself - one pooled connection per
 * process, not one per service that happens to touch the database.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
