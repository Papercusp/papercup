import Link from 'next/link';
import { SupportChatButton } from '../_components/SupportChatButton';
import { SupportAgentPanel } from '../_components/SupportAgentPanel';

export const metadata = {
  title: 'Support · Papercusp',
};

interface FaqItem {
  q: string;
  a: React.ReactNode;
}

const FAQS: FaqItem[] = [
  {
    q: "First-run says 'claude not found'. What do I install?",
    a: (
      <>
        <p>
          Install the Anthropic Claude CLI globally:
        </p>
        <pre>npm install -g @anthropic-ai/claude-cli</pre>
        <p>
          You'll need Node.js 20+ on PATH. Verify with <code>claude --version</code>. The first-run banner on the home page turns from red to green once Papercusp can find <code>claude</code>.
        </p>
      </>
    ),
  },
  {
    q: 'I added my API key but the harness still says it can\'t reach the LLM.',
    a: (
      <>
        <p>
          Three things to check, in order:
        </p>
        <ol>
          <li>
            Re-open <Link href="/settings/api-keys">Settings → API keys</Link>. The form preserves <em>missing</em> fields when you save other ones, but it can't show you the existing key (only whether it's set). If the green dot isn't there, your save didn't take.
          </li>
          <li>
            Check that you're not over your <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer">monthly Anthropic quota</a>. The CLI returns a generic "can't reach LLM" on rate-limit responses.
          </li>
          <li>
            If you log in via <code>claude /login</code> (Claude Max), the <em>API key</em> field should be empty. Setting both can confuse the auth path; clear the API key and re-run.
          </li>
        </ol>
      </>
    ),
  },
  {
    q: 'My harness exited unexpectedly. How do I see what happened?',
    a: (
      <>
        <p>
          The <em>brain</em> tab on the harness dashboard shows the last orchestrator decision and the cost-to-date. Two common exit causes:
        </p>
        <ul>
          <li><strong>Cost cap hit</strong> — default <code>maxCostUsd: 10</code>. Raise in <code>~/.papercusp/projects/&lt;name&gt;/.harness/config.json</code> and re-run.</li>
          <li><strong>Validator rejection loop</strong> — same feature failing 3 attempts. The dashboard shows the failed feature in red; click it to see validator output and either edit your SPEC.md or accept the proposal manually.</li>
        </ul>
        <p>For deeper debugging, the embedded <em>pi</em> tab (omp terminal) lets you ask the harness questions directly.</p>
      </>
    ),
  },
  {
    q: "Where do I publish my own harness template / plugin?",
    a: (
      <>
        <p>
          Run <code>papercusp publish</code> from the directory containing your <code>papercusp.json</code>. The CLI handles signing, secret-scanning, and SBOM generation automatically.
        </p>
        <p>
          You'll need a GitHub identity to publish — run <code>papercusp login</code> first. Your namespace is your GitHub login (e.g. <code>@avi/my-template</code>).
        </p>
        <p>
          Browse what's already there at the <Link href="/marketplace/templates">templates</Link> and <Link href="/marketplace/plugins">plugins</Link> pages.
        </p>
      </>
    ),
  },
  {
    q: 'My desktop app says "Apple cannot verify the developer" / Windows SmartScreen warns me.',
    a: (
      <>
        <p>
          Papercusp Desktop v0.0.1 is unsigned (code-signing on the roadmap). The OS warning is expected; Papercusp itself is safe to run.
        </p>
        <ul>
          <li><strong>macOS</strong>: right-click the .app, choose <em>Open</em>, then <em>Open</em> in the dialog.</li>
          <li><strong>Windows</strong>: in the SmartScreen dialog click <em>More info → Run anyway</em>.</li>
          <li><strong>Linux</strong>: no warning; just install the .deb / .rpm.</li>
        </ul>
      </>
    ),
  },
  {
    q: 'How do I reset / start over with a clean install?',
    a: (
      <>
        <p>Two levels of reset:</p>
        <ul>
          <li>
            <strong>Per project</strong>: <code>rm -rf ~/.papercusp/projects/&lt;name&gt;</code>. The project's database schema (<code>harness_&lt;name&gt;</code>) stays — drop it manually with <code>papercusp scaffold-schema --drop &lt;name&gt;</code> if you want a clean slate.
          </li>
          <li>
            <strong>Full reset</strong>: <code>rm -rf ~/.papercusp/</code> (loses all projects, credentials, marketplace cache). The Postgres data is separate; if you're using pglite-mode, also remove <code>~/.papercusp/pglite-data</code>.
          </li>
        </ul>
      </>
    ),
  },
];

export default function SupportPage() {
  return (
    <div className="pc-shell" style={{ maxWidth: 820, margin: '0 auto', padding: '32px 28px' }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Support</h1>
      <p style={{ color: 'var(--fg-mute)', fontSize: 15, marginBottom: 32, lineHeight: 1.55 }}>
        First check the FAQs below — they cover the most common stuck points. If you're still
        blocked, start a chat with our support team or open a GitHub issue.
      </p>

      {/* AI agent panel — try AI first, fall back to human */}
      <SupportAgentPanel surface="operator" />

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 40 }}>
        <SupportChatButton className="pc-button" message="">
          💬 Start support chat
        </SupportChatButton>
        <a
          href="https://github.com/papercupai/papercusp/issues/new"
          target="_blank"
          rel="noreferrer"
          className="pc-button"
          style={{ background: 'var(--bg-1)' }}
        >
          🐛 Open a GitHub issue
        </a>
        <a
          href="https://papercuspai.com/docs/"
          target="_blank"
          rel="noreferrer"
          className="pc-button"
          style={{ background: 'var(--bg-1)' }}
        >
          📚 Browse the docs
        </a>
      </div>

      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Frequently asked</h2>
      <div>
        {FAQS.map((f, i) => (
          <details
            key={i}
            style={{
              padding: '14px 18px',
              marginBottom: 8,
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <summary style={{ cursor: 'pointer', fontSize: 15, fontWeight: 600, listStyle: 'none' }}>
              <span style={{ marginRight: 8, color: 'var(--fg-mute)' }}>›</span>
              {f.q}
            </summary>
            <div
              style={{
                marginTop: 12,
                color: 'var(--fg-mute)',
                fontSize: 14,
                lineHeight: 1.65,
              }}
            >
              {f.a}
            </div>
          </details>
        ))}
      </div>

      <div
        style={{
          marginTop: 40,
          padding: 20,
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontSize: 14,
          color: 'var(--fg-mute)',
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>Resources:</strong>{' '}
        <a href="https://papercuspai.com/docs/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>full documentation</a>{' '}·{' '}
        <a href="https://papercusp.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>marketing site</a>{' '}·{' '}
        <a href="https://github.com/papercupai/papercusp/issues" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>issue tracker</a>{' '}·{' '}
        <Link href="/setup" style={{ color: 'var(--accent)' }}>5-step setup</Link>
      </div>
    </div>
  );
}
