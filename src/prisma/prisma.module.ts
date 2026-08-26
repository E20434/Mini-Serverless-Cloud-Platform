import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global() means any feature module (FunctionsModule today, more later)
// can inject PrismaService without each one separately importing
// PrismaModule - there's exactly one database connection pool for the
// whole process, and that's a fact about the whole app, not a per-feature
// concern.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
