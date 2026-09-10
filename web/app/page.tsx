import { getAccounts } from '@/lib/api';
import { login } from './actions';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const accounts = await getAccounts();

  return (
    <div className="container" style={{ maxWidth: 620 }}>
      <div className="brand" style={{ fontSize: 22, marginBottom: 6 }}>
        Northline <span>Atlas</span> Dispatch
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Sign in as a seeded operator (JWT auth). Each user is scoped to one tenant and carries a role —
        <strong> ops-admin</strong> can retry, <strong>ops-viewer</strong> is read-only. Demo password for
        all accounts: <code className="mono">password</code>.
      </p>

      <h2>Accounts</h2>
      <div className="account-list">
        {accounts.map((acc) =>
          acc.workspaces.map((ws) => (
            <form action={login} key={`${acc.id}:${ws.slug}`}>
              <input type="hidden" name="email" value={acc.email} />
              <input type="hidden" name="slug" value={ws.slug} />
              <button
                type="submit"
                className="account"
                style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>{acc.name}</div>
                  <div className="muted mono" style={{ fontSize: 12 }}>{acc.email}</div>
                </div>
                <div className="ws-badge">
                  {ws.name} <small>/{ws.slug}</small>
                </div>
              </button>
            </form>
          )),
        )}
      </div>
    </div>
  );
}
