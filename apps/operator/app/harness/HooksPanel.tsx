'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useConfirmDialog } from './useConfirmDialog';
import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@restart/sync';

// Row shape from harness_shared.harness_hook_logs (mirrored metadata only;
// log bodies are still fetched on demand via /hook-logs/<logId> REST).
type HarnessHookLogRow = {
  harnessSlug: string;
  logId: string;
  name: string;
  ts: number;
  sizeBytes: number;
  workspaceId: string;
};
import { Modal } from './Modal';
import Editor from '@monaco-editor/react';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

// Hook names come from the server (which greps run.sh). The client never
// has its own list — eliminating the parallel-list drift the previous
// shared-import attempt couldn't prevent.
type HookName = string;

const DEFAULT_PLACEHOLDER = `#!/usr/bin/env bash
# Custom harness hook. Env: PROJECT_DIR, STATE_DIR, plus hook-specific vars.
# Non-zero exit codes are warned but don't halt the mission.
`;

const PLACEHOLDERS: Record<string, string> = {
  'pre-worker': `#!/usr/bin/env bash
# pre-worker — runs before each worker invocation.
# Env: ROLE=worker, FEATURE_ID, PROJECT_DIR, STATE_DIR
# Non-zero exits are warned but don't halt the mission.

echo "worker starting: $FEATURE_ID"
`,
  'post-worker': `#!/usr/bin/env bash
# post-worker — runs after each worker invocation.
# Env: ROLE=worker, FEATURE_ID, RC (worker exit code), PROJECT_DIR, STATE_DIR

echo "worker $FEATURE_ID done rc=$RC"
# Example: auto-commit on success
# [ "$RC" = "0" ] && cd "$PROJECT_DIR" && git add -A && git commit -m "worker: $FEATURE_ID" || true
`,
  'pre-validator': `#!/usr/bin/env bash
# pre-validator — runs before each validator invocation.
# Env: ROLE=validator, FEATURE_ID, PROJECT_DIR, STATE_DIR

echo "validator starting: $FEATURE_ID"
`,
  'post-validator': `#!/usr/bin/env bash
# post-validator — runs after each validator invocation.
# Env: ROLE=validator, FEATURE_ID, RC, PROJECT_DIR, STATE_DIR

echo "validator $FEATURE_ID done rc=$RC"
`,
  'on-escalate': `#!/usr/bin/env bash
# on-escalate — runs when the orchestrator decides to escalate.
# Env: REASON, PROJECT_DIR, STATE_DIR

echo "escalation: $REASON"
# Example: desktop/push notification
# notify-send "Harness escalated" "$REASON" || true
`,
  'on-feature-passed': `#!/usr/bin/env bash
# on-feature-passed — runs when validator transitions a feature to passed.
# Env: FEATURE_ID, STATUS=passed, PROJECT_DIR, STATE_DIR

echo "feature passed: $FEATURE_ID"
# Example: notify team, trigger downstream job, etc.
`,
  'on-feature-failing': `#!/usr/bin/env bash
# on-feature-failing — runs when validator transitions a feature to failing.
# Env: FEATURE_ID, STATUS=failing, PROJECT_DIR, STATE_DIR

echo "feature failing: $FEATURE_ID"
# Example: push-notify, log to bug tracker
`,
};

interface HookEntry {
  name: HookName;
  exists: boolean;
  executable: boolean;
  content: string | null;
}

