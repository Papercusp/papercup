import RouteLink from '../_components/RouteLink';

export const metadata = {
  title: 'Setup · Papercusp',
};

export default function SetupPage() {
  return (
    <div className="pc-shell" style={{ maxWidth: 760, margin: '0 auto', padding: '32px 28px' }}>
      <p style={{ marginBottom: 8 }}>
        <RouteLink href="/" style={{ color: 'var(--fg-mute)', fontSize: 12 }}>← back to home</RouteLink>
      </p>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Setup</h1>
      <p style={{ color: 'var(--fg-mute)', fontSize: 15, marginBottom: 32, lineHeight: 1.55 }}>
        Five-minute checklist from fresh install to your first running harness. Already have a
        running harness? Skip to{' '}
        <RouteLink href="/harness" style={{ color: 'var(--accent)' }}>
          /harness
        </RouteLink>
        .
      </p>

      <Step n={1} title="Install the Claude CLI">
        <p>
          Papercusp drives Anthropic&rsquo;s <code>claude</code> CLI for the AI roles. Install it
          once globally:
        </p>
        <pre className="pc-code">npm install -g @anthropic-ai/claude-cli</pre>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
          Requires Node.js 20+ on PATH. The <RouteLink href="/" style={{ color: 'var(--accent)' }}>home page</RouteLink> shows
          a red dot if Papercusp can&rsquo;t find <code>claude</code>; green when it can.
        </p>
      </Step>

      <Step n={2} title="Authenticate the claude CLI">
        <p>
          Run <code>claude</code> in a terminal and follow the sign-in
          prompt. The operator invokes <code>claude -p</code> for every
          agent run; there&rsquo;s no separate API-key step inside the
          UI. See{' '}
          <a
            href="https://docs.anthropic.com/claude/docs/claude-code"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            Claude Code documentation
          </a>{' '}
          for sign-in options. Whatever credentials <code>claude</code> picks
          up, the operator inherits.
        </p>
      </Step>

      <Step n={3} title="Install a harness template">
        <p>
          Click{' '}
          <RouteLink href="/marketplace" style={{ color: 'var(--accent)' }}>
            Marketplace
          </RouteLink>{' '}
          and install a template. <em>papercup-coding</em> is the simplest place to start.
        </p>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
          Templates can either scaffold a fresh project at <code>~/.papercusp/projects/&lt;name&gt;/</code>{' '}
          or attach to an existing repo via <em>Attach existing</em> mode.
        </p>
      </Step>

      <Step n={4} title="Edit your SPEC.md and run">
        <p>
          The harness has a <code>SPEC.md</code> describing the project goal. Edit it with what you
          want built — the more specific, the better the scoper plans. Then click <strong>Run</strong>{' '}
          on the dashboard, or:
        </p>
        <pre className="pc-code">papercusp run my-project</pre>
        <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
          The orchestrator dispatches scoper → worker → validator iterations. Cost cap is $10 by
          default; raise it in <code>.harness/config.json</code> per-project.
        </p>
      </Step>

      <Step n={5} title="Watch the dashboard">
        <p>
          Open <RouteLink href="/harness" style={{ color: 'var(--accent)' }}>/harness</RouteLink> and pick
          your project. The dashboard shows live mission state, feature progress, agent traces,
          and an embedded <em>pi</em> terminal pane for direct interaction.
        </p>
      </Step>

      <div
        style={{
          marginTop: 32,
          padding: 20,
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <strong>Stuck?</strong> Open an{' '}
        <a
          href="https://github.com/aviynw/Restart/issues/new"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--accent)' }}
        >
          issue
        </a>{' '}
        or check{' '}
        <a
          href="https://papercusp.com/support/"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--accent)' }}
        >
          papercusp.com/support
        </a>
        .
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginBottom: 28 }}>
      <div
        style={{
          flex: '0 0 36px',
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: 'var(--accent)',
          color: 'var(--bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          fontWeight: 700,
        }}
      >
        {n}
      </div>
      <div style={{ flex: 1 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginTop: 4, marginBottom: 8 }}>{title}</h3>
        <div style={{ color: 'var(--fg-mute)', lineHeight: 1.6 }}>{children}</div>
      </div>
    </div>
  );
}
