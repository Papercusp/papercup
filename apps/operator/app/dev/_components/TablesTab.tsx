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
 * Filtering:
 *   - FK-walk: any cell in an FK source column is a clickable link that
 *     adds `{foreign_column: value}` to the active filter and switches
 *     to the referenced table.
 *   - WHERE composer: "+ Filter" button opens a column-picker + value
 *     input. Filters AND together; each is a removable chip. Clear-all
 *     restores pagination.
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

interface ForeignKey {
  columns: string[];
  foreignColumns: string[];
  foreignTable: string;
}

interface TableDetail {
  exportName: string;
  schema: string;
  name: string;
  qualifiedName: string;
  columns: ColumnSummary[];
  primaryKey: string[];
  indexes: Array<{ name: string; columns: string[] }>;
  foreignKeys: ForeignKey[];
}

interface RowsPayload {
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  role: 'admin' | 'app';
  qualifiedName: string;
  filtered?: boolean;
  error?: string;
}

const PAGE_SIZE = 50;

type Op = 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'like' | 'ilike' | 'isnull' | 'notnull';
const OPS: Array<{ op: Op; label: string; needsValue: boolean }> = [
  { op: 'eq', label: '=', needsValue: true },
  { op: 'ne', label: '≠', needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'gte', label: '≥', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'lte', label: '≤', needsValue: true },
  { op: 'like', label: 'LIKE', needsValue: true },
  { op: 'ilike', label: 'ILIKE', needsValue: true },
  { op: 'isnull', label: 'IS NULL', needsValue: false },
  { op: 'notnull', label: 'NOT NULL', needsValue: false },
];
const OP_LABEL = new Map(OPS.map((o) => [o.op, o.label]));
const VALUELESS_OPS = new Set<Op>(['isnull', 'notnull']);

interface Filter { col: string; op: Op; value: unknown }

