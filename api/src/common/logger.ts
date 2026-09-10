import { ConsoleLogger } from '@nestjs/common';

/**
 * Structured-ish logger. Callers pass context objects; we never log raw
 * secrets or full payloads — only tenantId, vendor, eventId and outcome.
 */
export class AppLogger extends ConsoleLogger {}

interface IngestLogFields {
  tenantId?: string;
  workspaceSlug?: string;
  vendor: string;
  eventId?: string;
  keyId?: string;
  outcome: string;
  detail?: string;
}

export function ingestLine(fields: IngestLogFields): string {
  const parts = [
    `outcome=${fields.outcome}`,
    `vendor=${fields.vendor}`,
    fields.tenantId ? `tenantId=${fields.tenantId}` : `tenantId=-`,
    fields.workspaceSlug ? `workspace=${fields.workspaceSlug}` : undefined,
    fields.eventId ? `eventId=${fields.eventId}` : `eventId=-`,
    fields.keyId ? `keyId=${fields.keyId}` : undefined,
    fields.detail ? `detail=${JSON.stringify(fields.detail)}` : undefined,
  ].filter(Boolean);
  return parts.join(' ');
}
