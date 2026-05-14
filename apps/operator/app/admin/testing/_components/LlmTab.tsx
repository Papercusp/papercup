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

function FindingsView() {
  return (
    <div className="pc-test-card">
      <p style={{ padding: 16, color: 'var(--mut)' }}>
        Cross-run unacknowledged findings view — implemented in Phase 1 follow-up. Until then, drill into a specific run from the Runs tab.
      </p>
    </div>
  );
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
