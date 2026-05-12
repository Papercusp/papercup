'use client';

import { useCallback, useState } from 'react';
import dynamic from 'next/dynamic';
import { useQueryState, parseAsStringEnum } from 'nuqs';

/**
 * /dev SQL tab — Monaco-backed read-only SQL playground.
 *
 * Posts the editor buffer to /api/dev/sql which gates on a SELECT/WITH/
 * EXPLAIN/SHOW/TABLE/VALUES allowlist, runs the query inside a
 * transaction with statement_timeout, and rolls back on completion so
 * even read-side-effects (FOR UPDATE etc.) don't escape.
 *
 * Role toggle (admin/app) mirrors the Tables tab — admin bypasses RLS,
 * app honors the active workspace's policies.
 */

const Monaco = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface QueryResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  durationMs?: number;
  role?: string;
  statements?: number;
  error?: string;
  sqlState?: string;
}

const DEFAULT_SQL = `-- Read-only SQL playground.
-- Only SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES accepted.
-- Statements run inside a transaction that always rolls back.

SELECT slug, status, updated_ts
  FROM harness_shared.projects
 ORDER BY updated_ts DESC
 LIMIT 10;
`;

export default function SqlTab() {
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [role, setRole] = useQueryState(
    'sqlRole',
    parseAsStringEnum<'admin' | 'app'>(['admin', 'app']).withDefault('admin'),
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/dev/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, role }),
      });
      const d = (await r.json()) as QueryResult;
      setResult(d);
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [sql, role]);

  return (
    <div className="pc-sql-shell">
      <div className="pc-sql-toolbar">
        <div className="pc-sql-title">
          <strong>SQL</strong>
          <span>read-only · rollback transaction</span>
        </div>
        <button
          type="button"
          className="pc-sql-run pc-dev-btn-primary"
          onClick={run}
          disabled={busy}
          title="Cmd/Ctrl+Enter"
        >
          {busy ? 'Running…' : '▶ Run'}
        </button>
        <label className="pc-sql-role">
          Role:
          <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'app')}>
            <option value="admin">admin (RLS bypass)</option>
            <option value="app">app (workspace-scoped)</option>
          </select>
        </label>
        {result && !result.error && (
          <span className="pc-sql-stats">
            {result.rowCount?.toLocaleString()} rows · {result.durationMs}ms
            {result.truncated && ' · truncated to 1000'}
          </span>
        )}
        {result?.error && (
          <span className="pc-sql-err-summary">
            {result.sqlState ? `[${result.sqlState}] ` : ''}error
          </span>
        )}
        <span className="pc-sql-hint">⌘+Enter / Ctrl+Enter to run</span>
      </div>

      <div className="pc-sql-editor">
        <Monaco
          height="100%"
          defaultLanguage="sql"
          theme="vs-dark"
          value={sql}
          onChange={(v) => setSql(v ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            lineNumbers: 'on',
            renderWhitespace: 'selection',
          }}
          onMount={(editor, monaco) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
              void run();
            });
          }}
        />
      </div>

      <div className="pc-sql-results">
        {!result && <div className="pc-sql-empty">Run a query to see results.</div>}
        {result?.error && (
          <pre className="pc-sql-err">{result.error}</pre>
        )}
        {result && !result.error && result.rows && (
          <>
            {result.rows.length === 0 ? (
              <div className="pc-sql-empty">No rows returned.</div>
            ) : (
              <div className="pc-sql-grid-scroll">
                <table className="pc-sql-grid">
                  <thead>
                    <tr>
                      {(result.columns ?? []).map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        {(result.columns ?? []).map((c) => (
                          <td key={c}>{renderCell(r[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 197) + '…' : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
  } catch {
    return String(v);
  }
}
