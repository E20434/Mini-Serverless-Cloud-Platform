import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RegisterFunctionDto } from './dto/register-function.dto';
import { FunctionsService } from './functions.service';

@Controller('functions')
export class FunctionsController {
  constructor(private readonly functionsService: FunctionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterFunctionDto) {
    return this.functionsService.register(dto);
  }

  @Get()
  list() {
    return this.functionsService.list();
  }

  @Get(':name')
  get(@Param('name') name: string) {
    return this.functionsService.get(name);
  }

  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('name') name: string) {
    // MUST return the promise, not just call it. Phase 3's in-memory
    // version was synchronous, so firing-and-forgetting here happened to
    // work; now that remove() is async, not returning it would both
    // respond before the delete actually completes AND turn a thrown
    // NotFoundException into an unhandled rejection instead of a 404 -
    // Nest only catches exceptions from a promise it's actually awaiting.
    return this.functionsService.remove(name);
  }

  @Post(':name/invoke')
  async invoke(@Param('name') name: string, @Body() event: unknown, @Res() res: Response) {
    // Using @Res() directly opts this one route out of Nest's automatic
    // response handling - a deliberate, narrow exception, not the
    // default pattern, because we need to set a custom header AND a
    // custom body together, conditionally, on a single response. If
    // this.functionsService.invoke() throws (unknown function name), it
    // never reaches this line at all - Nest's exception filter turns
    // that into a 404 on its own, upstream of this method entirely.
    const outcome = await this.functionsService.invoke(name, event);

    if (outcome.status === 'success') {
      res.status(HttpStatus.OK).json({ result: outcome.result, durationMs: outcome.durationMs });
      return;
    }

    // The core API-design lesson of this phase: the platform DID
    // successfully invoke the function - that's why this is 200, not
    // 500. Whether the function's own code succeeded is a separate
    // question, carried here in a header, the same way AWS Lambda's real
    // Invoke API reports an unhandled exception via
    // `X-Amz-Function-Error` on an HTTP 200 response, not via a 5xx.
    res
      .status(HttpStatus.OK)
      .header('X-Function-Error', outcome.status === 'timeout' ? 'Timeout' : 'Unhandled')
      .json({
        errorMessage: outcome.status === 'timeout' ? 'Function timed out' : outcome.error,
        durationMs: outcome.durationMs,
      });
  }
}
