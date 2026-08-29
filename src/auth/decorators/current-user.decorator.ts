import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedPrincipal } from '../auth.service';

/** Pulls the principal AuthGuard already attached to the request - only meaningful on a route also guarded by AuthGuard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
  const request = ctx.switchToHttp().getRequest<Request & { user: AuthenticatedPrincipal }>();
  return request.user;
});
