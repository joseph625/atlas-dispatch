import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signature scheme (documented in NOTES.md / README):
 *
 *   Header  X-Webhook-Key: <keyId>
 *   Header  X-Signature:   t=<unixSeconds>,v1=<hexHmacSha256>
 *
 *   signedString = `${t}.${rawBodyBytes}`
 *   v1           = HMAC_SHA256(secret, signedString)  (lowercase hex)
 *
 * The timestamp is part of the signed string, so an attacker cannot replay an
 * old body with a fresh timestamp without the secret. Freshness is enforced
 * separately against a tolerance window to bound replay.
 */

export interface ParsedSignature {
  t: number;
  v1: string;
}

export function parseSignatureHeader(header: string | undefined): ParsedSignature | null {
  if (!header) return null;
  const parts = header.split(',').map((p) => p.trim());
  let t: number | undefined;
  let v1: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') t = Number(value);
    else if (key === 'v1') v1 = value;
  }
  if (t === undefined || Number.isNaN(t) || !v1) return null;
  return { t, v1 };
}

export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): string {
  const signedString = `${timestamp}.${rawBody.toString('utf8')}`;
  return createHmac('sha256', secret).update(signedString).digest('hex');
}

/** Constant-time compare of two hex strings of arbitrary length. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type VerifyResult =
  { ok: true; timestamp: number } | { ok: false; reason: 'malformed' | 'stale' | 'bad_signature' };

export function verifySignature(params: {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  nowSeconds: number;
  toleranceSeconds: number;
}): VerifyResult {
  const parsed = parseSignatureHeader(params.signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed' };

  if (Math.abs(params.nowSeconds - parsed.t) > params.toleranceSeconds) {
    return { ok: false, reason: 'stale' };
  }

  const expected = computeSignature(params.secret, parsed.t, params.rawBody);
  if (!safeEqualHex(expected, parsed.v1)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, timestamp: parsed.t };
}
