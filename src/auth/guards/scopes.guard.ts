import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthenticatedPrincipal } from '../auth.service';
import { SCOPES_KEY } from '../decorators/require-scopes.decorator';
import { ApiScope } from '../scopes';

/**
 * Runs AFTER AuthGuard (which populates request.user) - authorization is
 * a separate question from authentication, and belongs in a separate
 * guard: "who are you" vs "are you allowed to do THIS." A route with no
 * @RequireScopes(...) has nothing to check and passes through - scopes
 * are opt-in per route, not a blanket default.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.get<ApiScope[] | undefined>(SCOPES_KEY, context.getHandler());
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const granted = request.user?.scopes ?? [];

    const missing = required.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) {
      throw new ForbiddenException(`Missing required scope(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
