import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWorkItem, getMe, ApiError } from '@/lib/api';
import { RetryButton } from './retry-button';

export const dynamic = 'force-dynamic';

function fmt(ts: string) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string; id: string }>;
}) {
  const { workspaceSlug: slug, id } = await params;
  let item;
  let canRetry = false;
  try {
    const [detail, me] = await Promise.all([getWorkItem(slug, id), getMe()]);
    item = detail;
    canRetry = me.permissions.includes('workitem:retry');
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) notFound();
    throw e;
  }

  return (
    <>
      <Link className="back" href={`/w/${slug}/events`}>
        ← Back to events
      </Link>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <div>
          <h1 className="mono">{item.event.vendorEventId}</h1>
          <div className="row">
            <span className={`badge ${item.status}`}>{item.status}</span>
            <span className="muted">
              {item.vendor} · attempt {item.attempts}/{item.maxAttempts}
            </span>
          </div>
        </div>
        <RetryButton slug={slug} id={item.id} status={item.status} canRetry={canRetry} />
      </div>

      <h2>Metadata</h2>
      <div className="card">
        <div className="kv">
          <div className="k">Work item</div>
          <div className="mono">{item.id}</div>
          <div className="k">Vendor</div>
          <div>{item.vendor}</div>
          <div className="k">Event type</div>
          <div>{item.event.eventType ?? '—'}</div>
          <div className="k">Received</div>
          <div className="mono">{fmt(item.event.receivedAt)}</div>
          <div className="k">Last error</div>
          <div className="mono" style={{ color: item.lastError ? 'var(--red)' : 'var(--muted)' }}>
            {item.lastError ?? 'none'}
          </div>
        </div>
      </div>

      <h2>Payload (secrets redacted)</h2>
      <div className="card">
        <pre className="payload">{JSON.stringify(item.event.payload, null, 2)}</pre>
      </div>

      <h2>Status history</h2>
      <div className="card">
        <ul className="timeline">
          {item.transitions.map((t) => (
            <li key={t.id}>
              <span className={`dot ${t.toStatus}`} />
              <div>
                <div>
                  <strong>{t.fromStatus ?? 'new'}</strong> → <strong>{t.toStatus}</strong>
                  <span className="muted"> · attempt {t.attempt}</span>
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {fmt(t.createdAt)} — {t.note ?? ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
