import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from 'prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkItemsService } from '../workitems/work-items.service';
import { verifySignature } from './hmac';
import { ingestLine } from '../common/logger';

const TOLERANCE_SECONDS = Number(process.env.WEBHOOK_TOLERANCE_SECONDS ?? 300);
const MAX_BODY_BYTES = Number(process.env.WEBHOOK_MAX_BODY_BYTES ?? 65536);
const DEFAULT_MAX_ATTEMPTS = Number(process.env.WORK_ITEM_MAX_ATTEMPTS ?? 3);

export interface IngestResult {
  outcome: 'accepted' | 'duplicate';
  eventId: string;
  workItemId: string;
  status: string;
  workspaceSlug: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Ingest');

  constructor(
    private readonly prisma: PrismaService,
    private readonly workItems: WorkItemsService,
  ) {}

  async ingest(params: {
    vendorParam: string;
    keyId: string | undefined;
    signatureHeader: string | undefined;
    rawBody: Buffer | undefined;
    body: unknown;
  }): Promise<IngestResult> {
    const { vendorParam, keyId, signatureHeader, rawBody, body } = params;

    const reject = (
      status:
        | 'unsigned'
        | 'stale'
        | 'bad_signature'
        | 'unknown_key'
        | 'vendor_mismatch'
        | 'bad_request'
        | 'too_large',
      exc: Error,
      keyIdForLog?: string,
    ): never => {
      this.logger.warn(
        ingestLine({ vendor: vendorParam, keyId: keyIdForLog, outcome: `reject:${status}` }),
      );
      throw exc;
    };

    if (!rawBody || rawBody.length === 0) {
      reject('bad_request', new BadRequestException('empty body'));
    }
    if (rawBody!.length > MAX_BODY_BYTES) {
      // Belt-and-braces; the body parser already enforces this (413).
      reject('too_large', new PayloadTooLargeException('body too large'));
    }
    if (!keyId) {
      reject('unsigned', new UnauthorizedException('missing X-Webhook-Key'));
    }

    const credential = await this.prisma.vendorCredential.findFirst({
      where: { keyId: keyId!, active: true },
      include: { workspace: true },
    });
    if (!credential) {
      reject('unknown_key', new UnauthorizedException('unknown signing key'), keyId);
    }
    if (credential!.vendor !== vendorParam) {
      reject('vendor_mismatch', new UnauthorizedException('vendor mismatch'), keyId);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const verdict = verifySignature({
      secret: credential!.secret,
      rawBody: rawBody!,
      signatureHeader,
      nowSeconds,
      toleranceSeconds: TOLERANCE_SECONDS,
    });
    if (!verdict.ok) {
      if (verdict.reason === 'malformed') {
        reject('unsigned', new UnauthorizedException('malformed signature header'), keyId);
      } else if (verdict.reason === 'stale') {
        reject('stale', new UnauthorizedException('timestamp outside tolerance'), keyId);
      } else {
        reject('bad_signature', new UnauthorizedException('signature mismatch'), keyId);
      }
    }

    // vendor event id drives idempotency; require it explicitly.
    const vendorEventId =
      body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined;
    if (!vendorEventId || typeof vendorEventId !== 'string') {
      reject(
        'bad_request',
        new UnprocessableEntityException('missing event id ("id" field)'),
        keyId,
      );
    }
    const eventType =
      body && typeof body === 'object'
        ? (((body as Record<string, unknown>).type as string | undefined) ?? null)
        : null;

    const workspaceId = credential!.workspaceId;
    const vendor = credential!.vendor;
    const signature = (signatureHeader ?? '').slice(0, 200);

    // --- Idempotent create: event + work item in one transaction ---
    let created: { eventId: string; workItemId: string } | null = null;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const event = await tx.event.create({
          data: {
            workspaceId,
            vendor,
            vendorEventId: vendorEventId as string,
            eventType,
            payload: body as Prisma.InputJsonValue,
            signature,
          },
        });
        const workItem = await tx.workItem.create({
          data: {
            workspaceId,
            eventId: event.id,
            vendor,
            status: 'pending',
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
          },
        });
        await tx.statusTransition.create({
          data: {
            workItemId: workItem.id,
            fromStatus: null,
            toStatus: 'pending',
            attempt: 0,
            note: 'received',
          },
        });
        return { eventId: event.id, workItemId: workItem.id };
      });
    } catch (e) {
      // Unique violation on (workspaceId, vendor, vendorEventId) => vendor retry.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.event.findUnique({
          where: {
            workspaceId_vendor_vendorEventId: {
              workspaceId,
              vendor,
              vendorEventId: vendorEventId as string,
            },
          },
          include: { workItem: true },
        });
        this.logger.log(
          ingestLine({
            tenantId: workspaceId,
            workspaceSlug: credential!.workspace.slug,
            vendor,
            eventId: vendorEventId as string,
            keyId,
            outcome: 'duplicate',
          }),
        );
        return {
          outcome: 'duplicate',
          eventId: existing!.id,
          workItemId: existing!.workItem!.id,
          status: existing!.workItem!.status,
          workspaceSlug: credential!.workspace.slug,
        };
      }
      throw e;
    }

    this.logger.log(
      ingestLine({
        tenantId: workspaceId,
        workspaceSlug: credential!.workspace.slug,
        vendor,
        eventId: vendorEventId as string,
        keyId,
        outcome: 'accepted',
      }),
    );

    // Event is durably committed BEFORE we run the handler. A crash mid-handler
    // leaves the work item recoverable (pending/failed) — see NOTES.md.
    const status = await this.workItems.processUntilSettled(created.workItemId);

    return {
      outcome: 'accepted',
      eventId: created.eventId,
      workItemId: created.workItemId,
      status,
      workspaceSlug: credential!.workspace.slug,
    };
  }
}
