/**
 * Unit coverage for the pure row-mapper in `runs.ts`
 * (plan-agent-launch-2026-05-21, Phase 3).
 *
 * `mapPlanRunRow` is pure. The DAL functions around it (`insertPlanRun`,
 * `getPlanRun`, `listPlanRuns`, …) are heavy IO — exercised live in
 * P-027 / P-028.
 */

import { describe, expect, it } from 'vitest';
import {
  canManuallyRestatusRun,
  clampTranscriptLimit,
  escapeLikePattern,
  mapPlanRunRow,
  PLAN_RUN_IDLE_ARCHIVE_MS,
  PLAN_RUN_ORPHAN_FAIL_MS,
  TRANSCRIPT_DEFAULT_LIMIT,
  TRANSCRIPT_MAX_LIMIT,
  type PlanRunStatus,
  type RawPlanRunRow,
} from '../runs';

const rawRow: RawPlanRunRow = {
  id: 7,
  plan_slug: 'plan-agent-launch-2026-05-21',
  plan_content_hash: 'deadbeef',
  session_id: '11111111-2222-3333-4444-555555555555',
  note: 'advance phase 3',
  launched_by: 'pus-abcdefab-cdef',
  launched_at: 1_716_000_000_000,
  status: 'idle',
  title: 'advance phase 3',
  updated_at: 1_716_000_005_000,
};

describe('mapPlanRunRow', () => {
  it('maps snake_case columns to the camelCased PlanRunRow', () => {
    const row = mapPlanRunRow(rawRow);
    expect(row).toEqual({
      id: 7,
      planSlug: 'plan-agent-launch-2026-05-21',
      planContentHash: 'deadbeef',
      sessionId: '11111111-2222-3333-4444-555555555555',
      note: 'advance phase 3',
      launchedBy: 'pus-abcdefab-cdef',
      launchedAt: 1_716_000_000_000,
      status: 'idle',
      title: 'advance phase 3',
      updatedAt: 1_716_000_005_000,
      // Run-metadata columns (plan-run lifecycle extension) — absent in this
      // legacy rawRow fixture, so the mapper emits their defaults.
      runType: 'interactive',
      trigger: null,
      outcome: null,
      finishedAt: null,
      runSeq: null,
      instancePlanSlug: null,
      durationMs: null,
    });
  });

  it('coerces BIGINT columns delivered as strings into numbers', () => {
    // PG returns BIGSERIAL / BIGINT columns as strings — the mapper's
    // Number() coercion is load-bearing.
    const row = mapPlanRunRow({
      ...rawRow,
      id: '42',
      launched_at: '1716000000000',
      updated_at: '1716000005000',
    });
    expect(row.id).toBe(42);
    expect(row.launchedAt).toBe(1_716_000_000_000);
    expect(row.updatedAt).toBe(1_716_000_005_000);
    expect(typeof row.id).toBe('number');
  });

  it('preserves a null note and null title', () => {
    const row = mapPlanRunRow({ ...rawRow, note: null, title: null });
    expect(row.note).toBeNull();
    expect(row.title).toBeNull();
  });
});

describe('canManuallyRestatusRun (P-016)', () => {
  it('rejects a manual restatus of a running run', () => {
    // A running run is mid-turn — restatus would race the turn settle.
    expect(canManuallyRestatusRun('running')).toBe(false);
  });

  it('allows a manual restatus of every settled status', () => {
    const settled: PlanRunStatus[] = ['idle', 'archived', 'done', 'failed'];
    for (const s of settled) {
      expect(canManuallyRestatusRun(s)).toBe(true);
    }
  });
});

describe('run-status sweep thresholds (P-016)', () => {
  it('fails an orphan well before it would be archived', () => {
    // The orphan-fail window must be far shorter than the idle-archive
    // window — a crashed run should heal to `failed` long before any
    // idle run is decluttered.
    expect(PLAN_RUN_ORPHAN_FAIL_MS).toBeLessThan(PLAN_RUN_IDLE_ARCHIVE_MS);
  });

  it('keeps the orphan window clear of the ~10-min turn timeout', () => {
    // A legitimate turn caps at the tool's 600s timeout; the orphan
    // window must sit comfortably beyond it to avoid false positives.
    expect(PLAN_RUN_ORPHAN_FAIL_MS).toBeGreaterThan(15 * 60_000);
  });
});

describe('clampTranscriptLimit (P-008)', () => {
  it('defaults when the limit is absent or non-numeric', () => {
    for (const bad of [undefined, null, NaN, Infinity, -Infinity]) {
      expect(clampTranscriptLimit(bad as number)).toBe(TRANSCRIPT_DEFAULT_LIMIT);
    }
  });

  it('floors a fractional limit', () => {
    expect(clampTranscriptLimit(20.9)).toBe(20);
  });

  it('clamps below 1 up to 1', () => {
    expect(clampTranscriptLimit(0)).toBe(1);
    expect(clampTranscriptLimit(-5)).toBe(1);
  });

  it('clamps above the max down to the max', () => {
    expect(clampTranscriptLimit(200)).toBe(TRANSCRIPT_MAX_LIMIT);
  });

  it('passes an in-range limit through', () => {
    expect(clampTranscriptLimit(50)).toBe(50);
  });
});

describe('escapeLikePattern (P-008)', () => {
  it('leaves a plain query untouched', () => {
    expect(escapeLikePattern('refactor the runner')).toBe('refactor the runner');
  });

  it('escapes LIKE wildcards so the query matches literally', () => {
    expect(escapeLikePattern('50%')).toBe('50\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('c:\\path')).toBe('c:\\\\path');
  });
});
