import { redirect, notFound } from 'next/navigation';
import { getAccessToken } from '@/lib/session';
import { getWorkspace, ApiError } from '@/lib/api';
import { logout } from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  if (!(await getAccessToken())) redirect('/');

  // Resolve the workspace server-side BEFORE rendering. The API returns 404 if
  // the signed-in user is not a member (or the slug is bogus), so we render
  // not-found rather than ever flashing another tenant's name/data.
  let workspace: { slug: string; name: string };
  try {
    workspace = await getWorkspace(workspaceSlug);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) notFound();
    throw e;
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            Northline <span>Atlas</span>
          </div>
          <div className="row">
            <div className="ws-badge">
              {workspace.name} <small>/{workspace.slug}</small>
            </div>
            <form action={logout}>
              <button className="btn" type="submit">Switch user</button>
            </form>
          </div>
        </div>
      </header>
      <div className="container">{children}</div>
    </>
  );
}
