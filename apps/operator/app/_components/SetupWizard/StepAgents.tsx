'use client';

import { useEffect, useState } from 'react';

interface PreflightCheck {
  name: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
  hint?: string;
}

interface AgentRow {
  readonly id: 'claude' | 'omp';
  readonly title: string;
  readonly description: string;
  readonly installCmd: string;
  readonly docsHref: string;
  readonly preflightName: string;
}

const AGENTS: readonly AgentRow[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    description:
      "Anthropic's coding agent. The default backend; if you have a Claude Pro/Max plan, sign in once and your subscription covers usage.",
    installCmd: 'npm install -g @anthropic-ai/claude-cli',
    docsHref: 'https://docs.anthropic.com/claude/docs/claude-code',
    preflightName: 'claude',
  },
  {
    id: 'omp',
    title: 'OpenAI Codex (via oh-my-pi)',
    description:
      "OpenAI's coding agent — also supports mixing providers (Anthropic, OpenAI, others). Use this if you prefer OpenAI's models or want multi-provider flexibility.",
    installCmd: 'npm install -g @oh-my-pi/cli',
    docsHref: 'https://github.com/can1357/oh-my-pi',
    preflightName: 'pi',
  },
];

export function StepAgents() {
  const [checks, setChecks] = useState<Record<string, PreflightCheck>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/desktop/preflight', { cache: 'no-store' });
        const j = await r.json();
        if (cancelled) return;
        const map: Record<string, PreflightCheck> = {};
        for (const c of j.checks ?? []) map[c.name] = c;
        setChecks(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const anyInstalled = AGENTS.some((a) => checks[a.preflightName]?.status === 'ok');

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp drives one or both of these coding agents. <strong>At least one is required.</strong>{' '}
        You can install both and switch between them later.
      </p>

      {!loading && (
        <div
          className="pc-step__progress"
          data-status={anyInstalled ? 'ok' : 'missing'}
        >
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            {anyInstalled ? (
              <>
                <strong>Ready.</strong>
                <span>At least one coding agent is installed.</span>
              </>
            ) : (
              <>
                <strong>No coding agent installed.</strong>
                <span>Install one of the options below.</span>
              </>
            )}
          </div>
        </div>
      )}

      <div className="pc-agent-grid">
        {AGENTS.map((a) => {
          const c = checks[a.preflightName];
          const status = c?.status ?? 'missing';
          return (
            <div key={a.id} className="pc-agent-card" data-status={status}>
              <div className="pc-agent-card__head">
                <h3>{a.title}</h3>
                <span className="pc-agent-card__badge" data-status={status}>
                  {status === 'ok' ? 'Installed' : status === 'missing' ? 'Not installed' : 'Error'}
                </span>
              </div>
              <p className="pc-agent-card__desc">{a.description}</p>
              {c?.detail && status === 'ok' && <p className="pc-agent-card__detail">{c.detail}</p>}
              {status !== 'ok' && (
                <>
                  <p className="pc-agent-card__install-label">Install from a terminal:</p>
                  <pre className="pc-code">{a.installCmd}</pre>
                </>
              )}
              <p className="pc-agent-card__link">
                <a href={a.docsHref} target="_blank" rel="noreferrer">
                  Docs ↗
                </a>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
