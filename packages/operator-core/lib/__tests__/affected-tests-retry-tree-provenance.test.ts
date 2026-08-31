/**
 * Recurrence guard for WI-1734042.
 *
 * A retry may pass because the first attempt saw a different working tree. The
 * classifier must reject that as a FLAKE, and must also reject unreadable
 * snapshots rather than manufacturing a green attribution.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyRetryTreeProvenance,
  formatRetryTreeProvenanceNotice,
  parseRetryTreeStatus,
  snapshotRetryTree,
  RETRY_TREE_PROVENANCE_TOKEN,
} from '../../../../scripts/lib/retry-tree-provenance.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const snapshot = (over: Record<string, unknown> = {}) => ({
  known: true,
  head: 'aaa',
  digest: 'digest-a',
  changedPaths: [],
  reason: null,
  ...over,
});

describe('classifyRetryTreeProvenance', () => {
  it('accepts a retry as a flake only when HEAD and working-tree digest are stable', () => {
    expect(classifyRetryTreeProvenance(snapshot(), snapshot())).toEqual({
      classification: 'flake',
      reason: 'tree-stable',
    });
  });

  it('catches a dirty-to-dirty content change that a status-only control misses', () => {
    const before = snapshot({ changedPaths: ['scripts/subject.mjs'], digest: 'dirty-v1' });
    const after = snapshot({ changedPaths: ['scripts/subject.mjs'], digest: 'dirty-v2' });
    const statusOnlyControl = (a: typeof before, b: typeof after) =>
      a.changedPaths.join('\0') !== b.changedPaths.join('\0');

    expect(statusOnlyControl(before, after)).toBe(false);
    expect(classifyRetryTreeProvenance(before, after)).toEqual({
      classification: 'tree-changed',
      reason: 'working-tree-changed',
    });
  });

  it('catches a commit between attempts even when the dirty path set is empty', () => {
    expect(
      classifyRetryTreeProvenance(snapshot(), snapshot({ head: 'bbb' })),
    ).toEqual({ classification: 'tree-changed', reason: 'head-changed' });
  });

  it('fails closed when either snapshot is unreadable', () => {
    expect(
      classifyRetryTreeProvenance(snapshot(), snapshot({ known: false, reason: 'status-unreadable' })),
    ).toEqual({ classification: 'provenance-unknown', reason: 'snapshot-unreadable' });
    expect(classifyRetryTreeProvenance(null, snapshot()).classification).toBe('provenance-unknown');
  });

  it('formats a machine-readable notice for non-flake attribution', () => {
    expect(formatRetryTreeProvenanceNotice({
      workspace: 'operator-core',
      classification: 'provenance-unknown',
      reason: 'status-unreadable',
    })).toBe(
      `${RETRY_TREE_PROVENANCE_TOKEN} workspace="operator-core" ` +
        'classification=provenance-unknown reason=status-unreadable',
    );
  });
});

describe('snapshotRetryTree', () => {
  it('parses NUL-delimited status and retains rename source paths', () => {
    expect(parseRetryTreeStatus(Buffer.from('R  new.mjs\0old.mjs\0?? added.mjs\0'))).toEqual([
      { status: 'R ', path: 'new.mjs' },
      { status: 'R :source', path: 'old.mjs' },
      { status: '??', path: 'added.mjs' },
    ]);
  });

  it('reads a real repository snapshot without hashing the clean tree', () => {
    const current = snapshotRetryTree(REPO_ROOT);
    expect(current.known).toBe(true);
    expect(current.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(current.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('affected-tests.mjs wiring', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');

  it('snapshots before task execution and compares the snapshot before retry', () => {
    expect(source).toContain('snapshotRetryTree(ROOT)');
    expect(source).toContain('classifyRetryTreeProvenance(');
    expect(source).toContain('formatRetryTreeProvenanceNotice({');
  });

  it('keeps changed or unknown retry provenance from claiming FLAKE absorption', () => {
    expect(source).toContain('classification !== "flake"');
    expect(source).toContain('retaining the initial failure');
  });
});
