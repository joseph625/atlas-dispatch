import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container" style={{ maxWidth: 560 }}>
      <h1>404 — not found</h1>
      <p className="muted">
        This workspace or work item doesn&apos;t exist, or you&apos;re not a member of it. We
        return the same 404 in both cases so tenant existence never leaks.
      </p>
      <Link className="btn" href="/">
        ← Back to sign-in
      </Link>
    </div>
  );
}
