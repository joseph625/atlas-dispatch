import Link from 'next/link';
import { listWorkItems } from '@/lib/api';

export const dynamic = 'force-dynamic';

const STATUSES = ['all', 'pending', 'done', 'failed', 'dead'] as const;

function fmt(ts: string) {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export default async function EventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ status?: string; vendor?: string }>;
}) {
  const { workspaceSlug: slug } = await params;
  const sp = await searchParams;
  const activeStatus = sp.status ?? 'all';
  const items = await listWorkItems(slug, {
    status: activeStatus === 'all' ? undefined : activeStatus,
    vendor: sp.vendor,
  });

  const buildHref = (status: string) => {
    const qs = new URLSearchParams();
    if (status !== 'all') qs.set('status', status);
    if (sp.vendor) qs.set('vendor', sp.vendor);
    const s = qs.toString();
    return `/w/${slug}/events${s ? `?${s}` : ''}`;
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Events &amp; work items</h1>
          <div className="muted">Signed vendor events and their processing state.</div>
        </div>
      </div>

      {/* Status filter lives in the URL (source of truth) */}
      <div className="filters">
        {STATUSES.map((s) => (
          <Link key={s} href={buildHref(s)} className={`chip ${activeStatus === s ? 'active' : ''}`}>
            {s}
          </Link>
        ))}
      </div>

      <div className="card" style={{ padding: 0, marginTop: 12 }}>
        {items.length === 0 ? (
          <div className="empty">No work items match this filter.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event id</th>
                <th>Vendor</th>
                <th>Type</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Received</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="mono">{it.eventId}</td>
                  <td>{it.vendor}</td>
                  <td className="muted">{it.eventType ?? '—'}</td>
                  <td>
                    <span className={`badge ${it.status}`}>{it.status}</span>
                  </td>
                  <td className="mono">
                    {it.attempts}/{it.maxAttempts}
                  </td>
                  <td className="muted mono" style={{ fontSize: 12 }}>{fmt(it.receivedAt)}</td>
                  <td>
                    <Link className="btn" href={`/w/${slug}/events/${it.id}`}>
                      Inspect
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>
        Showing {items.length} item{items.length === 1 ? '' : 's'}. List is server-rendered fresh on
        every load, so new webhooks appear on reload; operator retries revalidate instantly.
      </p>
    </>
  );
}
