import { describe, it, expect } from 'vitest';
import {
  formatFor,
  stateDirFor,
  gitFilePath,
  sanitizeKey,
  serializeRow,
  parseFile,
  hasRefreshStamps,
  isRefreshOnlyChange,
} from './serialize';

describe('git-export serialize (P-003b foundation)', () => {
  it('picks md for prose tables, json otherwise', () => {
    expect(formatFor('harness_decisions')).toBe('md');
    expect(formatFor('harness_shared.harness_text_artifacts')).toBe('md');
    expect(formatFor('harness_chunk_plans')).toBe('json');
    expect(formatFor('feature_audit_consolidated')).toBe('json');
  });

  it('maps state dirs (kebab default + §7.2 overrides)', () => {
    expect(stateDirFor('harness_decisions')).toBe('.papercusp/state/decisions');
    expect(stateDirFor('harness_design_artifacts')).toBe('.papercusp/state/design');
    expect(stateDirFor('feature_audit_consolidated')).toBe('.papercusp/state/feature-audit');
    expect(stateDirFor('harness_feature_notes')).toBe('.papercusp/state/feature-notes');
  });

  it('builds safe file paths', () => {
    expect(gitFilePath('harness_decisions', 'D-001')).toBe('.papercusp/state/decisions/D-001.md');
    expect(gitFilePath('harness_chunk_plans', 'feature:F-1/chunk:c2')).toBe(
      '.papercusp/state/chunk-plans/feature_F-1_chunk_c2.json',
    );
  });

  it('sanitizeKey neutralizes path-unsafe chars + leading dots', () => {
    expect(sanitizeKey('a/b:c')).toBe('a_b_c');
    expect(sanitizeKey('../escape')).toBe('__escape'); // leading `..` traversal neutralized
  });

  it('round-trips a structured (json) row', () => {
    const row = { feature_id: 'F-1', chunk: 2, tags: ['a', 'b'], meta: { x: 1 }, done: false, n: null };
    const back = parseFile('harness_chunk_plans', serializeRow('harness_chunk_plans', row));
    expect(back).toEqual(row);
  });

  it('round-trips a prose (md) row with frontmatter + body', () => {
    const row = {
      id: 'D-001',
      created_ts: 1730000000000,
      tags: ['arch', 'storage'],
      content: '# Decision\n\nWe use **PG** as the runtime store-of-record.\n\n- point one\n- point two',
    };
    const file = serializeRow('harness_decisions', row);
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('_body: "content"');
    expect(parseFile('harness_decisions', file)).toEqual(row);
  });

  it('round-trips a prose row with no body field (frontmatter only)', () => {
    const row = { id: 'x', n: 3 };
    expect(parseFile('harness_skills', serializeRow('harness_skills', row))).toEqual(row);
  });

  it('serializes deterministically (sorted keys → clean diffs)', () => {
    const a = serializeRow('harness_chunk_plans', { b: 1, a: 2 });
    const b = serializeRow('harness_chunk_plans', { a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('strips context/provenance cols (workspace_id/harness_slug/origin) from the file', () => {
    const back = parseFile(
      'harness_chunk_plans',
      serializeRow('harness_chunk_plans', {
        workspace_id: 'ws1',
        harness_slug: 'h',
        origin: 'local',
        feature_id: 'F-1',
        chunk: 2,
      }),
    );
    expect(back).toEqual({ feature_id: 'F-1', chunk: 2 }); // context cols gone from the file
  });
});

describe('isRefreshOnlyChange (WI-10003624)', () => {
  const T = 'harness_escalations';
  const verdict = { kind: 'git-sync-conflict', scope: 'papercusp', detail: 'conflicted', emitted_at: 1000 };
  const row = (escalation: unknown, mtime: number) => ({
    harness_slug: 'hello-world-3-pot',
    workspace_id: 'ws',
    phase: 'git-sync',
    escalation,
    mtime_ms: mtime,
  });
  const committed = serializeRow(T, row(JSON.stringify(verdict), 1000));

  it('ignores a re-stamp of an unchanged verdict (mtime_ms + emitted_at only)', () => {
    expect(hasRefreshStamps(T)).toBe(true);
    expect(isRefreshOnlyChange(T, committed, row(JSON.stringify({ ...verdict, emitted_at: 9999 }), 9999))).toBe(true);
    // jsonb object vs text JSON of the same verdict compare equal.
    expect(isRefreshOnlyChange(T, committed, row({ ...verdict, emitted_at: 5 }, 5))).toBe(true);
    // camelCase stamp variant.
    const camel = serializeRow(T, row({ kind: 'k', emittedAt: 1 }, 1));
    expect(isRefreshOnlyChange(T, camel, row({ kind: 'k', emittedAt: 2 }, 2))).toBe(true);
  });

  it('still writes a real change, a clear, a new file, or an unparseable one', () => {
    expect(isRefreshOnlyChange(T, committed, row(JSON.stringify({ ...verdict, detail: 'new' }), 2000))).toBe(false);
    expect(isRefreshOnlyChange(T, committed, row(null, 2000))).toBe(false);
    expect(isRefreshOnlyChange(T, null, row(JSON.stringify(verdict), 2000))).toBe(false);
    expect(isRefreshOnlyChange(T, 'not frontmatter', row(JSON.stringify(verdict), 2000))).toBe(false);
  });

  it('never applies to tables without refresh stamps', () => {
    const D = 'harness_decisions';
    const r = { id: 'D-1', title: 't', content: 'c', mtime_ms: 1 };
    expect(hasRefreshStamps(D)).toBe(false);
    expect(isRefreshOnlyChange(D, serializeRow(D, r), { ...r, mtime_ms: 2 })).toBe(false);
  });
});
