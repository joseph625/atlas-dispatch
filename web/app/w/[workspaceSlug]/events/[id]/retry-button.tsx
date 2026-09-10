'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { retryAction } from '@/app/actions';

export function RetryButton({
  slug,
  id,
  status,
  canRetry,
}: {
  slug: string;
  id: string;
  status: string;
  canRetry: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const isRetryable = status === 'dead' || status === 'failed';
  if (!isRetryable) return null;

  // Read-only role (ops-viewer): show why the action is unavailable.
  if (!canRetry) {
    return (
      <span className="muted" style={{ fontSize: 13 }} title="requires the workitem:retry permission">
        🔒 Retry needs ops-admin
      </span>
    );
  }

  return (
    <button
      className="btn primary"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await retryAction(slug, id);
          router.refresh();
        })
      }
    >
      {pending ? 'Retrying…' : 'Retry work item'}
    </button>
  );
}
