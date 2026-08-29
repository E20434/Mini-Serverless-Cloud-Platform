import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedPrincipal, AuthService } from '../auth.service';

/**
 * One guard, two credential types, differentiated by the token's shape -
 * a client sends `Authorization: Bearer <token>` either way, and never
 * needs to declare which kind it's presenting. This mirrors how a lot of
 * real APIs actually work: the same header, the prefix on the value
 * tells the server how to interpret it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedPrincipal }>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const token = header.slice('Bearer '.length);

    const principal = token.startsWith('mc_')
      ? await this.authService.validateApiKey(token)
      : this.tryVerifyJwt(token);

    if (!principal) {
      throw new UnauthorizedException('Invalid or revoked credentials');
    }

    request.user = principal;
    return true;
  }

  private tryVerifyJwt(token: string): AuthenticatedPrincipal | null {
    try {
      return this.authService.verifyJwt(token);
    } catch {
      // Expired, malformed, or signed with a different secret - all the
      // same outcome from the caller's perspective: not authenticated.
      return null;
    }
  }
}
