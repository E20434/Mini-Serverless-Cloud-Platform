import { BadRequestException, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { FunctionsService } from '../functions/functions.service';
import { BuildService } from './build.service';

@Controller('functions/:name')
export class BuildController {
  constructor(
    private readonly functionsService: FunctionsService,
    private readonly buildService: BuildService,
  ) {}

  @Post('versions')
  @UseInterceptors(FileInterceptor('source')) // multer defaults to in-memory storage, giving file.buffer directly
  async createVersion(@Param('name') name: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('Upload a source file under the "source" field');
    }

    // 404s here if the function doesn't exist - platform-level, before
    // this upload ever touches object storage.
    const fn = await this.functionsService.get(name);
    const build = await this.buildService.submitBuild(fn.id, file.buffer);

    // 202: the platform has accepted the request, the actual build has
    // not happened yet. The caller polls GET .../builds/:buildId for the
    // outcome - the same "accept synchronously, complete asynchronously"
    // shape as the original deploy-flow design.
    return { buildId: build.id, status: build.status };
  }

  @Get('builds/:buildId')
  async getBuild(@Param('name') name: string, @Param('buildId') buildId: string) {
    await this.functionsService.get(name);
    return this.buildService.getBuild(buildId);
  }

  @Get('versions')
  async listVersions(@Param('name') name: string) {
    const fn = await this.functionsService.get(name);
    return this.buildService.listVersions(fn.id);
  }
}