interface HookRun {
  logId: string;
  name: string;
  ts: number;
  sizeBytes: number;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const HOOK_COLOR: Record<string, string> = {
  'pre-worker': '#3b82f6',
  'post-worker': '#10b981',
  'pre-validator': '#a855f7',
  'post-validator': '#8b5cf6',
  'on-escalate': '#f59e0b',
  'on-feature-passed': '#22c55e',
  'on-feature-failing': '#ef4444',
};

interface Props {
  slug: string;
  alive: boolean;
  onClose: () => void;
}

function HooksPanelInner({ slug, alive, onClose }: Props) {
  const [tab, setTab] = useQueryState('hookTab', parseAsString.withDefault(''));
  const [hooks, setHooks] = useState<Record<HookName, HookEntry> | null>(null);
  const [hookNames, setHookNames] = useState<string[]>([]);
  const [draft, setDraft] = useState<Record<HookName, string>>({});
  const [saving, setSaving] = useState<HookName | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<{ logId: string; content: string } | null>(null);
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Live-pushed via Zero (harness_shared.harness_hook_logs, mirrored from
  // .harness/logs/hooks/*.log file metadata by harness-fs-watcher.ts).
  // Replaces useSseOrPoll(/hook-logs/sse, loadRuns, 3000).
  const { data: hookLogRows } = useSyncQuery<HarnessHookLogRow>({
    queryName: 'harnessHookLogs.byHarness',
    args: { harnessSlug: slug },
  });
  const runs = useMemo<HookRun[]>(
    () =>
      (hookLogRows ?? []).map((r) => ({
        logId: r.logId,
        name: r.name,
        ts: r.ts,
        sizeBytes: r.sizeBytes,
      })),
    [hookLogRows],
  );
  const [loadingLog, setLoadingLog] = useState(false);

  const load = useCallback(async () => {
    const d = await fetch(`/api/harness/${slug}/hooks`).then((r) => r.json());
    const list = (d.hooks ?? []) as HookEntry[];
    const names = list.map((h) => h.name);
    const map = Object.fromEntries(list.map((h) => [h.name, h])) as Record<HookName, HookEntry>;
    setHooks(map);
    setHookNames(names);
    setDraft((prev) => {
      const next: Record<string, string> = {};
      for (const name of names) next[name] = prev[name] ?? map[name]?.content ?? '';
      return next;
    });
  }, [slug]);

  useEffect(() => { load().catch((e) => setToast(`load: ${e}`)); }, [load]);

  // Initialize the active tab once we know what hooks exist. Prefer the
  // user's URL-state choice if it's still valid; otherwise pick the first
  // hook the server returned.
  useEffect(() => {
    if (hookNames.length === 0) return;
    if (tab && hookNames.includes(tab)) return;
    setTab(hookNames[0]);
  }, [hookNames, tab, setTab]);

  const openLog = useCallback(async (logId: string) => {
    // Eager: hook log content is mirrored into harness_hook_logs.content
    // by the watcher (cap 256KB). Read from the cached row synchronously.
    // Falls back to REST for harnesses that pre-date the watcher
    // mirroring or for content-truncated rows.
    const cached = (hookLogRows ?? []).find((r) => r.logId === logId) as (HarnessHookLogRow & { content?: string }) | undefined;
    if (cached?.content && cached.content.length > 0) {
      setSelectedLog({ logId, content: cached.content });
      return;
    }
    setLoadingLog(true);
    try {
      const d = await fetch(`/api/harness/${slug}/hook-logs/${logId}`).then((r) => r.json());
      if (d.error) throw new Error(d.error);
      setSelectedLog(d);
    } catch (e) {
      setToast(`log: ${e}`);
      setTimeout(() => setToast(null), 2500);
    } finally {
      setLoadingLog(false);
    }
  }, [slug, hookLogRows]);

  const dirty = useMemo(() => {
    if (!hooks) return new Set<HookName>();
    const d = new Set<HookName>();
    for (const name of hookNames) {
      const orig = hooks[name]?.content ?? '';
      if ((draft[name] ?? '') !== orig) d.add(name);
    }
    return d;
  }, [hooks, draft, hookNames]);

  const save = useCallback(async (name: HookName) => {
    setSaving(name);
    try {
      const content = draft[name];
      if (!content || content.trim() === '') {
        throw new Error('cannot save empty hook — use "remove" to delete');
      }
      const r = await fetch(`/api/harness/${slug}/hooks/${name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast(`saved: ${name}`);
      await load();
    } catch (e) {
      setToast(`save failed: ${e}`);
    } finally {
      setSaving(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, draft, load]);

  const remove = useCallback(async (name: HookName) => {
    if (!await askConfirm({
      title: `Delete ${name}.sh?`,
      body: 'The hook will no longer fire.',
      confirmLabel: 'Delete hook',
      destructive: true,
    })) return;
    setSaving(name);
    try {
      const r = await fetch(`/api/harness/${slug}/hooks/${name}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      setToast(`removed: ${name}`);
      setDraft((d) => ({ ...d, [name]: '' }));
      await load();
    } catch (e) {
      setToast(`delete failed: ${e}`);
    } finally {
      setSaving(null);
      setTimeout(() => setToast(null), 2500);
    }
  }, [slug, load, askConfirm]);

  const insertPlaceholder = useCallback((name: HookName) => {
    setDraft((d) => ({ ...d, [name]: PLACEHOLDERS[name] ?? DEFAULT_PLACEHOLDER }));
  }, []);

  // Cmd+S save active tab
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty.has(tab)) save(tab);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [dirty, tab, save]);

  const activeEntry = hooks?.[tab];
  const isActiveDirty = dirty.has(tab);
  const isEmpty = (draft[tab] ?? '').trim() === '';

  return (
    <Modal
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`Hooks`}
      srOnlyTitle
      zIndex={60}
      contentStyle={{ background: '#0b0e14', border: '1px solid #374151', borderRadius: 6, width: '88vw', height: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
        {confirmEl}
        {/* Header */}
        <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <strong style={{ color: '#e5e7eb' }}>Hooks — {slug}</strong>
          <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: '0.75rem' }}>
            .harness/hooks/{tab}.sh
          </span>
          {alive && (
            <span style={{ color: '#f59e0b', fontSize: '0.8rem', marginLeft: '1rem' }}>
              ⚠ harness running — changes apply from next invocation
            </span>
          )}
          <span style={{ color: '#6b7280', fontSize: '0.7rem', marginLeft: alive ? 0 : '1rem' }}>
            Built-ins (branch_iso, auto_screenshot) also fire automatically — see config.json.
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {toast && (
              <span style={{ color: /failed/i.test(toast) ? '#ef4444' : '#10b981', fontSize: '0.8rem' }}>{toast}</span>
            )}
            {activeEntry?.exists && (
              <button
                onClick={() => remove(tab)}
                disabled={!!saving}
                style={{ background: 'transparent', color: '#f87171', border: '1px solid #7f1d1d', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer', fontSize: '0.8rem' }}
                title="Delete this hook file (it will no longer fire)"
              >
                remove
              </button>
            )}
            <button
              onClick={() => save(tab)}
              disabled={!isActiveDirty || isEmpty || !!saving}
              style={{ background: isActiveDirty && !isEmpty ? '#2563eb' : '#374151', color: 'white', border: 'none', borderRadius: 3, padding: '0.35rem 0.9rem', cursor: isActiveDirty && !isEmpty ? 'pointer' : 'not-allowed', fontWeight: 600 }}
              title="Save hook (⌘/Ctrl+S). chmod 755 applied on server."
            >
              {saving === tab ? 'saving…' : 'save'}
            </button>
            <button
              onClick={onClose}
              style={{ background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 3, padding: '0.35rem 0.75rem', cursor: 'pointer' }}
            >
              close
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '0.25rem', padding: '0.35rem 1rem', borderBottom: '1px solid #1f2937', background: '#0f141f' }}>
          {hookNames.map((name) => {
            const isActive = name === tab;
            const isDirty = dirty.has(name);
            const entry = hooks?.[name];
            return (
              <button
                key={name}
                onClick={() => setTab(name)}
                style={{
                  background: isActive ? '#1f2937' : 'transparent',
                  color: isActive ? '#e5e7eb' : '#9ca3af',
                  border: '1px solid ' + (isActive ? '#374151' : 'transparent'),
                  borderRadius: 3,
                  padding: '0.3rem 0.75rem',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                {entry?.exists ? '●' : '○'}
                {name}
                {isDirty && <span style={{ color: '#f59e0b' }}>●</span>}
              </button>
            );
          })}
        </div>

        {/* Editor */}
        <div style={{ flex: '1 1 60%', position: 'relative', minHeight: 0 }}>
          {!hooks ? (
            <div style={{ padding: '2rem', color: '#9ca3af' }}>loading…</div>
          ) : (
            <>
              <Editor
                height="100%"
                language="shell"
                theme="vs-dark"
                value={draft[tab] ?? ''}
                onChange={(v) => setDraft((d) => ({ ...d, [tab]: v ?? '' }))}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 2,
                }}
              />
              {isEmpty && (
                <div style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: '#111827', border: '1px solid #374151', padding: '0.5rem 0.75rem', borderRadius: 3, fontSize: '0.8rem', color: '#9ca3af', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  hook not yet created
                  <button
                    onClick={() => insertPlaceholder(tab)}
                    style={{ background: '#1f2937', color: '#e5e7eb', border: '1px solid #374151', borderRadius: 3, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.75rem' }}
                  >
                    insert template
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Recent runs + detail */}
        <div style={{ flex: '0 0 40%', borderTop: '1px solid #1f2937', display: 'flex', minHeight: 0 }}>
          <div style={{ flex: '0 0 38%', borderRight: '1px solid #1f2937', overflow: 'auto', padding: '0.5rem 0.75rem' }}>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              recent hook runs
              <span style={{ color: '#6b7280' }}>({runs.length})</span>
              {runs.length === 0 && <span style={{ color: '#6b7280', fontStyle: 'italic' }}>none yet — fire a hook to see logs here</span>}
            </div>
            <HookRunsGrid runs={runs} selectedLogId={selectedLog?.logId ?? null} onSelect={openLog} />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ fontSize: '0.75rem', color: '#9ca3af', padding: '0.5rem 0.75rem', borderBottom: '1px solid #1f2937', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              log output
              {selectedLog && <code style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>{selectedLog.logId}.log</code>}
              {loadingLog && <span style={{ color: '#6b7280' }}>loading…</span>}
            </div>
            <pre style={{ flex: 1, overflow: 'auto', margin: 0, padding: '0.5rem 0.75rem', fontSize: '0.75rem', fontFamily: 'ui-monospace, monospace', color: '#d1d5db', whiteSpace: 'pre-wrap' }}>
              {selectedLog ? (selectedLog.content || '(empty)') : '(click a row to view)'}
            </pre>
          </div>
        </div>
      </Modal>
  );
}

function HookRunsGrid({
  runs, selectedLogId, onSelect,
}: {
  runs: HookRun[];
  selectedLogId: string | null;
  onSelect: (logId: string) => void;
}) {
  const columns: ColumnDef<HookRun>[] = useMemo(
    () => [
      {
        key: 'when',
        header: 'When',
        width: 1.3,
        sortKey: 'ts',
        defaultSortDir: 'desc',
        render: ({ row }) => <span style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmtTs(row.ts)}</span>,
      },
      {
        key: 'name',
        header: 'Hook',
        width: 1.5,
        sortKey: 'name',
        render: ({ row }) => (
          <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, background: HOOK_COLOR[row.name] ?? '#374151', color: 'white', fontWeight: 600 }}>
            {row.name}
          </span>
        ),
      },
      {
        key: 'size',
        header: 'Size',
        width: 0.5,
        align: 'right',
        sortKey: 'sizeBytes',
        render: ({ row }) => <span style={{ color: '#6b7280', whiteSpace: 'nowrap' }}>{row.sizeBytes}B</span>,
      },
    ],
    [],
  );
  const richGetRowBg = (row: HookRun) => (selectedLogId === row.logId ? '#1f2937' : 'transparent');
  return (
    <RichGrid<HookRun>
      rows={runs}
      columns={columns}
      getRowId={(r) => r.logId}
      onRowClick={(r) => onSelect(r.logId)}
      getRowBg={richGetRowBg}
      inline
    />
  );
}

const HooksPanel = memo(HooksPanelInner);
export default HooksPanel;
