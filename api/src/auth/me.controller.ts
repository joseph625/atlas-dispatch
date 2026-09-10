import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthUser } from './types/auth-user.types';

@ApiTags('Me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  // Resolved entirely from the access token — no DB hit.
  @Get()
  me(@CurrentUser() user: AuthUser) {
    return {
      user: { id: user.id, email: user.email, name: user.name },
      permissions: user.permissions,
      workspaces: user.memberships.map((m) => ({ slug: m.slug, name: m.name, role: m.role })),
    };
  }
}
