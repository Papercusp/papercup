'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';

import { Button } from '../../../harness/Button';

type Subtab = 'scenarios' | 'runs' | 'findings';
type RunRow = {
  id: string;
  scenario_id: string;
  scenario_target: string;
  status: string;
  sut_model: string;
  judge_model: string;
  persona_id: string;
  started_at: string;
  finished_at: string | null;
  cost_usd: string | number;
  scores_json: Record<string, number> | null;
  findings_count: Record<string, number>;
  cap_breaches: string[];
  matrix_group_id: string | null;
  matrix_index: number | null;
};
type ScenarioRow = {
  id: string;
  version: number;
  target: string;
  description: string;
  persona: string;
  runMatrix: { repeat: number; variancePolicy?: string } | null;
  realWorkspace: boolean;
  transport: string;
  rubricVersion: string;
  assertCount: number;
  caps: { maxTurns: number; maxWallSecs: number; maxCostUsd: number };
};
type FindingRow = {
  id: string;
  run_id: string;
  source: 'assert' | 'judge' | 'variance';
  severity: 'error' | 'warn' | 'info';
  axis: string | null;
  assert_kind: string | null;
  evidence_turn_idx: number | null;
  claim: string;
  suggestion: string | null;
  copy_prompt: string | null;
  acknowledged: boolean;
};

export default function LlmTab() {
  const [subtab, setSubtab] = useQueryState(
    'subtab',
    parseAsStringEnum<Subtab>(['scenarios', 'runs', 'findings']).withDefault('runs'),
  );

  return (
    <>
      <header className="pc-test-tab-header">
        <div>
          <h1 className="pc-test-tab-title">LLM testing</h1>
          <p className="pc-test-tab-intro">
            Scenario-driven, judge-scored tests for any LLM chat surface. Operator first; other targets next. Backend only — no UI driving.
            Plan: <code>apps/operator/docs/plans/llm-testing-framework-2026-05-14.md</code>
          </p>
        </div>
      </header>

      <AnthropicKeyStrip />

      <nav className="pc-test-subnav" aria-label="LLM testing subtabs">
        <Button variant={subtab === 'runs' ? 'primary' : 'ghost'} onClick={() => setSubtab('runs')}>Runs</Button>
        <Button variant={subtab === 'scenarios' ? 'primary' : 'ghost'} onClick={() => setSubtab('scenarios')}>Scenarios</Button>
        <Button variant={subtab === 'findings' ? 'primary' : 'ghost'} onClick={() => setSubtab('findings')}>Findings</Button>
      </nav>

      <div style={{ marginTop: 16 }}>
        {subtab === 'runs' && <RunsView />}
        {subtab === 'scenarios' && <ScenariosView />}
        {subtab === 'findings' && <FindingsView />}
      </div>
    </>
  );
}

function AnthropicKeyStrip() {
  const [masked, setMasked] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch('/api/credentials')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { setMasked(j.anthropic_api_key ?? null); setUpdatedAt(j.updated_at ?? null); })
      .catch((e) => setError((e as Error).message));
  };

  useEffect(load, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: draft }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setMasked(j.anthropic_api_key ?? null);
      setUpdatedAt(j.updated_at ?? null);
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!confirm('Clear stored Anthropic API key?')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anthropic_api_key: '' }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setMasked(j.anthropic_api_key ?? null);
      setUpdatedAt(j.updated_at ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-test-card" style={{ padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, minWidth: 140 }}>Anthropic API key</div>
        <div style={{ color: 'var(--fg-mute, #888)', fontSize: 12, minWidth: 220 }}>
          {masked ? <>stored: <code>{masked}</code>{updatedAt ? ` · ${new Date(updatedAt).toLocaleString()}` : ''}</> : <em>not set — sim-user + judge will fail</em>}
        </div>
        <input
          className="pc-test-input"
          type="password"
          placeholder="sk-ant-…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ flex: 1, minWidth: 280 }}
          autoComplete="off"
        />
        <Button variant="primary" onClick={save} disabled={busy || !draft.trim()}>
          {masked ? 'Replace' : 'Save'}
        </Button>
        {masked ? <Button variant="ghost" onClick={clear} disabled={busy}>Clear</Button> : null}
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-mute, #888)' }}>
        Persisted in <code>harness_shared.operator_credentials</code>. Env <code>ANTHROPIC_API_KEY</code> takes precedence when set.
      </div>
      {error ? <div style={{ marginTop: 6, color: 'var(--bad, #c33)', fontSize: 12 }}>Error: {error}</div> : null}
    </div>
  );
}

