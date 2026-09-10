import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from './types/auth-user.types';

export interface CurrentWorkspaceValue {
  id: string;
  slug: string;
  name: string;
}

/**
 * Tenant isolation, resolved entirely from the access token's membership claims
 * — NO per-request DB hit. Matches the `:slug` route param against the user's
 * memberships and attaches `req.workspace`.
 *
 * A non-member (or a guessed/unknown slug) both yield 404 — we deliberately do
 * NOT distinguish "workspace does not exist" from "you are not a member", so we
 * never leak the existence of another tenant. Downstream queries must filter by
 * `req.workspace.id` (never the raw slug).
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    const slug = req.params?.slug;

    if (!user || !slug || typeof slug !== 'string') throw new NotFoundException();

    const membership = user.memberships.find((m) => m.slug === slug);
    if (!membership) {
      // Unknown slug OR not a member => identical 404 (no existence leak).
      throw new NotFoundException('workspace not found');
    }

    req.workspace = {
      id: membership.workspaceId,
      slug: membership.slug,
      name: membership.name,
    };
    return true;
  }
}

export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentWorkspaceValue => {
    return ctx.switchToHttp().getRequest().workspace;
  },
);
