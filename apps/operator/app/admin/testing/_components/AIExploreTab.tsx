'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../harness/Button';
import { Select } from '../../../harness/Select';
import { Checkbox } from '../../../harness/Checkbox';

interface MaskedCoreCredentials {
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
  updated_at: string | null;
  path: string;
}

type EventEntry =
  | { id: number; ts: number; kind: 'start'; goal: string; model: string; startUrl: string }
  | { id: number; ts: number; kind: 'step'; n: number; action: string; ok: boolean; durationMs: number; result: string | null }
  | { id: number; ts: number; kind: 'log'; level: string; line: string }
  | { id: number; ts: number; kind: 'metrics'; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }
  | { id: number; ts: number; kind: 'done'; totalMs: number; steps: number; costUsd: number; exitCode?: number }
  | { id: number; ts: number; kind: 'error'; message: string };

const MODELS = [
  { value: 'anthropic/claude-sonnet-4-6', label: 'Sonnet 4.6 (default)' },
  { value: 'anthropic/claude-haiku-4-5',  label: 'Haiku 4.5 (cheaper)' },
  { value: 'anthropic/claude-opus-4-7',   label: 'Opus 4.7 (slowest, smartest)' },
];

export default function AIExploreTab() {
  const [creds, setCreds] = useState<MaskedCoreCredentials | null>(null);
  const [credsLoading, setCredsLoading] = useState(true);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [showInput, setShowInput] = useState(false);

  const [goal, setGoal] = useState('Open the harnesses page, click into the first harness, switch to the Issues tab.');
  const [startUrl, setStartUrl] = useState('http://127.0.0.1:3055/');
  const [model, setModel] = useState('anthropic/claude-sonnet-4-6');
  const [maxSteps, setMaxSteps] = useState(20);
  const [maxCostUsd, setMaxCostUsd] = useState(1);
  const [headless, setHeadless] = useState(true);

  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/credentials')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setCreds(d); })
      .catch(() => { /* leave null */ })
      .finally(() => { if (!cancelled) setCredsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const saveKey = useCallback(async () => {
    if (!keyInput.trim()) return;
    setSaving(true);
    try {
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: keyInput.trim() }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d: MaskedCoreCredentials = await r.json();
      setCreds(d);
      setKeyInput('');
      setShowInput(false);
      toast.success(`Saved to ${d.path}`);
    } catch (err) {
      toast.error(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }, [keyInput]);

  const pushEvent = useCallback((evt: Omit<EventEntry, 'id' | 'ts'>) => {
    setEvents((cur) => [...cur, { id: ++seqRef.current, ts: Date.now(), ...evt } as EventEntry]);
  }, []);

  const launch = useCallback(async () => {
    if (running) return;
    if (!goal.trim()) { toast.error('Enter a goal first'); return; }
    setEvents([]);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/admin/testing/ai-explore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ goal, startUrl, model, maxSteps, maxCostUsd, headless }),
      });
      if (!res.ok || !res.body) {
        const msg = (await res.text().catch(() => '')) || `HTTP ${res.status}`;
        pushEvent({ kind: 'error', message: msg });
        setRunning(false);
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let currentEvent: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line === '') {
            currentEvent = null;
            continue;
          }
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ') && currentEvent) {
            const payload = JSON.parse(line.slice(6));
            pushEvent({ kind: currentEvent as EventEntry['kind'], ...payload } as Omit<EventEntry, 'id' | 'ts'>);
            if (currentEvent === 'done') setRunning(false);
          }
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        pushEvent({ kind: 'log', level: 'info', line: 'Run aborted by user' });
      } else {
        pushEvent({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, goal, startUrl, model, maxSteps, maxCostUsd, headless, pushEvent]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const hasKey = !!creds?.anthropic_api_key;
  const lastMetrics = [...events].reverse().find((e) => e.kind === 'metrics') as Extract<EventEntry, { kind: 'metrics' }> | undefined;
  const lastDone = [...events].reverse().find((e) => e.kind === 'done') as Extract<EventEntry, { kind: 'done' }> | undefined;
  const lastError = [...events].reverse().find((e) => e.kind === 'error') as Extract<EventEntry, { kind: 'error' }> | undefined;

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">AI Explore</h1>
          <p className="pc-test-tab-intro">
            Stagehand drives Playwright (Chromium) against the dev webapp with an LLM picking each
            action. Slower than Chaos but finds workflow breakage that random clicks miss. Hard cost
            cap aborts the run if the spend threshold is hit.
          </p>
        </div>
      </header>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Anthropic API key</h2>
        {credsLoading ? (
          <p style={{ color: 'var(--fg-mute)', margin: 0 }}>Loading…</p>
        ) : hasKey && !showInput ? (
          <div className="pc-test-card-row">
            <span className="pc-test-badge is-good">configured</span>
            <code style={{ fontSize: 12, color: 'var(--fg-mute)' }}>{creds!.anthropic_api_key}</code>
            <Button variant="ghost" onClick={() => setShowInput(true)}>Replace</Button>
            <a href="/settings/api-keys" style={{ fontSize: 12, color: 'var(--accent)' }}>Manage in Settings →</a>
          </div>
        ) : (
          <>
            {!hasKey && (
              <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 0 }}>
                Not configured. Paste an Anthropic API key — stored at{' '}
                <code>{creds?.path ?? '~/.papercusp/credentials.json'}</code> mode 600.
              </p>
            )}
            <div className="pc-test-card-row">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-…"
                style={{ flex: 1, minWidth: 320, fontFamily: 'ui-monospace, monospace' }}
                disabled={saving}
              />
              <Button variant="primary" onClick={saveKey} disabled={saving || !keyInput.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {showInput && (
                <Button variant="ghost" onClick={() => { setShowInput(false); setKeyInput(''); }}>Cancel</Button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="pc-test-card">
        <h2 className="pc-test-card-title">Run</h2>
        <div className="pc-test-card-row" style={{ alignItems: 'flex-start' }}>
          <label style={{ flex: 1 }}>
            Goal{' '}
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: 12 }}
              placeholder="e.g. Open a harness, switch to Issues tab, click into the first issue."
              disabled={running}
            />
          </label>
        </div>
        <div className="pc-test-card-row">
          <label>
            Start URL{' '}
            <input type="text" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} style={{ width: 280 }} disabled={running} />
          </label>
          <label>
            Model{' '}
            <Select value={model} onChange={setModel} options={MODELS} ariaLabel="Model" disabled={running} />
          </label>
          <label>
            Max steps{' '}
            <input type="number" value={maxSteps} min={1} max={50} onChange={(e) => setMaxSteps(Number(e.target.value))} style={{ width: 80 }} disabled={running} />
          </label>
          <label>
            Cost cap (USD){' '}
            <input type="number" value={maxCostUsd} min={0.05} max={20} step={0.05} onChange={(e) => setMaxCostUsd(Number(e.target.value))} style={{ width: 80 }} disabled={running} />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Checkbox checked={headless} onChange={setHeadless} disabled={running} /> Headless
          </label>
        </div>
        <div className="pc-test-card-row">
          {!running ? (
            <Button variant="primary" onClick={launch} disabled={!hasKey || !goal.trim()}>
              Run
            </Button>
          ) : (
            <Button variant="destructive" onClick={stop}>Stop</Button>
          )}
          {!hasKey && <span style={{ color: 'var(--fg-mute)' }}>Set an API key above first.</span>}
          {running && <span style={{ color: 'var(--fg-mute)' }}>Running…</span>}
        </div>
      </div>

      {(events.length > 0 || running) && (
        <div className="pc-test-card">
          <h2 className="pc-test-card-title">
            Live log
            {lastMetrics && (
              <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 12, color: 'var(--fg-mute)' }}>
                ${lastMetrics.costUsd.toFixed(4)} · {lastMetrics.totalTokens.toLocaleString()} tokens
              </span>
            )}
            {lastDone && (
              <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: 'var(--fg-mute)' }}>
                · {Math.round(lastDone.totalMs / 1000)}s · {lastDone.steps} steps
              </span>
            )}
          </h2>
          {lastError && (
            <div style={{ padding: 8, marginBottom: 8, background: 'color-mix(in srgb, var(--bad) 14%, transparent)', border: '1px solid var(--bad)', borderRadius: 4, fontSize: 12 }}>
              <strong>error:</strong> {lastError.message}
            </div>
          )}
          <div style={{ maxHeight: 420, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 11, lineHeight: 1.5, background: 'var(--bg-3)', borderRadius: 4, padding: 8 }}>
            {events.map((e) => {
              const ts = new Date(e.ts).toLocaleTimeString();
              if (e.kind === 'start') return <div key={e.id}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className="pc-test-badge is-good">start</span> goal: {e.goal}</div>;
              if (e.kind === 'step') return <div key={e.id}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className={`pc-test-badge ${e.ok ? 'is-good' : 'is-poor'}`}>step {e.n}</span> {e.action} ({e.durationMs}ms){e.result ? ` — ${e.result}` : ''}</div>;
              if (e.kind === 'metrics') return <div key={e.id}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className="pc-test-badge is-muted">metrics</span> ${e.costUsd.toFixed(4)} · in {e.inputTokens.toLocaleString()} · out {e.outputTokens.toLocaleString()}</div>;
              if (e.kind === 'done') return <div key={e.id}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className={`pc-test-badge ${(e.exitCode ?? 0) === 0 ? 'is-good' : 'is-poor'}`}>done</span> {Math.round(e.totalMs/1000)}s · {e.steps} steps · ${e.costUsd.toFixed(4)}{typeof e.exitCode === 'number' ? ` · exit ${e.exitCode}` : ''}</div>;
              if (e.kind === 'error') return <div key={e.id} style={{ color: 'var(--bad)' }}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className="pc-test-badge is-poor">error</span> {e.message}</div>;
              // log
              const levelCls = e.level === 'error' ? 'is-poor' : e.level === 'warn' ? 'is-needs' : 'is-muted';
              return <div key={e.id}><span style={{ color: 'var(--fg-mute)' }}>{ts}</span> <span className={`pc-test-badge ${levelCls}`}>{e.level}</span> {e.line}</div>;
            })}
          </div>
        </div>
      )}
    </>
  );
}
