import { BadRequestException, Controller, Get, Param, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthenticatedPrincipal } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireScopes } from '../auth/decorators/require-scopes.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ScopesGuard } from '../auth/guards/scopes.guard';
import { FunctionsService } from '../functions/functions.service';
import { BuildService } from './build.service';

@UseGuards(AuthGuard, ScopesGuard)
@Controller('functions/:name')
export class BuildController {
  constructor(
    private readonly functionsService: FunctionsService,
    private readonly buildService: BuildService,
  ) {}

  @Post('versions')
  @RequireScopes('functions:write')
  @UseInterceptors(FileInterceptor('source')) // multer defaults to in-memory storage, giving file.buffer directly
  async createVersion(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('name') name: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Upload a source file under the "source" field');
    }

    // 404s here if the function doesn't exist OR belongs to someone else
    // - platform-level, before this upload ever touches object storage.
    const fn = await this.functionsService.get(user.userId, name);
    const build = await this.buildService.submitBuild(fn.id, file.buffer);

    // 202: the platform has accepted the request, the actual build has
    // not happened yet. The caller polls GET .../builds/:buildId for the
    // outcome - the same "accept synchronously, complete asynchronously"
    // shape as the original deploy-flow design.
    return { buildId: build.id, status: build.status };
  }

  @Get('builds/:buildId')
  @RequireScopes('functions:read')
  async getBuild(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('name') name: string,
    @Param('buildId') buildId: string,
  ) {
    const fn = await this.functionsService.get(user.userId, name);
    return this.buildService.getBuild(fn.id, buildId);
  }

  @Get('versions')
  @RequireScopes('functions:read')
  async listVersions(@CurrentUser() user: AuthenticatedPrincipal, @Param('name') name: string) {
    const fn = await this.functionsService.get(user.userId, name);
    return this.buildService.listVersions(fn.id);
  }
}
