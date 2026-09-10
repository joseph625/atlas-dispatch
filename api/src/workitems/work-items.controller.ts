import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { WorkItemStatus } from 'prisma/generated/client';
import { CurrentWorkspace, CurrentWorkspaceValue, WorkspaceGuard } from '../auth/workspace.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Perm } from '../auth/types/permission.types';
import { WorkItemsService } from './work-items.service';

const VALID_STATUS = new Set(['pending', 'done', 'failed', 'dead']);

// Global AuthGuard authenticates; WorkspaceGuard enforces tenant membership.
@ApiTags('Work items')
@ApiBearerAuth()
@Controller('workspaces/:slug')
@UseGuards(WorkspaceGuard)
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  @Get()
  workspace(@CurrentWorkspace() ws: CurrentWorkspaceValue) {
    return { slug: ws.slug, name: ws.name };
  }

  @Get('work-items')
  @Permissions(Perm.WorkItemRead)
  list(
    @CurrentWorkspace() ws: CurrentWorkspaceValue,
    @Query('status') status?: string,
    @Query('vendor') vendor?: string,
    @Query('limit') limit?: string,
  ) {
    if (status && !VALID_STATUS.has(status)) {
      throw new BadRequestException(`invalid status filter: ${status}`);
    }
    return this.workItems.list(ws.id, {
      status: status as WorkItemStatus | undefined,
      vendor: vendor || undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('work-items/:id')
  @Permissions(Perm.WorkItemRead)
  detail(@CurrentWorkspace() ws: CurrentWorkspaceValue, @Param('id') id: string) {
    return this.workItems.detail(ws.id, id);
  }

  @Post('work-items/:id/retry')
  @Permissions(Perm.WorkItemRetry)
  async retry(@CurrentWorkspace() ws: CurrentWorkspaceValue, @Param('id') id: string) {
    const status = await this.workItems.retry(ws.id, id);
    return { id, status };
  }
}
