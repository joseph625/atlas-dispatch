const SECRET_KEY_RE = /(secret|token|password|passwd|api[-_]?key|authorization|signature|hmac)/i;

/**
 * Redact anything that looks like a credential before returning a payload to
 * the UI. Detail views show payload *metadata*, not secrets.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}
