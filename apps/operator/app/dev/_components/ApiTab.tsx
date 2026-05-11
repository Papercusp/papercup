'use client';

/**
 * API tab — auto-generated from /api/plugins/tools. Every tool the
 * runtime registry knows about shows up here. Click a tool → form built
 * from its JSON Schema → POST to the projection endpoint → response.
 *
 * Spawn context (workspace, harness, role, run, spawn, feature) lives at
 * the top of the page and is appended to every invocation URL as query
 * params. That's what the dispatcher reads to scope the call (per docs/
 * endpoint-system/transports#the-seven-url-params).
 */

import { useEffect, useMemo, useState } from 'react';
import SchemaForm from './SchemaForm';

interface Tool {
  name: string;
  pluginName: string;
  description: string;
  capabilities: string[];
  roles?: string[];
  expose: {
    http?: { path: string; methods?: string[] };
    mcp?: { name: string };
  };
  inputSchema: Record<string, unknown>;
  recentInvocations?: number;
  recentErrors?: number;
}

import type { RerunContext } from '../page';

interface Props {
  workspaceIds: string[] | null;
  rerun: RerunContext | null;
  onRerunConsumed: () => void;
}

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

function namespaceOf(name: string): string {
  if (name.includes(':')) return name.split(':')[0];
  if (name.includes('.')) return name.split('.')[0];
  return 'misc';
}

