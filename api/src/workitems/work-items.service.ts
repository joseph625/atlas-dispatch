import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WorkItemStatus } from 'prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { runHandler } from '../webhooks/processor';
import { redact } from '../common/redact';

const DEFAULT_MAX_ATTEMPTS = Number(process.env.WORK_ITEM_MAX_ATTEMPTS ?? 3);

@Injectable()
export class WorkItemsService {
  private readonly logger = new Logger('WorkItems');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run one attempt against the handler and persist the resulting state +
   * transition atomically. Returns the new status.
   */
  private async attemptOnce(workItemId: string): Promise<WorkItemStatus> {
    const item = await this.prisma.workItem.findUnique({
      where: { id: workItemId },
      include: { event: true },
    });
    if (!item) throw new NotFoundException('work item not found');
    if (item.status === 'done' || item.status === 'dead') return item.status;

    const attempt = item.attempts + 1;
    let nextStatus: WorkItemStatus;
    let error: string | null = null;

    try {
      runHandler(item.event.payload, attempt);
      nextStatus = 'done';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      nextStatus = attempt >= item.maxAttempts ? 'dead' : 'failed';
    }

    await this.prisma.$transaction([
      this.prisma.workItem.update({
        where: { id: item.id },
        data: { status: nextStatus, attempts: attempt, lastError: error },
      }),
      this.prisma.statusTransition.create({
        data: {
          workItemId: item.id,
          fromStatus: item.status,
          toStatus: nextStatus,
          attempt,
          note: error ?? 'handled',
        },
      }),
    ]);

    this.logger.log(
      `workItem=${item.id} tenantId=${item.workspaceId} vendor=${item.vendor} ` +
        `eventId=${item.event.vendorEventId} attempt=${attempt} status=${nextStatus}`,
    );
    return nextStatus;
  }

  /**
   * Bounded retry loop: keep attempting until the item settles (done | dead) or
   * the attempt budget is exhausted. Deterministic and synchronous.
   */
  async processUntilSettled(workItemId: string): Promise<WorkItemStatus> {
    // Hard cap on iterations as a safety net against budget mutation bugs.
    for (let i = 0; i < 50; i++) {
      const item = await this.prisma.workItem.findUnique({ where: { id: workItemId } });
      if (!item) throw new NotFoundException('work item not found');
      if (item.status === 'done' || item.status === 'dead') return item.status;
      if (item.attempts >= item.maxAttempts) return item.status;
      await this.attemptOnce(workItemId);
    }
    const finalItem = await this.prisma.workItem.findUnique({ where: { id: workItemId } });
    return finalItem!.status;
  }

  /**
   * Operator-initiated replay of a dead (or failed) item. Grants a fresh attempt
   * budget, records the manual transition, and re-runs the bounded loop.
   */
  async retry(workspaceId: string, workItemId: string): Promise<WorkItemStatus> {
    const item = await this.prisma.workItem.findFirst({
      where: { id: workItemId, workspaceId },
      include: { event: { select: { vendorEventId: true } } },
    });
    if (!item) throw new NotFoundException('work item not found');
    if (item.status === 'done' || item.status === 'pending') {
      // Nothing to retry; return current status unchanged.
      return item.status;
    }

    await this.prisma.$transaction([
      this.prisma.workItem.update({
        where: { id: item.id },
        data: {
          status: 'pending',
          maxAttempts: item.attempts + DEFAULT_MAX_ATTEMPTS,
          lastError: null,
        },
      }),
      this.prisma.statusTransition.create({
        data: {
          workItemId: item.id,
          fromStatus: item.status,
          toStatus: 'pending',
          attempt: item.attempts,
          note: 'operator retry',
        },
      }),
    ]);

    this.logger.log(
      `retry workItem=${item.id} tenantId=${workspaceId} vendor=${item.vendor} ` +
        `eventId=${item.event.vendorEventId} from=${item.status}`,
    );
    return this.processUntilSettled(item.id);
  }

  // ---- Scoped reads (always filtered by workspaceId) ----

  async list(
    workspaceId: string,
    filters: { status?: WorkItemStatus; vendor?: string; limit?: number },
  ) {
    const where: Prisma.WorkItemWhereInput = { workspaceId };
    if (filters.status) where.status = filters.status;
    if (filters.vendor) where.vendor = filters.vendor;

    const items = await this.prisma.workItem.findMany({
      where,
      include: { event: { select: { vendorEventId: true, eventType: true, receivedAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 50, 200),
    });

    return items.map((it) => ({
      id: it.id,
      vendor: it.vendor,
      status: it.status,
      attempts: it.attempts,
      maxAttempts: it.maxAttempts,
      lastError: it.lastError,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      eventId: it.event.vendorEventId,
      eventType: it.event.eventType,
      receivedAt: it.event.receivedAt,
    }));
  }

  async detail(workspaceId: string, workItemId: string) {
    const item = await this.prisma.workItem.findFirst({
      where: { id: workItemId, workspaceId },
      include: {
        event: true,
        transitions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!item) throw new NotFoundException('work item not found');

    return {
      id: item.id,
      vendor: item.vendor,
      status: item.status,
      attempts: item.attempts,
      maxAttempts: item.maxAttempts,
      lastError: item.lastError,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      event: {
        id: item.event.id,
        vendor: item.event.vendor,
        vendorEventId: item.event.vendorEventId,
        eventType: item.event.eventType,
        receivedAt: item.event.receivedAt,
        // metadata only: secrets redacted
        payload: redact(item.event.payload),
      },
      transitions: item.transitions.map((t) => ({
        id: t.id,
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        attempt: t.attempt,
        note: t.note,
        createdAt: t.createdAt,
      })),
    };
  }
}
