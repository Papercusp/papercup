'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { Tooltip } from './Tooltip';
import { Play, RefreshCw, Check, X, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@restart/grid-core';

interface TestItem {
  id: string;
  summary: string;
  file: string;
  framework: 'playwright' | 'vitest' | 'pytest';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
  phase: 'staging' | 'testing' | 'production';
  kind?: 'contract' | 'edge';
}

interface Props {
  slug: string;
  phase: 'staging' | 'testing' | 'production';
}

const STATUS_ICON = {
  passing: <Check size={11} style={{ color: 'var(--good)' }} />,
  failing: <X size={11} style={{ color: 'var(--bad)' }} />,
  skipped: <Minus size={11} style={{ color: 'var(--fg-mute)' }} />,
  not_run: <Minus size={11} style={{ color: 'var(--fg-mute)' }} />,
};

function fmtAgo(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts * 1000;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function TestsTabInner({ slug, phase }: Props) {
  const [running, setRunning] = useState<Set<string>>(new Set());

  // Tests stream live from harness_tests (Zero) — chokidar watcher mirrors
  // .harness/tests/*.json into PG. The 30s REST poll is gone.
  const { data: testRows } = useSyncQuery<{
    testId: string;
    name: string;
    status: string;
    durationMs: number;
    lastRunTs: number | null;
    payload: Record<string, unknown>;
  }>({
    queryName: 'harnessTests.byHarness',
    args: { harnessSlug: slug, phase },
    enabled: !!slug,
  });

  const tests: TestItem[] = useMemo(() => {
    if (!Array.isArray(testRows)) return [];
    return testRows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        id: r.testId,
        summary: r.name || r.testId,
        file: typeof p.file === 'string' ? p.file : '',
        framework: (typeof p.framework === 'string' ? p.framework : 'vitest') as TestItem['framework'],
        coversVALs: Array.isArray(p.coversVALs) ? p.coversVALs as string[] : [],
        status: (r.status || 'not_run') as TestItem['status'],
        lastRunTs: r.lastRunTs ?? 0,
        durationMs: r.durationMs ?? 0,
        phase,
        kind: typeof p.kind === 'string' ? p.kind as TestItem['kind'] : undefined,
      };
    });
  }, [testRows, phase]);

  const runOne = async (id: string) => {
    setRunning((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/harness/${slug}/tests/${id}/run?phase=${phase}`, { method: 'POST' });
      const body = await res.json();
      if (body.ok) toast.success(`${id} passed`);
      else toast.error(`${id} failed — click for output`);
      // Watcher will push the new row through Zero — no manual reload needed.
    } catch (e: any) {
      toast.error(`Run failed: ${e.message ?? e}`);
    } finally {
      setRunning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  if (tests.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--fg-dim)', fontSize: 12, textAlign: 'center' }}>
        {phase === 'staging'
          ? 'Tests are generated in the testing phase. Promote staging → testing to begin.'
          : 'No tests yet. The tester agent generates them from the validation contract.'}
      </div>
    );
  }

  const passCount = tests.filter((t) => t.status === 'passing').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        padding: '6px 10px',
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--border)',
        fontSize: 11, flexShrink: 0,
      }}>
        <span style={{ color: 'var(--fg)' }}><b>{passCount}</b> / {tests.length} passing</span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            onClick={() => tests.forEach((t) => runOne(t.id))}
            style={{
              fontSize: 10, padding: '2px 8px',
              background: 'var(--accent, #5e6ad2)', color: 'white', border: 'none', borderRadius: 3,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          ><Play size={10} /> run all</button>
        </span>
      </div>
      <TestsGrid tests={tests} running={running} runOne={runOne} />
    </div>
  );
}

function TestsGrid({
  tests, running, runOne,
}: {
  tests: TestItem[];
  running: Set<string>;
  runOne: (id: string) => void;
}) {
  const columns: ColumnDef<TestItem>[] = useMemo(
    () => [
      {
        key: 'status',
        header: '',
        width: 0.25,
        align: 'center',
        render: ({ row }) => {
          const isRunning = running.has(row.id);
          return isRunning
            ? <RefreshCw size={11} className="h-spin" />
            : (STATUS_ICON[row.status] ?? <Minus size={11} style={{ color: 'var(--fg-mute)' }} />);
        },
      },
      {
        key: 'id',
        header: 'id',
        width: 0.6,
        sortKey: 'id',
        render: ({ row }) => (
          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: 'var(--fg-dim)' }}>
            {row.id}
          </span>
        ),
      },
      {
        key: 'body',
        header: 'test',
        width: 4,
        sortKey: 'summary',
        render: ({ row }) => (
          <div style={{ minWidth: 0, width: '100%' }}>
            <div
              style={{ color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={row.file}
            >
              {row.summary}
            </div>
            <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
              {row.framework} · {row.coversVALs.join(', ') || 'no VAL link'}
              {row.kind === 'edge' && <span style={{ color: '#a855f7', marginLeft: 4 }}>[edge]</span>}
            </div>
          </div>
        ),
      },
      {
        key: 'lastRun',
        header: 'last',
        width: 0.7,
        align: 'right',
        sortKey: 'lastRunTs',
        defaultSortDir: 'desc',
        render: ({ row }) => (
          <span style={{ fontSize: 10, color: 'var(--fg-dim)', fontFamily: 'ui-monospace, monospace' }}>
            {row.lastRunTs ? fmtAgo(row.lastRunTs) : '—'}
            {row.durationMs ? ` · ${row.durationMs}ms` : ''}
          </span>
        ),
      },
      {
        key: 'run',
        header: '',
        width: 0.4,
        align: 'right',
        render: ({ row }) => {
          const isRunning = running.has(row.id);
          return (
            <Tooltip label="Re-run this test">
              <button
                onClick={(e) => { e.stopPropagation(); runOne(row.id); }}
                disabled={isRunning}
                style={{
                  fontSize: 10, padding: '2px 6px',
                  background: 'transparent', color: 'var(--fg-dim)',
                  border: '1px solid var(--border)', borderRadius: 3,
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 2,
                }}
              >
                {isRunning ? '…' : 'run'}
              </button>
            </Tooltip>
          );
        },
      },
    ],
    [running, runOne],
  );

  return (
    <RichGrid<TestItem>
      rows={tests}
      columns={columns}
      getRowId={(t) => t.id}
      inline
    />
  );
}

const TestsTab = memo(TestsTabInner);
export default TestsTab;
