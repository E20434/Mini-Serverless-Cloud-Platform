import { SetMetadata } from '@nestjs/common';
import { ApiScope } from '../scopes';

export const SCOPES_KEY = 'requiredScopes';

/** Declares which scope(s) a route needs. Read by ScopesGuard via Reflector - this decorator itself does nothing but attach metadata to the route handler. */
export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(SCOPES_KEY, scopes);