export default function TablesTab() {
  const [tables, setTables] = useState<TableEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [rows, setRows] = useState<RowsPayload | null>(null);
  const [filter, setFilter] = useState('');
  const [role, setRole] = useState<'admin' | 'app'>('admin');
  const [offset, setOffset] = useState(0);
  /** Active filters — `[col, op, value]` triples. Empty = unfiltered. */
  const [filters, setFilters] = useState<Filter[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch('/api/dev/tables')
      .then((r) => r.json())
      .then((d: { tables: TableEntry[] }) => setTables(d.tables));
  }, []);

  /** qualified-name → exportName, for FK target lookup. */
  const qualifiedToExport = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tables) {
      const q = t.schema ? `${t.schema}.${t.name}` : t.name;
      m.set(q, t.exportName);
    }
    return m;
  }, [tables]);

  /** Per-column FK lookup for the selected table. */
  const fkBySourceColumn = useMemo(() => {
    const m = new Map<string, { foreignTable: string; foreignColumn: string }>();
    if (!detail) return m;
    for (const fk of detail.foreignKeys) {
      for (let i = 0; i < fk.columns.length; i++) {
        m.set(fk.columns[i], {
          foreignTable: fk.foreignTable,
          foreignColumn: fk.foreignColumns[i] ?? fk.foreignColumns[0],
        });
      }
    }
    return m;
  }, [detail]);

  const columnByName = useMemo(() => {
    const m = new Map<string, ColumnSummary>();
    if (!detail) return m;
    for (const c of detail.columns) m.set(c.name, c);
    return m;
  }, [detail]);

  const fetchDetail = useCallback(async (exportName: string) => {
    setLoading(true);
    try {
      const d = await fetch(`/api/dev/tables/${encodeURIComponent(exportName)}`).then((r) => r.json());
      setDetail(d);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRows = useCallback(
    async (exportName: string, ofs: number, r: 'admin' | 'app', fs: Filter[]) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(ofs), role: r });
        if (fs.length > 0) {
          const triples = fs.map((f) =>
            VALUELESS_OPS.has(f.op) ? [f.col, f.op] : [f.col, f.op, f.value],
          );
          params.set('filters', JSON.stringify(triples));
        }
        const d = await fetch(
          `/api/dev/tables/${encodeURIComponent(exportName)}/rows?${params}`,
        ).then((res) => res.json());
        setRows(d);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setRows(null);
      return;
    }
    setOffset(0);
    void fetchDetail(selected);
    void fetchRows(selected, 0, role, filters);
  }, [selected, role, filters, fetchDetail, fetchRows]);

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

  /** Click handler for FK cells — switch table + apply eq filter. */
  const navigateFK = useCallback(
    (foreignTable: string, foreignColumn: string, value: unknown) => {
      const target = qualifiedToExport.get(foreignTable);
      if (!target) return;
      setFilters([{ col: foreignColumn, op: 'eq', value }]);
      setSelected(target);
    },
    [qualifiedToExport],
  );

  const filterChips = useMemo(() => {
    return filters.map((f, i) => ({
      key: i,
      col: f.col,
      op: f.op,
      label: VALUELESS_OPS.has(f.op)
        ? `${f.col} ${OP_LABEL.get(f.op)}`
        : `${f.col} ${OP_LABEL.get(f.op)} ${valueToLabel(f.value)}`,
    }));
  }, [filters]);

  const removeFilter = (idx: number) => {
    setFilters((s) => s.filter((_, i) => i !== idx));
  };
  const clearAllFilters = () => setFilters([]);

  const addFilter = (col: string, op: Op, raw: string) => {
    const c = columnByName.get(col);
    const value = VALUELESS_OPS.has(op) ? null : coerceFilterValue(c, raw);
    setFilters((s) => [...s, { col, op, value }]);
    setComposerOpen(false);
  };

  const hasFilters = filterChips.length > 0;

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
                  onClick={() => {
                    if (selected !== t.exportName) setFilters([]);
                    setSelected(t.exportName);
                  }}
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
              Click any FK column value to navigate, or use <strong>+ Filter</strong> to
              compose a WHERE clause.
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
                <button
                  type="button"
                  className="pc-tables-add-filter"
                  onClick={() => setComposerOpen(true)}
                >
                  + Filter
                </button>
                {rows && rows.total !== null && (
                  <span className="pc-tables-count">{rows.total.toLocaleString()} rows</span>
                )}
              </div>
            </div>

            {hasFilters && (
              <div className="pc-tables-filter-bar">
                {filterChips.map((chip) => (
                  <span key={chip.key} className="pc-tables-filter-chip">
                    <code>{chip.label}</code>
                    <button
                      type="button"
                      className="pc-tables-filter-chip-x"
                      onClick={() => removeFilter(chip.key)}
                      title={`Remove ${chip.col} ${chip.op} filter`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button className="pc-tables-filter-clear" onClick={clearAllFilters}>
                  clear all
                </button>
              </div>
            )}

            {composerOpen && (
              <FilterComposer
                columns={orderedColumns.filter((c) => !c.generated)}
                onCancel={() => setComposerOpen(false)}
                onApply={addFilter}
              />
            )}

            <section className="pc-tables-columns">
              <h3>Columns</h3>
              <table className="pc-tables-coltable">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>Null?</th>
                    <th>PK</th>
                    <th>FK</th>
                    <th>Default</th>
                    <th>Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedColumns.map((c) => {
                    const fk = fkBySourceColumn.get(c.name);
                    return (
                      <tr key={c.name} className={c.primary ? 'is-pk' : ''}>
                        <td className="pc-tables-colname">{c.name}</td>
                        <td>
                          <code>{c.dataType}</code>
                          <span className="pc-tables-coltype-mute"> · {c.columnType.replace(/^Pg/, '')}</span>
                        </td>
                        <td>{c.notNull ? '' : 'null'}</td>
                        <td>{c.primary ? 'PK' : ''}</td>
                        <td className="pc-tables-fkcell">
                          {fk && <code>{fk.foreignTable}.{fk.foreignColumn}</code>}
                        </td>
                        <td className="pc-tables-coldefault">
                          {c.hasDefault ? (c.default !== null && c.default !== undefined ? String(c.default) : '<sql>') : ''}
                        </td>
                        <td>
                          {c.isUnique && <span className="pc-tables-flag">unique</span>}
                          {c.generated && <span className="pc-tables-flag">generated</span>}
                        </td>
                      </tr>
                    );
                  })}
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
                {rows && !hasFilters && (
                  <div className="pc-tables-paginate">
                    <button
                      disabled={offset === 0 || loading}
                      onClick={() => {
                        const o = Math.max(offset - PAGE_SIZE, 0);
                        setOffset(o);
                        void fetchRows(selected, o, role, filters);
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
                        void fetchRows(selected, o, role, filters);
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
                          <th key={k}>
                            {k}
                            {fkBySourceColumn.has(k) && <span className="pc-tables-fkmark"> →</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.rows.map((r, i) => (
                        <tr key={i}>
                          {Object.keys(rows.rows[0]).map((k) => {
                            const fk = fkBySourceColumn.get(k);
                            const value = r[k];
                            return (
                              <td key={k}>
                                {fk && value !== null && value !== undefined ? (
                                  <button
                                    type="button"
                                    className="pc-tables-fklink"
                                    onClick={() => navigateFK(fk.foreignTable, fk.foreignColumn, value)}
                                    title={`Open ${fk.foreignTable} where ${fk.foreignColumn} = ${valueToLabel(value)}`}
                                  >
                                    {renderCell(value)}
                                  </button>
                                ) : (
                                  renderCell(value)
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rows && rows.rows.length === 0 && !rows.error && (
                <p className="pc-tables-empty-rows">No rows{hasFilters ? ' matching filter' : ''}.</p>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function FilterComposer({
  columns,
  onCancel,
  onApply,
}: {
  columns: ColumnSummary[];
  onCancel: () => void;
  onApply: (col: string, op: Op, value: string) => void;
}) {
  const [col, setCol] = useState(columns[0]?.name ?? '');
  const [op, setOp] = useState<Op>('eq');
  const [value, setValue] = useState('');
  const selectedCol = columns.find((c) => c.name === col);
  const needsValue = !VALUELESS_OPS.has(op);
  const submit = () => {
    if (col) onApply(col, op, value);
  };
  return (
    <div className="pc-tables-composer">
      <span className="pc-tables-composer-label">WHERE</span>
      <select value={col} onChange={(e) => setCol(e.target.value)}>
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name} ({c.columnType.replace(/^Pg/, '').toLowerCase()})
          </option>
        ))}
      </select>
      <select
        className="pc-tables-composer-opsel"
        value={op}
        onChange={(e) => setOp(e.target.value as Op)}
        title="Comparison operator"
      >
        {OPS.map((o) => (
          <option key={o.op} value={o.op}>{o.label}</option>
        ))}
      </select>
      {needsValue && (
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            op === 'like' || op === 'ilike'
              ? 'pattern (% wildcards)'
              : selectedCol
                ? coerceHint(selectedCol)
                : 'value'
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          autoFocus
        />
      )}
      <button className="pc-tables-composer-apply" onClick={submit}>
        Apply
      </button>
      <button className="pc-tables-composer-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function coerceFilterValue(col: ColumnSummary | undefined, raw: string): unknown {
  if (!col) return raw;
  const t = col.columnType;
  if (raw === '' && !col.notNull) return null;
  switch (t) {
    case 'PgInteger':
    case 'PgSmallInt':
    case 'PgSerial':
    case 'PgSmallSerial':
    case 'PgBigInt53':
    case 'PgBigInt64':
    case 'PgBigSerial53':
    case 'PgBigSerial64':
    case 'PgReal':
    case 'PgDoublePrecision':
      return raw === '' ? null : Number(raw);
    case 'PgBoolean':
      return raw === 'true' || raw === '1' || raw === 't';
    default:
      return raw;
  }
}

function coerceHint(col: ColumnSummary): string {
  const t = col.columnType;
  if (t.startsWith('PgInteger') || t.startsWith('PgBigInt') || t.startsWith('PgReal') || t.startsWith('PgDoublePrecision') || t === 'PgNumeric') {
    return 'number';
  }
  if (t === 'PgBoolean') return 'true / false';
  return 'text';
}

function valueToLabel(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 37) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 40);
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