function ScenariosView() {
  const [data, setData] = useState<ScenarioRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/admin/llm-tests/scenarios')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j.scenarios as ScenarioRow[]))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.length === 0) return <Empty msg="No scenarios registered." />;

  return (
    <div className="pc-test-card">
      <table className="pc-test-table">
        <thead>
          <tr>
            <th>id</th>
            <th>target</th>
            <th>persona</th>
            <th>matrix</th>
            <th>transport</th>
            <th>asserts</th>
            <th>caps</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {data.map((s) => (
            <tr key={s.id}>
              <td><code>{s.id}</code> v{s.version}</td>
              <td>{s.target}</td>
              <td>{s.persona}</td>
              <td>{s.runMatrix ? `${s.runMatrix.repeat}×` : '1×'}</td>
              <td>{s.transport}</td>
              <td>{s.assertCount}</td>
              <td>{s.caps.maxTurns}t / {s.caps.maxWallSecs}s / ${s.caps.maxCostUsd}</td>
              <td style={{ maxWidth: 400 }}>{s.description.slice(0, 120)}{s.description.length > 120 ? '…' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunsView() {
  const [targetFilter, setTargetFilter] = useQueryState('target', parseAsString.withDefault(''));
  const [statusFilter, setStatusFilter] = useQueryState('status', parseAsString.withDefault(''));
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const url = new URL('/api/admin/llm-tests/runs', window.location.origin);
    if (targetFilter) url.searchParams.set('target', targetFilter);
    if (statusFilter) url.searchParams.set('status', statusFilter);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setRuns(j.runs as RunRow[]))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [targetFilter, statusFilter]);

  if (error) return <ErrorBox error={error} />;
  if (!runs) return <Loading />;

  return (
    <>
      <div className="pc-test-card-row" style={{ marginBottom: 12 }}>
        <input
          className="pc-test-input"
          placeholder="filter target (e.g. operator)"
          value={targetFilter}
          onChange={(e) => setTargetFilter(e.target.value || null)}
        />
        <select
          className="pc-test-input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value || null)}
        >
          <option value="">any status</option>
          <option value="passed">passed</option>
          <option value="failed">failed</option>
          <option value="errored">errored</option>
          <option value="preview">preview</option>
        </select>
      </div>

      {runs.length === 0 ? (
        <Empty msg="No runs yet. Use `pnpm llm-test --scenario op-S01-status-quick` to record one." />
      ) : (
        <div className="pc-test-card">
          <table className="pc-test-table">
            <thead>
              <tr>
                <th>started</th>
                <th>scenario</th>
                <th>persona</th>
                <th>SUT / judge</th>
                <th>status</th>
                <th>scores</th>
                <th>cost</th>
                <th>findings</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td title={r.started_at}>{new Date(r.started_at).toLocaleString()}</td>
                  <td><code>{r.scenario_id}</code></td>
                  <td>{r.persona_id}</td>
                  <td>{r.sut_model.replace('claude-', '')} / {r.judge_model.replace('claude-', '')}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.matrix_group_id ? <span className="pc-test-badge is-muted">#{(r.matrix_index ?? 0) + 1}</span> : null}
                  </td>
                  <td>{formatScores(r.scores_json)}</td>
                  <td>${Number(r.cost_usd).toFixed(4)}</td>
                  <td>{formatFindings(r.findings_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type FindingsResponse = { findings: FindingRow[]; shapeCounts: Record<string, number> };

type FindingFilterSeverity = '' | 'error' | 'warn' | 'info';
type FindingFilterSource = '' | 'assert' | 'judge' | 'variance';

function FindingsView() {
  const [severity, setSeverity] = useQueryState(
    'sev',
    parseAsStringEnum<FindingFilterSeverity>(['', 'error', 'warn', 'info']).withDefault(''),
  );
  const [source, setSource] = useQueryState(
    'src',
    parseAsStringEnum<FindingFilterSource>(['', 'assert', 'judge', 'variance']).withDefault(''),
  );
  const [showAck, setShowAck] = useQueryState(
    'ack',
    parseAsStringEnum<'open' | 'done'>(['open', 'done']).withDefault('open'),
  );
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    const url = new URL('/api/admin/llm-tests/findings', window.location.origin);
    if (severity) url.searchParams.set('severity', severity);
    if (source) url.searchParams.set('source', source);
    url.searchParams.set('acknowledged', showAck === 'done' ? 'true' : 'false');
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => live && setData(j as FindingsResponse))
      .catch((e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [severity, source, showAck, reloadKey]);

  const onToggleAck = async (id: string, acknowledged: boolean) => {
    try {
      await fetch(`/api/admin/llm-tests/findings/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledged }),
      });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  return (
    <>
      <div className="pc-test-card-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Button variant={showAck === 'open' ? 'primary' : 'ghost'} onClick={() => setShowAck('open')}>Open</Button>
        <Button variant={showAck === 'done' ? 'primary' : 'ghost'} onClick={() => setShowAck('done')}>Acknowledged</Button>
        <select className="pc-test-input" value={severity} onChange={(e) => setSeverity((e.target.value || null) as FindingFilterSeverity | null)}>
          <option value="">any severity</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
        </select>
        <select className="pc-test-input" value={source} onChange={(e) => setSource((e.target.value || null) as FindingFilterSource | null)}>
          <option value="">any source</option>
          <option value="assert">deterministic assert</option>
          <option value="judge">judge</option>
          <option value="variance">variance</option>
        </select>
      </div>

      {data.findings.length === 0 ? (
        <Empty msg={showAck === 'open' ? 'No outstanding findings. Drill into a run from the Runs tab to see assertions inline.' : 'No acknowledged findings yet.'} />
      ) : (
        <div className="pc-test-card">
          <table className="pc-test-table">
            <thead>
              <tr>
                <th>severity</th>
                <th>scenario · started</th>
                <th>source · axis</th>
                <th>claim</th>
                <th>promotion</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.findings.map((f) => {
                const shape = f.shape ?? '';
                const scenarioCount = shape ? data.shapeCounts[shape] ?? 0 : 0;
                return (
                  <tr key={f.id}>
                    <td><SeverityBadge severity={f.severity} /></td>
                    <td>
                      <code>{f.scenario_id ?? f.run_id}</code>
                      <br />
                      <span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>
                        {f.started_at ? new Date(f.started_at as unknown as string).toLocaleString() : ''}
                      </span>
                    </td>
                    <td>
                      <span className="pc-test-badge is-muted">{f.source}</span>
                      {f.axis ? <> · {f.axis}</> : f.assert_kind ? <> · <code>{f.assert_kind}</code></> : null}
                    </td>
                    <td style={{ maxWidth: 480 }}>
                      <div>{f.claim}</div>
                      {f.suggestion ? (
                        <div style={{ color: 'var(--fg-mute)', fontSize: 12, marginTop: 4 }}>
                          → {f.suggestion}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {f.promoted_to_assert_id ? (
                        <span className="pc-test-badge is-good" title={f.promoted_to_assert_id}>promoted</span>
                      ) : scenarioCount >= 3 ? (
                        <span className="pc-test-badge is-needs" title={`shape seen in ${scenarioCount} scenarios`}>
                          candidate · {scenarioCount}×
                        </span>
                      ) : scenarioCount >= 2 ? (
                        <span className="pc-test-badge is-muted" title={`shape seen in ${scenarioCount} scenarios`}>
                          recurring · {scenarioCount}×
                        </span>
                      ) : null}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {f.copy_prompt ? (
                        <Button variant="ghost" onClick={() => copy(f.copy_prompt!)} title="Copy as agent prompt">
                          copy prompt
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        onClick={() => onToggleAck(f.id, showAck !== 'done')}
                      >
                        {showAck === 'done' ? 'reopen' : 'ack'}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls = severity === 'error' ? 'is-bad' : severity === 'warn' ? 'is-needs' : 'is-muted';
  return <span className={`pc-test-badge ${cls}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'passed' ? 'is-good'
      : status === 'failed' ? 'is-bad'
        : status === 'errored' ? 'is-bad'
          : 'is-muted';
  return <span className={`pc-test-badge ${cls}`}>{status}</span>;
}

function formatScores(scores: Record<string, number> | null): React.ReactNode {
  if (!scores) return '—';
  const entries = Object.entries(scores);
  if (entries.length === 0) return '—';
  const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
  return <span title={JSON.stringify(scores)}>{avg.toFixed(1)} avg ({entries.length} axes)</span>;
}

function formatFindings(c: Record<string, number>): string {
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} err`);
  if (c.warn) parts.push(`${c.warn} warn`);
  if (c.info) parts.push(`${c.info} info`);
  return parts.length === 0 ? '—' : parts.join(' / ');
}

function Loading() {
  return <div className="pc-test-loading">loading…</div>;
}

function Empty({ msg }: { msg: string }) {
  return <div className="pc-test-card" style={{ padding: 16, color: 'var(--mut)' }}>{msg}</div>;
}

function ErrorBox({ error }: { error: string }) {
  return <div className="pc-test-card is-bad" style={{ padding: 16 }}>Error: {error}</div>;
}
