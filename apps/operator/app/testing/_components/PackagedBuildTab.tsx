'use client';

export default function PackagedBuildTab() {
  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">Packaged build</h1>
          <p className="pc-test-tab-intro">
            WebdriverIO + tauri-driver runner that drives the shipped Tauri binary (not the dev
            webapp). The only path that catches IPC latency, window-creation cost, and asset-protocol
            load times in the real binary. CI-shaped — run before each release.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Setup (one-time)</h2>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
          <li><code>cargo install tauri-driver</code> — installed ✓</li>
          <li>Linux only: <code>sudo apt install webkit2gtk-driver</code></li>
          <li>From <code>tools/perf-test/wdio/</code>: <code>npm install</code></li>
        </ol>
      </div>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Run</h2>
        <pre style={{ fontSize: 12, lineHeight: 1.5, background: 'var(--bg-3)', padding: 12, borderRadius: 4, margin: 0 }}>
{`# 1. Build the packaged desktop binary
pnpm --filter @papercusp/desktop build

# 2. Run wdio against the binary
cd tools/perf-test/wdio
npm test`}
        </pre>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 8 }}>
          See <code>tools/perf-test/wdio/README.md</code> for full details. UI-driven runs from
          this tab are deferred — invoking <code>npm test</code> from the browser needs an exec
          endpoint we haven't wired yet.
        </p>
      </div>
    </>
  );
}
