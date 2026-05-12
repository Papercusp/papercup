'use client';

interface Provider {
  readonly id: 'claude' | 'openai';
  readonly title: string;
  readonly summary: string;
  readonly instructions: string;
  readonly cmd: string;
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'claude',
    title: 'Claude account',
    summary:
      "If you have a Claude Pro or Max plan, sign in once and your subscription covers Claude Code usage. No per-token API charges.",
    instructions:
      'Run this in a terminal — the bridge forwards your browser sign-in to the local CLI. Claude Code is routed through Meridian, so you\'ll see the Meridian profile in the auth window.',
    cmd: 'claude /login',
  },
  {
    id: 'openai',
    title: 'OpenAI account',
    summary:
      "If you have a ChatGPT Plus, Team, or Pro plan, sign in once and your subscription covers Codex usage. No per-token API charges.",
    instructions:
      'Run this in a terminal. The login URL opens in your default browser; the CLI captures the token automatically.',
    cmd: 'omp /login',
  },
];

export function StepLogins() {
  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Each coding agent has two ways to authenticate: <strong>account login</strong> (uses your
        existing subscription — no per-token cost) or <strong>API key</strong> (pay-per-use; covered
        in the next step). Account login is preferred when available.
      </p>
      <p className="pc-step__hint">
        You'll always find these on this screen — they're not just for first-run. Switching accounts
        or re-authenticating is a one-command operation.
      </p>
      <div className="pc-provider-grid">
        {PROVIDERS.map((p) => (
          <div key={p.id} className="pc-provider-card">
            <h3 className="pc-provider-card__title">{p.title}</h3>
            <p className="pc-provider-card__summary">{p.summary}</p>
            <p className="pc-provider-card__instructions">{p.instructions}</p>
            <pre className="pc-code">{p.cmd}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
