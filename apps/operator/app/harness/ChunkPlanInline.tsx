'use client';

/**
 * ChunkPlanInline — renders the worker-chunk-loop's plan + per-chunk
 * progress for a feature. Inlined into FeaturePeekPanel so the user
 * sees "F-AUTH-001: chunk 3/12 (in_progress)" same-frame on open.
 *
 * Eager via Zero `chunkPlans.byFeature`. When the feature has no plan
 * (legacy single-shot worker, or chunk-loop not enabled for the
 * harness), the component renders nothing — caller decides whether to
 * show a placeholder.
 *
 * Reads from harness_shared.harness_chunk_plans, which is populated by
 * the chunk-loop driver on the backend (see chunk-loop-driver.ts +
 * libs/papercusp/libs/db/sql/042-harness-chunk-plans.sql).
 */

import { useMemo } from 'react';
import { useSyncQuery } from '@restart/sync';

interface ChunkPlanRow {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  chunkId: string;
  chunkIndex: number;
  files: readonly string[];
  description: string;
  status: 'pending' | 'in_progress' | 'committed' | 'failing' | 'escalated' | string;
  strikes: number;
  lastError?: string | null;
  commitSha?: string | null;
  createdTs: number;
  updatedTs: number;
}

interface Props {
  slug: string;
  featureId: string;
}

const STATUS_GLYPH: Record<string, string> = {
  pending:     '○',
  in_progress: '◐',
  committed:   '●',
  failing:     '⚠',
  escalated:   '✕',
};

const STATUS_COLOR: Record<string, string> = {
  pending:     'var(--fg-mute, #94a3b8)',
  in_progress: 'var(--accent, #7aa2f7)',
  committed:   'var(--good, #65cd91)',
  failing:     'var(--warn, #f0b400)',
  escalated:   'var(--bad, #ff7676)',
};

export default function ChunkPlanInline({ slug, featureId }: Props) {
  const { data: rows } = useSyncQuery<ChunkPlanRow>({
    queryName: 'chunkPlans.byFeature',
    args: { harnessSlug: slug, featureId },
    enabled: !!slug && !!featureId,
  });

  const chunks = useMemo<readonly ChunkPlanRow[]>(
    () => (Array.isArray(rows) ? rows : []),
    [rows],
  );

  const summary = useMemo(() => {
    if (chunks.length === 0) return null;
    const committed = chunks.filter((c) => c.status === 'committed').length;
    const inProgress = chunks.filter((c) => c.status === 'in_progress').length;
    const escalated = chunks.filter((c) => c.status === 'escalated').length;
    const failing = chunks.filter((c) => c.status === 'failing').length;
    return { total: chunks.length, committed, inProgress, escalated, failing };
  }, [chunks]);

  if (chunks.length === 0) return null;

  return (
    <section
      style={{
        marginTop: 12,
        padding: 10,
        background: 'var(--bg-2, #14141a)',
        border: '1px solid var(--border, #2a2a32)',
        borderRadius: 6,
      }}
      aria-label="Chunk plan"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          color: 'var(--fg-mute, #94a3b8)',
        }}
      >
        <span>chunk plan</span>
        {summary && (
          <span style={{ color: 'var(--fg, #e8e8ea)', fontWeight: 500, fontSize: 10.5, textTransform: 'none', letterSpacing: 0 }}>
            {summary.committed}/{summary.total} committed
            {summary.inProgress > 0 && ` · ${summary.inProgress} in flight`}
            {summary.failing > 0 && ` · ${summary.failing} failing`}
            {summary.escalated > 0 && ` · ${summary.escalated} escalated`}
          </span>
        )}
      </div>

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {chunks.map((c) => {
          const glyph = STATUS_GLYPH[c.status] ?? '?';
          const color = STATUS_COLOR[c.status] ?? 'var(--fg, #e8e8ea)';
          return (
            <li
              key={c.chunkId}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto',
                alignItems: 'baseline',
                gap: 8,
                fontSize: 12,
                lineHeight: 1.4,
              }}
              title={
                c.lastError
                  ? `${c.status} (${c.strikes} strikes)\n\n${c.lastError.slice(0, 1000)}`
                  : c.status
              }
            >
              <span style={{ color, fontFamily: 'ui-monospace, monospace', textAlign: 'center' }}>
                {glyph}
              </span>
              <span style={{ color: 'var(--fg, #e8e8ea)' }}>
                <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: 'var(--fg-mute, #94a3b8)', marginRight: 6 }}>
                  {c.chunkId.split('-').pop()}.
                </code>
                {c.description}
                {c.files.length > 0 && (
                  <span style={{ color: 'var(--fg-dim, #6b7280)', fontSize: 11, marginLeft: 8 }}>
                    {c.files.length === 1 ? c.files[0] : `${c.files.length} files`}
                  </span>
                )}
              </span>
              {c.commitSha && (
                <code
                  style={{
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 10.5,
                    color: 'var(--fg-mute, #94a3b8)',
                  }}
                  title={`commit ${c.commitSha}`}
                >
                  {c.commitSha.slice(0, 7)}
                </code>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
