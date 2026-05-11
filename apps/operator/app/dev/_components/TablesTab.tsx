'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * /dev Tables tab — schema-aware table inspector.
 *
 * Lists every drizzle-introspected table (`generated.*`), shows column
 * shape with PG type + nullability + defaults + PK + FKs + indexes, and
 * a paginated row grid. Powered entirely by runtime introspection, no
 * codegen.
 *
 * Sibling of the embedded Drizzle Studio tab; this one knows our app
 * conventions (workspace scoping, RLS bypass via role toggle), Studio
 * doesn't.
 */

interface TableEntry {
  exportName: string;
  schema: string | undefined;
  name: string;
  columnCount: number;
  primaryKey: string[];
}

interface ColumnSummary {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  isUnique: boolean;
  generated: boolean;
}

interface TableDetail {
  exportName: string;
  schema: string;
  name: string;
  qualifiedName: string;
  columns: ColumnSummary[];
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[] }>;
  foreignKeys: Array<{ columns: string[]; foreignColumns: string[]; foreignTable: string }>;
}

interface RowsPayload {
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  role: 'admin' | 'app';
  qualifiedName: string;
  error?: string;
}

const PAGE_SIZE = 50;

export default function TablesTab() {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [rows, setRows] = useState<RowsPayload | null>(null);
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState<'admin' | 'app'>('admin');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch('/api/dev/tables')
      .then((r) => r.json())
      .then((d: { tables: TableEntry[] }) => setTables(d.tables));
  }, []);

  const fetchDetail = useCallback(async (exportName: string) => {
    setLoading(true);
    try {
      const d = await fetch(`/api/dev/tables/${encodeURIComponent(exportName)}`).then((r) => r.json());
      setDetail(d);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRows = useCallback(async (exportName: string, ofs: number, r: 'admin' | 'app') => {
    setLoading(true);
    try {
      const d = await fetch(
        `/api/dev/tables/${encodeURIComponent(exportName)}/rows?limit=${PAGE_SIZE}&offset=${ofs}&role=${r}`,
      ).then((res) => res.json());
      setRows(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setRows(null);
      return;
    }
    setOffset(0);
    void fetchDetail(selected);
    void fetchRows(selected, 0, role);
  }, [selected, role, fetchDetail, fetchRows]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return tables;
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(f) ||
        (t.schema ?? '').toLowerCase().includes(f) ||
        t.exportName.toLowerCase().includes(f),
    );
  }, [tables, filter]);

  const grouped = useMemo(() => {
    const g = new Map<string, TableEntry[]>();
    for (const t of filtered) {
      const key = t.schema ?? '(no schema)';
      if (!g.has(key)) g.set(key, []);
      g.get(key)!.push(t);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const orderedColumns = useMemo(() => {
    if (!detail || !rows || rows.rows.length === 0) return detail?.columns ?? [];
    const keys = Object.keys(rows.rows[0]);
    const order = new Map(keys.map((k, i) => [k, i] as const));
    return [...detail.columns].sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99));
  }, [detail, rows]);

  return (
    <div className="pc-tables-shell">
      <aside className="pc-tables-sidebar">
        <div className="pc-tables-search">
          <input
            type="text"
            placeholder={`Filter ${tables.length} tables…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="pc-tables-list">
          {grouped.map(([schema, ts]) => (
            <div key={schema} className="pc-tables-group">
              <div className="pc-tables-group-label">
                {schema} <span>({ts.length})</span>
              </div>
              {ts.map((t) => (
                <button
                  key={t.exportName}
                  type="button"
                  className={`pc-tables-row ${selected === t.exportName ? 'is-active' : ''}`}
                  onClick={() => setSelected(t.exportName)}
                  title={t.exportName}
                >
                  <span className="pc-tables-row-name">{t.name}</span>
                  <span className="pc-tables-row-count">{t.columnCount}c</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <main className="pc-tables-main">
        {!selected && (
          <div className="pc-tables-empty">
            <p>Pick a table from the sidebar.</p>
            <p className="pc-tables-empty-hint">
              {tables.length} tables across{' '}
              {new Set(tables.map((t) => t.schema ?? '')).size} schemas. All shapes are
              derived from <code>generated.ts</code> at runtime — no codegen, no drift.
            </p>
          </div>
        )}

        {selected && detail && (
          <>
            <div className="pc-tables-header">
              <div>
                <h2>
                  <span className="pc-tables-schema">{detail.schema}.</span>
                  {detail.name}
                </h2>
                <code className="pc-tables-export">{detail.exportName}</code>
              </div>
              <div className="pc-tables-controls">
                <label className="pc-tables-role">
                  Role:
                  <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'app')}>
                    <option value="admin">admin (RLS bypass)</option>
                    <option value="app">app (workspace-scoped)</option>
                  </select>
                </label>
                {rows && rows.total !== null && (
                  <span className="pc-tables-count">{rows.total.toLocaleString()} rows</span>
                )}
              </div>
            </div>

            <section className="pc-tables-columns">
              <h3>Columns</h3>
              <table className="pc-tables-coltable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Null?</th>
                    <th>PK</th>
                    <th>Default</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedColumns.map((c) => (
                    <tr key={c.name} className={c.primary ? 'is-pk' : ''}>
                      <td className="pc-tables-colname">{c.name}</td>
                      <td>
                        <code>{c.dataType}</code>
                        <span className="pc-tables-coltype-mute"> · {c.columnType.replace(/^Pg/, '')}</span>
                      </td>
                      <td>{c.notNull ? '' : 'null'}</td>
                      <td>{c.primary ? 'PK' : ''}</td>
                      <td className="pc-tables-coldefault">
                        {c.hasDefault ? (c.default !== null && c.default !== undefined ? String(c.default) : '<sql>') : ''}
                      </td>
                      <td>
                        {c.isUnique && <span className="pc-tables-flag">unique</span>}
                        {c.generated && <span className="pc-tables-flag">generated</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {detail.primaryKey.length > 1 && (
                <p className="pc-tables-pkrow">
                  Composite PK: <code>{detail.primaryKey.join(', ')}</code>
                </p>
              )}
              {detail.foreignKeys.length > 0 && (
                <details className="pc-tables-details">
                  <summary>{detail.foreignKeys.length} foreign keys</summary>
                  <ul>
                    {detail.foreignKeys.map((fk, i) => (
                      <li key={i}>
                        <code>{fk.columns.join(',')}</code> → <code>{fk.foreignTable}.{fk.foreignColumns.join(',')}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {detail.indexes.length > 0 && (
                <details className="pc-tables-details">
                  <summary>{detail.indexes.length} indexes</summary>
                  <ul>
                    {detail.indexes.map((i) => (
                      <li key={i.name}>
                        <code>{i.name}</code> on ({i.columns.join(', ')})
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            <section className="pc-tables-rows">
              <div className="pc-tables-rows-header">
                <h3>Rows</h3>
                {rows && (
                  <div className="pc-tables-paginate">
                    <button
                      disabled={offset === 0 || loading}
                      onClick={() => {
                        const o = Math.max(offset - PAGE_SIZE, 0);
                        setOffset(o);
                        void fetchRows(selected, o, role);
                      }}
                    >
                      ‹ Prev
                    </button>
                    <span>
                      {offset.toLocaleString()}–{(offset + rows.rows.length).toLocaleString()}
                    </span>
                    <button
                      disabled={loading || (rows.total !== null && offset + rows.rows.length >= rows.total)}
                      onClick={() => {
                        const o = offset + PAGE_SIZE;
                        setOffset(o);
                        void fetchRows(selected, o, role);
                      }}
                    >
                      Next ›
                    </button>
                  </div>
                )}
              </div>
              {rows?.error && <pre className="pc-tables-err">{rows.error}</pre>}
              {rows && rows.rows.length > 0 && (
                <div className="pc-tables-rowgrid-scroll">
                  <table className="pc-tables-rowgrid">
                    <thead>
                      <tr>
                        {Object.keys(rows.rows[0]).map((k) => (
                          <th key={k}>{k}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.rows.map((r, i) => (
                        <tr key={i}>
                          {Object.keys(rows.rows[0]).map((k) => (
                            <td key={k}>{renderCell(r[k])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rows && rows.rows.length === 0 && !rows.error && (
                <p className="pc-tables-empty-rows">No rows.</p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    return v.length > 200 ? v.slice(0, 197) + '…' : v;
  }
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
  } catch {
    return String(v);
  }
}
