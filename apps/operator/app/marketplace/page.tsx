import Link from 'next/link';

export default function MarketplaceLandingPage() {
  return (
    <div className="pc-shell">
      <h1>Marketplace</h1>
      <p style={{ color: 'var(--fg-mute)', marginBottom: 32 }}>
        Two distinct catalogs. Pick the one you need.
      </p>

      <div className="pc-grid cards-2" style={{ gap: 20 }}>
        <Link href="/marketplace/templates" className="pc-card" style={cardStyle}>
          <span style={badgeTemplate}>Templates</span>
          <h2 style={{ margin: '12px 0 6px' }}>Spin up a fresh harness</h2>
          <p style={{ color: 'var(--fg-mute)', margin: 0, lineHeight: 1.55 }}>
            Self-contained harness configurations. Each defines an autonomous-agent setup —
            roles, prompts, schedules, policies. Install with{' '}
            <code style={inlineCode}>papercusp install &lt;slug&gt;</code> to get a fresh harness instance.
          </p>
          <p style={ctaStyle}>Browse templates →</p>
        </Link>

        <Link href="/marketplace/plugins" className="pc-card" style={cardStyle}>
          <span style={badgePlugin}>Plugins</span>
          <h2 style={{ margin: '12px 0 6px' }}>Extend an existing harness</h2>
          <p style={{ color: 'var(--fg-mute)', margin: 0, lineHeight: 1.55 }}>
            Add capabilities to a harness you already run. Plugins contribute actions,
            dashboard tabs, secrets, and integrations. Install per-machine, then enable per-harness.
          </p>
          <p style={ctaStyle}>Browse plugins →</p>
        </Link>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: 24, borderRadius: 12, textDecoration: 'none', color: 'inherit',
  display: 'flex', flexDirection: 'column',
};
const badgeBase: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
  padding: '3px 8px', borderRadius: 999, alignSelf: 'flex-start',
};
const badgeTemplate: React.CSSProperties = {
  ...badgeBase,
  background: 'rgba(34, 197, 94, 0.12)', color: '#86efac',
  border: '1px solid rgba(34, 197, 94, 0.3)',
};
const badgePlugin: React.CSSProperties = {
  ...badgeBase,
  background: 'rgba(99, 102, 241, 0.15)', color: '#a5b4fc',
  border: '1px solid rgba(99, 102, 241, 0.3)',
};
const inlineCode: React.CSSProperties = {
  fontFamily: "'SF Mono', monospace", fontSize: 12,
  padding: '1px 6px', borderRadius: 3,
  background: 'var(--bg-1)', border: '1px solid var(--border)',
};
const ctaStyle: React.CSSProperties = {
  marginTop: 16, marginBottom: 0, fontSize: 13, color: 'var(--accent)',
};
