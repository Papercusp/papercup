/**
 * Unit coverage for the P-021 pure helpers — the AgentsPanel.
 *
 * `pickOriginRevision` is load-bearing: the origin card sources from
 * it, and the `plans:revisions` list is newest-first so the origin
 * lives at the END of the array. `isStaleAgainst` decides whether
 * the ⚠ stale badge shows on a past-run row (D-018). The two label
 * formatters strip email domains so the row stays scannable.
 */
import { describe, expect, it } from 'vitest';
import {
  describeRunStatus,
  formatOriginAuthor,
  formatRunLaunchedBy,
  isStaleAgainst,
  launchErrorLabel,
  pickOriginRevision,
} from './AgentsPanel';
import type { PlanRevision, PlanRun } from './plans-api';

const baseRev: PlanRevision = {
  id: 0,
  seq: 0,
  contentHash: '',
  rationale: null,
  authorKind: 'agent',
  authorId: '',
  sessionId: null,
  sessionKind: null,
  createdAt: 0,
  diffStat: { added: 0, removed: 0 },
};

const rev = (id: number, seq: number): PlanRevision => ({
  ...baseRev,
  id,
  seq,
});

const baseRun: PlanRun = {
  id: 1,
  planSlug: 'plan-x',
  planContentHash: 'h1',
  sessionId: 's1',
  note: null,
  launchedBy: 'a',
  launchedAt: 0,
  status: 'idle',
  title: null,
  updatedAt: 0,
  turnCount: 0,
};

describe('pickOriginRevision', () => {
  it('empty list → null', () => {
    expect(pickOriginRevision([])).toBeNull();
  });

  it('newest-first list → returns the seq-1 row at the end', () => {
    const r = pickOriginRevision([rev(3, 3), rev(2, 2), rev(1, 1)]);
    expect(r?.seq).toBe(1);
    expect(r?.id).toBe(1);
  });

  it('no seq-1 in the list → null (defensive: spine not backfilled)', () => {
    expect(pickOriginRevision([rev(5, 5), rev(4, 4)])).toBeNull();
  });

  it('single revision that IS seq 1 → that one', () => {
    const r = pickOriginRevision([rev(7, 1)]);
    expect(r?.id).toBe(7);
  });
});

describe('isStaleAgainst', () => {
  it('matching hashes → not stale', () => {
    expect(isStaleAgainst({ ...baseRun, planContentHash: 'h1' }, 'h1')).toBe(false);
  });

  it('different hashes → stale', () => {
    expect(isStaleAgainst({ ...baseRun, planContentHash: 'h1' }, 'h2')).toBe(true);
  });

  it('missing currentHash → not stale (no spurious warning)', () => {
    expect(isStaleAgainst({ ...baseRun, planContentHash: 'h1' }, undefined)).toBe(false);
  });

  it('missing run hash → not stale (incomplete data)', () => {
    expect(isStaleAgainst({ ...baseRun, planContentHash: '' }, 'h1')).toBe(false);
  });
});

describe('formatOriginAuthor', () => {
  it('human + email → local part', () => {
    const r = { ...baseRev, authorKind: 'human' as const, authorId: 'avi@example.com' };
    expect(formatOriginAuthor(r)).toBe('avi');
  });

  it('agent + dash id → first two chunks', () => {
    const r = { ...baseRev, authorKind: 'agent' as const, authorId: 'pus-abc123-def' };
    expect(formatOriginAuthor(r)).toBe('pus-abc123');
  });
});

describe('formatRunLaunchedBy', () => {
  it('email → local part', () => {
    expect(formatRunLaunchedBy('avi@example.com')).toBe('avi');
  });

  it('long id → truncated with ellipsis', () => {
    expect(formatRunLaunchedBy('a'.repeat(40))).toBe(`${'a'.repeat(24)}…`);
  });

  it('short id → passthrough', () => {
    expect(formatRunLaunchedBy('short-id')).toBe('short-id');
  });
});

describe('describeRunStatus', () => {
  it('returns a distinct phrase for every status', () => {
    const all = ['running', 'idle', 'done', 'archived', 'failed'] as const;
    const phrases = all.map(describeRunStatus);
    expect(new Set(phrases).size).toBe(all.length);
  });
});

describe('launchErrorLabel', () => {
  it('not_found → plan-not-found phrasing', () => {
    expect(launchErrorLabel({ error: 'not_found' })).toMatch(/not found/i);
  });

  it('busy + holder → names the holder + intent', () => {
    expect(
      launchErrorLabel({
        error: 'busy',
        busy: [{ owner_label: 'OMP/Codex', intent: 'fixing typo' }],
      }),
    ).toBe('Plan busy — OMP/Codex (fixing typo)');
  });

  it('busy without intent → holder only', () => {
    expect(
      launchErrorLabel({ error: 'busy', busy: [{ owner_label: 'OMP/Codex' }] }),
    ).toBe('Plan busy — OMP/Codex');
  });

  it('busy without holder array → generic fallback', () => {
    expect(launchErrorLabel({ error: 'busy' })).toMatch(/launch failed: busy/i);
  });

  it('unknown error code → "Launch failed: <code>"', () => {
    expect(launchErrorLabel({ error: 'wat' })).toBe('Launch failed: wat');
  });

  it('missing error key → generic', () => {
    expect(launchErrorLabel({})).toBe('Launch failed: launch_failed');
  });
});
