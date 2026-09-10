import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './decorators/public.decorator';

/**
 * DEV-ONLY. Backs the mock login picker in the UI so we don't hardcode seeded
 * user ids. It never returns secrets or password hashes.
 */
@ApiTags('Dev')
@Controller('dev')
export class DevController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('accounts')
  async accounts() {
    const users = await this.prisma.user.findMany({
      include: { memberships: { include: { workspace: true } } },
      orderBy: { email: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      workspaces: u.memberships.map((m) => ({ slug: m.workspace.slug, name: m.workspace.name })),
    }));
  }
}
