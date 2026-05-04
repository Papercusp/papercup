export default function ProjectsLoading() {
  return (
    <div
      aria-busy="true"
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '24px 24px 48px',
        color: 'var(--text, #e5e7eb)',
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 600, marginBottom: 4 }}>Projects</div>
      <div style={{ color: 'var(--text-3, #9ca3af)', marginBottom: 20 }}>Loading project list…</div>
      <div className="pc-card pc-marketplace-loading">Loading…</div>
    </div>
  );
}
