export default function Loading() {
  // The workspace shell (name/badge) is already rendered by the layout, which
  // resolved the tenant server-side — so this skeleton never flashes the wrong
  // workspace name while the list streams in.
  return (
    <>
      <h1>Events &amp; work items</h1>
      <div className="muted">Loading…</div>
      <div className="card" style={{ marginTop: 12, height: 160, opacity: 0.4 }} />
    </>
  );
}
