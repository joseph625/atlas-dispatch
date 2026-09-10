/**
 * The simulated "handler". A real system would call downstream services here.
 *
 * Behaviour is driven by an optional `simulate` field in the event payload so
 * the failure path is deterministic and demoable:
 *
 *   (absent) | "ok"        -> succeeds
 *   "fail"                 -> always throws
 *   "fail-until:N"         -> throws while attempt < N, then succeeds on attempt N
 *
 * `attempt` is 1-based (the attempt number currently being executed).
 */
export function runHandler(payload: unknown, attempt: number): void {
  const simulate =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).simulate
      : undefined;

  if (simulate === undefined || simulate === 'ok') return;

  if (simulate === 'fail') {
    throw new Error('simulated permanent failure');
  }

  if (typeof simulate === 'string' && simulate.startsWith('fail-until:')) {
    const threshold = Number(simulate.split(':')[1]);
    if (!Number.isNaN(threshold) && attempt < threshold) {
      throw new Error(`simulated transient failure (attempt ${attempt} < ${threshold})`);
    }
    return;
  }

  // Unknown simulate value -> treat as success (do not block real traffic).
}
