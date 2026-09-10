import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AuthUser } from '../types/auth-user.types';

/**
 * Global authorization guard. Runs after AuthGuard; enforces that the principal
 * carries every permission named by @Permissions() on the route.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) throw new ForbiddenException('no principal');

    const granted = new Set(user.permissions ?? []);
    const ok = required.every((p) => granted.has(p));
    if (!ok) throw new ForbiddenException('insufficient permissions');
    return true;
  }
}
