'use client';

/**
 * /settings/omp — full configuration surface for the omp (oh-my-pi)
 * agent backend. Mirrors `omp config list` / `omp config set`.
 *
 * Layout:
 * - Search bar at the top (filters across all sections).
 * - Each section ([providers], [tools], [memory], …) is a collapsible
 *   group. Web-search section starts open (the user's stated entry
 *   point) plus any section that has search matches.
 * - Each setting renders as the right input type (boolean toggle,
 *   enum select, number, text, or JSON for array/record).
 * - Edits debounce to a single POST; success/failure surfaces inline.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsString, parseAsArrayOf } from 'nuqs';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';

interface OmpSetting {
  key: string;
  raw: string;
  parsed: unknown;
  type: 'string' | 'boolean' | 'number' | 'array' | 'record' | { kind: 'enum'; choices: string[] };
  isUnset: boolean;
}

interface OmpSection { name: string; settings: OmpSetting[]; }

type RowState = 'idle' | 'saving' | 'saved' | 'error';

const SECTIONS_OPEN_BY_DEFAULT = ['providers'];

export default function OmpSettingsPage(): JSX.Element {
  const [sections, setSections] = useState<OmpSection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // URL-backed view state (nuqs) — agents can read + drive the filter and
  // section expansion; survives reloads/deep-links.
  const [query, setQuery] = useQueryState('q', parseAsString.withDefault(''));
  const [openSections, setOpenSections] = useQueryState(
    'open',
    parseAsArrayOf(parseAsString).withDefault(SECTIONS_OPEN_BY_DEFAULT),
  );
  const [rowStates, setRowStates] = useState<Record<string, { state: RowState; error?: string }>>({});

  const refresh = async () => {
    setLoadError(null);
    try {
      const r = await fetch('/api/agent-mcp/omp-config');
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? 'failed to load');
      setSections(d.sections as OmpSection[]);
    } catch (err) {
      setLoadError((err as Error).message ?? String(err));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const filtered = useMemo(() => {
    if (!sections) return null;
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((sec) => ({
        ...sec,
        settings: sec.settings.filter((s) =>
          s.key.toLowerCase().includes(q) || sec.name.toLowerCase().includes(q),
        ),
      }))
      .filter((sec) => sec.settings.length > 0);
  }, [sections, query]);

  // Auto-expand sections that have search matches.
  useEffect(() => {
    if (!query || !filtered) return;
    void setOpenSections((prev) => {
      const next = new Set(prev);
      for (const sec of filtered) next.add(sec.name);
      return next.size === prev.length ? prev : [...next];
    });
  }, [query, filtered, setOpenSections]);

  const setRow = (key: string, s: { state: RowState; error?: string }) => {
    setRowStates((prev) => ({ ...prev, [key]: s }));
  };

  const saveValue = async (key: string, value: unknown) => {
    setRow(key, { state: 'saving' });
    try {
      const r = await fetch('/api/agent-mcp/omp-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setRow(key, { state: 'saved' });
      // Refresh just this row's parsed value so the UI matches what omp stored.
      void refresh();
      setTimeout(() => setRow(key, { state: 'idle' }), 1500);
    } catch (err) {
      setRow(key, { state: 'error', error: (err as Error).message ?? String(err) });
    }
  };

  const unsetValue = async (key: string) => {
    setRow(key, { state: 'saving' });
    try {
      const r = await fetch('/api/agent-mcp/omp-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, unset: true }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setRow(key, { state: 'saved' });
      void refresh();
      setTimeout(() => setRow(key, { state: 'idle' }), 1500);
    } catch (err) {
      setRow(key, { state: 'error', error: (err as Error).message ?? String(err) });
    }
  };

  if (loadError) {
    return (
      <div>
        <h1>Oh-My-Pi (omp) settings</h1>
        <div style={S.error}>
          <strong>Failed to load omp config.</strong>
          <div>{loadError}</div>
          <p className="pc-settings-hint" style={{ marginTop: 8 }}>
            Check that <code>omp</code> is on the operator&apos;s PATH and that <code>omp config list</code> works at the shell.
          </p>
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      </div>
    );
  }

  if (!sections) {
    return (
      <div>
        <h1>Oh-My-Pi (omp) settings</h1>
        <p className="pc-settings-loading">Loading omp config…</p>
      </div>
    );
  }

  const totalSettings = sections.reduce((n, s) => n + s.settings.length, 0);
  const totalShown = filtered?.reduce((n, s) => n + s.settings.length, 0) ?? totalSettings;

  return (
    <div>
      <header>
        <h1>Oh-My-Pi (omp) settings</h1>
        <p className="pc-settings-intro">
          Read and edit the {totalSettings} settings exposed by{' '}
          <code>omp config list</code>. Changes persist immediately
          via <code>omp config set</code> and apply to all new omp invocations
          (existing sessions keep their startup config).
        </p>
      </header>

      <div style={S.searchRow}>
        <input
          type="search"
          value={query}
          onChange={(e) => void setQuery(e.target.value || null)}
          placeholder="Filter settings (e.g. web_search, hindsight, theme)…"
          style={S.searchInput}
          aria-label="Filter omp settings"
        />
        {query && (
          <span style={S.muted}>{totalShown} / {totalSettings} matching</span>
        )}
      </div>

      <div style={S.sections}>
        {filtered?.map((sec) => {
          const isOpen = openSections.includes(sec.name);
          return (
            <section key={sec.name} style={S.section}>
              <button
                style={S.sectionHeader}
                onClick={() => {
                  void setOpenSections((prev) => prev.includes(sec.name)
                    ? prev.filter((n) => n !== sec.name)
                    : [...prev, sec.name]);
                }}
                aria-expanded={isOpen}
              >
                <span style={S.sectionChevron}>{isOpen ? '▾' : '▸'}</span>
                <span style={S.sectionName}>[{sec.name}]</span>
                <span style={S.sectionCount}>{sec.settings.length}</span>
              </button>
              {isOpen && (
                <div style={S.sectionBody}>
                  {sec.settings.map((setting) => (
                    <SettingRow
                      key={setting.key}
                      setting={setting}
                      rowState={rowStates[setting.key]}
                      onSave={(v) => void saveValue(setting.key, v)}
                      onUnset={() => void unsetValue(setting.key)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function SettingRow({
  setting,
  rowState,
  onSave,
  onUnset,
}: {
  setting: OmpSetting;
  rowState?: { state: RowState; error?: string };
  onSave: (v: unknown) => void;
  onUnset: () => void;
}): JSX.Element {
  const stateLabel = rowState?.state === 'saving' ? 'Saving…'
    : rowState?.state === 'saved' ? 'Saved'
    : rowState?.state === 'error' ? `Error: ${rowState.error?.slice(0, 80) ?? 'unknown'}`
    : null;

  return (
    <div style={S.row}>
      <div style={S.rowKey}>
        <code style={S.code}>{setting.key}</code>
        {stateLabel && (
          <span style={rowState?.state === 'error' ? S.stateError : S.stateInfo}>{stateLabel}</span>
        )}
      </div>
      <div style={S.rowControl}>
        <ValueControl setting={setting} onSave={onSave} />
      </div>
      <div style={S.rowMeta}>
        {!setting.isUnset && (
          <button
            type="button"
            style={S.btnGhost}
            onClick={onUnset}
            title="Reset to default (unset)"
          >
            ↻ default
          </button>
        )}
      </div>
    </div>
  );
}

function ValueControl({ setting, onSave }: { setting: OmpSetting; onSave: (v: unknown) => void }): JSX.Element {
  if (setting.type === 'boolean') {
    return (
      <label style={S.toggle}>
        <Checkbox
          checked={setting.parsed === true}
          onChange={(v) => onSave(v)}
          ariaLabel={setting.key}
        />
        <span>{setting.parsed === true ? 'on' : 'off'}</span>
      </label>
    );
  }
  if (typeof setting.type === 'object' && setting.type.kind === 'enum') {
    return (
      <Select
        value={setting.isUnset ? '_unset' : String(setting.parsed)}
        onChange={(v) => onSave(v === '_unset' ? '' : v)}
        options={[
          ...(setting.isUnset ? [{ value: '_unset', label: '(not set)' }] : []),
          ...setting.type.choices.map((c) => ({ value: c, label: c })),
        ]}
        ariaLabel={setting.key}
      />
    );
  }
  if (setting.type === 'number') {
    return <NumberControl setting={setting} onSave={onSave} />;
  }
  if (setting.type === 'array' || setting.type === 'record') {
    return <JsonControl setting={setting} onSave={onSave} />;
  }
  return <StringControl setting={setting} onSave={onSave} />;
}

function StringControl({ setting, onSave }: { setting: OmpSetting; onSave: (v: unknown) => void }): JSX.Element {
  const [v, setV] = useState<string>(setting.isUnset ? '' : String(setting.parsed ?? ''));
  const dirtyRef = useRef(false);
  useEffect(() => { if (!dirtyRef.current) setV(setting.isUnset ? '' : String(setting.parsed ?? '')); }, [setting.parsed, setting.isUnset]);
  const commit = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    onSave(v);
  };
  return (
    <input
      type="text"
      value={v}
      onChange={(e) => { dirtyRef.current = true; setV(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
      placeholder={setting.isUnset ? '(not set)' : ''}
      style={S.input}
    />
  );
}

function NumberControl({ setting, onSave }: { setting: OmpSetting; onSave: (v: unknown) => void }): JSX.Element {
  const initial = setting.isUnset ? '' : String(setting.parsed ?? '');
  const [v, setV] = useState<string>(initial);
  const dirtyRef = useRef(false);
  useEffect(() => { if (!dirtyRef.current) setV(setting.isUnset ? '' : String(setting.parsed ?? '')); }, [setting.parsed, setting.isUnset]);
  const commit = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const n = Number(v);
    if (Number.isFinite(n)) onSave(n);
    else onSave(v);
  };
  return (
    <input
      type="number"
      value={v}
      onChange={(e) => { dirtyRef.current = true; setV(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
      style={S.input}
    />
  );
}

function JsonControl({ setting, onSave }: { setting: OmpSetting; onSave: (v: unknown) => void }): JSX.Element {
  const initial = setting.isUnset ? '' : JSON.stringify(setting.parsed ?? null, null, 2);
  const [v, setV] = useState<string>(initial);
  const [err, setErr] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current) setV(setting.isUnset ? '' : JSON.stringify(setting.parsed ?? null, null, 2));
  }, [setting.parsed, setting.isUnset]);
  const commit = () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    if (!v.trim()) {
      setErr(null);
      onSave(setting.type === 'array' ? [] : {});
      return;
    }
    try {
      const parsed = JSON.parse(v);
      setErr(null);
      onSave(parsed);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <textarea
        value={v}
        onChange={(e) => { dirtyRef.current = true; setV(e.target.value); }}
        onBlur={commit}
        rows={Math.min(10, Math.max(2, v.split('\n').length))}
        placeholder={setting.type === 'array' ? '[]' : '{}'}
        style={{ ...S.input, fontFamily: 'ui-monospace, monospace', fontSize: 12, minWidth: 320 }}
      />
      {err && <span style={S.stateError}>JSON: {err}</span>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  searchRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 },
  searchInput: { flex: 1 },
  sections: { display: 'flex', flexDirection: 'column', gap: 8 },
  section: {
    background: 'var(--bg-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
  },
  sectionHeader: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
    background: 'transparent', border: 'none', color: 'inherit',
    padding: '10px 14px', fontSize: 13, cursor: 'pointer', textAlign: 'left',
  },
  sectionChevron: { fontSize: 11, color: 'var(--fg-mute)', minWidth: 12 },
  sectionName: { fontFamily: 'ui-monospace, monospace', fontWeight: 600, fontSize: 12, color: 'var(--fg)' },
  sectionCount: { fontSize: 11, color: 'var(--fg-mute)', marginLeft: 'auto' },
  sectionBody: {
    padding: '4px 0 12px',
    borderTop: '1px solid color-mix(in oklab, var(--border), transparent 50%)',
  },
  row: {
    display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(0, 2fr) auto',
    gap: 12, padding: '8px 14px', alignItems: 'center',
    borderBottom: '1px solid color-mix(in oklab, var(--border), transparent 70%)',
  },
  rowKey: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  rowControl: { minWidth: 0 },
  rowMeta: { display: 'flex', justifyContent: 'flex-end' },
  input: { width: '100%', boxSizing: 'border-box' },
  select: {},
  toggle: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' },
  stateInfo: { fontSize: 11, color: 'var(--good, #10b981)', fontStyle: 'italic' },
  stateError: { fontSize: 11, color: 'var(--bad, #ef4444)', fontStyle: 'italic', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  error: {
    background: 'color-mix(in oklab, var(--bad, #ef4444), transparent 92%)',
    border: '1px solid color-mix(in oklab, var(--bad, #ef4444), transparent 70%)',
    borderRadius: 6, padding: 16,
    color: 'color-mix(in oklab, var(--bad, #ef4444), white 30%)',
    fontSize: 13, marginTop: 16,
  },
};
