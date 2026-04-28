import ApiKeyStatus from './_components/ApiKeyStatus';

export default function HomePage() {
  return (
    <div className="pc-shell">
      <h1>Papercusp</h1>
      <p style={{ fontSize: 17, color: 'var(--fg)', maxWidth: 640, marginBottom: 32 }}>
        An open-source framework for running autonomous multi-agent missions.
        Define a goal in plain English, install a harness from the marketplace,
        and watch a coordinated team of AI roles plan, execute, validate, and
        iterate against your spec. Your API keys and project files stay on
        your machine — Papercusp runs harnesses locally against your own
        Anthropic / OpenAI keys.
      </p>

      <div
        style={{
          maxWidth: 760,
          margin: '0 auto 32px',
          padding: '14px 18px',
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontSize: 14,
          color: 'var(--fg-mute)',
          textAlign: 'center',
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>First time here?</strong> Run through the{' '}
        <a href="/setup" style={{ color: 'var(--accent)', fontWeight: 600 }}>
          5-step setup
        </a>{' '}
        — Claude CLI, API key, install a harness, run.
      </div>

      <div className="pc-grid cards-2" style={{ marginTop: 32 }}>
        <div className="pc-card">
          <h3>Open a harness</h3>
          <p>
            Run, monitor, and inspect your local harnesses — see live agent
            traces, feature plans, proposals, and the embedded pi terminal.
          </p>
          <a href="/harness" className="pc-button">Open →</a>
        </div>
        <div className="pc-card">
          <h3>Browse the marketplace</h3>
          <p>
            Pick a harness — a coding-project harness, a research org, a content
            pipeline — and install it with one click.
          </p>
          <a href="/marketplace" className="pc-button">Browse →</a>
        </div>
        <div className="pc-card">
          <h3>Configure API keys</h3>
          <p style={{ minHeight: 48 }}>
            Provide your Anthropic key (required) and optional OpenAI / GitHub
            credentials. Stored in <code>~/.papercusp/credentials.json</code>,
            never sent to our servers.
          </p>
          <div style={{ marginBottom: 12 }}><ApiKeyStatus /></div>
          <a href="/settings/api-keys" className="pc-button">Configure →</a>
        </div>
        <div className="pc-card">
          <h3>Publish your harness</h3>
          <p>
            Built something useful? Publish it to the marketplace so others
            can install it with <code>papercusp install &lt;slug&gt;</code>.
          </p>
          <a href="/signup" className="pc-button">Sign up →</a>
        </div>
      </div>

      <div style={{ marginTop: 48, paddingTop: 24, borderTop: '1px solid var(--border)', color: 'var(--fg-mute)', fontSize: 12 }}>
        <p>
          Papercup is the first reference install of Papercusp — a 5-department
          fictional company running an AI-driven shareholder briefing pipeline.
          See <a href="https://papercupai.com">papercupai.com</a>.
        </p>
      </div>
    </div>
  );
}
