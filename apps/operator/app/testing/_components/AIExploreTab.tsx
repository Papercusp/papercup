'use client';

export default function AIExploreTab() {
  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">AI Explore</h1>
          <p className="pc-test-tab-intro">
            Goal-directed exploration via Stagehand + Anthropic. Describe what a user is trying
            to do; the LLM drives Playwright against the dev webapp and records perf metrics for
            each step. Slower than Chaos but finds workflow breakage that random clicks miss.
          </p>
        </div>
      </header>
      <div className="pc-test-stub">
        <p style={{ margin: 0, marginBottom: 8, fontWeight: 600 }}>Not wired yet.</p>
        <p style={{ margin: 0 }}>
          Stagehand 3.4.0 is installed; this tab needs (a) a server route to spawn the Playwright
          subprocess, (b) <code>ANTHROPIC_API_KEY</code> wired through, (c) a cost cap (default
          $1/run). Tracked in the plan doc — fill in after Chaos + Live metrics have shaken out
          in real use.
        </p>
      </div>
    </>
  );
}