export default function ApiTab({ workspaceIds, rerun, onRerunConsumed }: Props) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Tool | null>(null);
  const [filter, setFilter] = useState('');
  const [showBuiltins, setShowBuiltins] = useState(true);
  const [showPlugins, setShowPlugins] = useState(true);

  // Spawn-context (shared across every invocation on this page)
  const [ctxWorkspace, setCtxWorkspace] = useState(
    workspaceIds && workspaceIds.length === 1 ? workspaceIds[0] : 'default',
  );
  const [ctxHarness, setCtxHarness] = useState('');
  const [ctxRole, setCtxRole] = useState<(typeof ALL_ROLES)[number]>('architect');
  const [ctxRun, setCtxRun] = useState('dev-page');
  const [ctxSpawn, setCtxSpawn] = useState('dev-page');

  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<unknown | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/plugins/tools')
      .then((r) => (r.ok ? r.json() : { tools: [] }))
      .then((d) => {
        setTools(d.tools ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Consume incoming rerun context once tools have loaded.
  useEffect(() => {
    if (!rerun || tools.length === 0) return;
    const t = tools.find((x) => x.name === rerun.toolName);
    if (t) {
      setSelected(t);
      if (rerun.workspace) setCtxWorkspace(rerun.workspace);
      if (rerun.harness !== undefined) setCtxHarness(rerun.harness);
      if (rerun.role) setCtxRole(rerun.role as never);
      if (rerun.run) setCtxRun(rerun.run);
      if (rerun.spawn) setCtxSpawn(rerun.spawn);
      if (rerun.args) setArgs(rerun.args);
    }
    onRerunConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerun, tools.length]);

  // Reset args when tool changes
  useEffect(() => {
    setArgs({});
    setResponse(null);
    setResponseError(null);
    setDurationMs(null);
  }, [selected?.name]);

  const grouped = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = tools.filter((t) => {
      const isBuiltin = t.pluginName === 'agent-mcp';
      if (isBuiltin && !showBuiltins) return false;
      if (!isBuiltin && !showPlugins) return false;
      if (!f) return true;
      return (
        t.name.toLowerCase().includes(f) ||
        t.description.toLowerCase().includes(f) ||
        t.pluginName.toLowerCase().includes(f)
      );
    });
    const map = new Map<string, Tool[]>();
    for (const t of filtered) {
      const ns = namespaceOf(t.name);
      if (!map.has(ns)) map.set(ns, []);
      map.get(ns)!.push(t);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools, filter, showBuiltins, showPlugins]);

  async function invoke() {
    if (!selected) return;
    const path = selected.expose.http?.path;
    if (!path) {
      setResponseError('tool has no HTTP projection');
      return;
    }
    setBusy(true);
    setResponse(null);
    setResponseError(null);
    const params = new URLSearchParams({
      workspace: ctxWorkspace,
      role: ctxRole,
      run: ctxRun,
      spawn: ctxSpawn,
    });
    if (ctxHarness) params.set('harness', ctxHarness);
    const url = `${path}?${params.toString()}`;
    const started = performance.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const elapsed = performance.now() - started;
      setDurationMs(Math.round(elapsed));
      const text = await r.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      if (!r.ok) setResponseError(`HTTP ${r.status}`);
      setResponse(parsed);
    } catch (err) {
      setResponseError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pc-dev-api">
      <div className="pc-dev-api-sidebar">
        <div className="pc-dev-api-filters">
          <input
            type="search"
            placeholder="Filter tools…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pc-dev-input"
          />
          <div className="pc-dev-toggles">
            <label className="pc-dev-toggle">
              <input
                type="checkbox"
                checked={showBuiltins}
                onChange={(e) => setShowBuiltins(e.target.checked)}
              />
              <span>Built-ins</span>
            </label>
            <label className="pc-dev-toggle">
              <input
                type="checkbox"
                checked={showPlugins}
                onChange={(e) => setShowPlugins(e.target.checked)}
              />
              <span>Plugins</span>
            </label>
          </div>
        </div>
        {loading && <div className="pc-dev-muted">loading registry…</div>}
        {!loading &&
          grouped.map(([ns, list]) => (
            <div key={ns} className="pc-dev-api-group">
              <div className="pc-dev-api-group-label">
                {ns} <span className="pc-dev-muted">{list.length}</span>
              </div>
              {list.map((t) => (
                <button
                  key={`${t.pluginName}::${t.name}`}
                  type="button"
                  className={`pc-dev-api-tool ${selected?.name === t.name ? 'is-active' : ''}`}
                  onClick={() => setSelected(t)}
                  title={t.description}
                >
                  <span className="pc-dev-api-tool-name">{t.name}</span>
                  {(t.recentInvocations ?? 0) + (t.recentErrors ?? 0) > 0 && (
                    <span className="pc-dev-api-tool-stats">
                      {t.recentInvocations ?? 0}
                      {(t.recentErrors ?? 0) > 0 && (
                        <span className="pc-dev-api-err">·{t.recentErrors}</span>
                      )}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
      </div>

      <div className="pc-dev-api-detail">
        {!selected && (
          <div className="pc-dev-api-hint">
            Select a tool from the sidebar to invoke it. Forms are built from each
            tool's JSON Schema. Spawn context below is shared across every call.
          </div>
        )}
        {selected && (
          <>
            <header className="pc-dev-api-header">
              <h2 className="pc-dev-api-title">{selected.name}</h2>
              <div className="pc-dev-api-meta">
                <span>{selected.pluginName}</span>
                <span>·</span>
                <span>{selected.expose.http?.path ?? '—'}</span>
                {selected.capabilities.length > 0 && (
                  <>
                    <span>·</span>
                    <span>{selected.capabilities.join(', ')}</span>
                  </>
                )}
              </div>
              {selected.description && (
                <p className="pc-dev-api-desc">{selected.description}</p>
              )}
            </header>

            <fieldset className="pc-dev-api-ctx">
              <legend>Spawn context</legend>
              <div className="pc-dev-ctx-grid">
                <label>
                  workspace
                  <input
                    value={ctxWorkspace}
                    onChange={(e) => setCtxWorkspace(e.target.value)}
                    className="pc-dev-input"
                  />
                </label>
                <label>
                  harness
                  <input
                    value={ctxHarness}
                    onChange={(e) => setCtxHarness(e.target.value)}
                    placeholder="(optional)"
                    className="pc-dev-input"
                  />
                </label>
                <label>
                  role
                  <select
                    value={ctxRole}
                    onChange={(e) => setCtxRole(e.target.value as never)}
                    className="pc-dev-input"
                  >
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  run
                  <input
                    value={ctxRun}
                    onChange={(e) => setCtxRun(e.target.value)}
                    className="pc-dev-input"
                  />
                </label>
                <label>
                  spawn
                  <input
                    value={ctxSpawn}
                    onChange={(e) => setCtxSpawn(e.target.value)}
                    className="pc-dev-input"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="pc-dev-api-args">
              <legend>Arguments</legend>
              <SchemaForm
                schema={selected.inputSchema}
                value={args}
                onChange={setArgs}
              />
            </fieldset>

            <div className="pc-dev-api-actions">
              <button
                type="button"
                onClick={invoke}
                disabled={busy}
                className="pc-dev-btn-primary"
              >
                {busy ? 'invoking…' : 'Invoke'}
              </button>
              {durationMs !== null && (
                <span className="pc-dev-muted">{durationMs}ms</span>
              )}
              {responseError && <span className="pc-dev-api-err">{responseError}</span>}
            </div>

            {response !== null && (
              <pre className="pc-dev-api-response">
                {typeof response === 'string' ? response : JSON.stringify(response, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
