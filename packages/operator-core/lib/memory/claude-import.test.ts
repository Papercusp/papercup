/**
 * planImport (memory-pg-lexical-own-injection-2026-07-13 P-004) — the pure
 * skip/import decision table for the topic-file → canonical migration. The
 * load-bearing rules: link_id projections are never re-imported (live →
 * already stored; dead → a deliberate forget, not resurrected), re-runs
 * no-op via imported_from, and unscoped files land in the OWNER pool (the
 * live search fan-out never queries 'local').
 */
import { describe, expect, it } from 'vitest';

import type { TopicFile } from '@papercusp/memory';
import { bodyKey, importedFromKey, importText, planImport } from './claude-import';

const OWNER = '120f421b-owner-pool';

function tf(over: Partial<TopicFile> = {}): TopicFile {
  return {
    name: 'feedback_some_lesson',
    description: 'A lesson',
    type: 'feedback',
    body: 'The lesson body.',
    ...over,
  } as TopicFile;
}

function plan(candidates: Array<{ file: string; tf: TopicFile }>, over: Record<string, unknown> = {}) {
  return planImport({
    candidates,
    existingCanonicalIds: new Set<string>(),
    alreadyImported: new Set<string>(),
    defaultScope: OWNER,
    ...over,
  });
}

describe('planImport', () => {
  it('skips a link_id projection whose canonical row EXISTS (already stored)', () => {
    const p = plan(
      [{ file: 'a.md', tf: tf({ extra: { link_id: 'live-id' } }) }],
      { existingCanonicalIds: new Set(['live-id']) },
    );
    expect(p.imports).toHaveLength(0);
    expect(p.skippedLinked).toBe(1);
    expect(p.ghosts).toHaveLength(0);
  });

  it('a link_id whose canonical row is GONE is a GHOST — reported, never resurrected', () => {
    const p = plan([{ file: 'ghost.md', tf: tf({ extra: { link_id: 'deleted-id' } }) }]);
    expect(p.imports).toHaveLength(0);
    expect(p.ghosts).toEqual(['ghost.md']);
  });

  it('re-runs no-op: an imported_from already in the store is skipped', () => {
    const p = plan(
      [{ file: 'done.md', tf: tf() }],
      { alreadyImported: new Set([importedFromKey('done.md')]) },
    );
    expect(p.imports).toHaveLength(0);
    expect(p.skippedImported).toBe(1);
  });

  it('an unscoped file imports under the OWNER pool, a scoped one keeps its scope', () => {
    const p = plan([
      { file: 'unscoped.md', tf: tf() },
      { file: 'scoped.md', tf: tf({ scope: 'harness:papercusp' }) },
    ]);
    expect(p.imports.map((i) => i.scope)).toEqual([OWNER, 'harness:papercusp']);
  });

  it('carries name/description/type into metadata (the P-002 lexical fields) + the idempotency key, and DROPS link_id', () => {
    const p = plan([
      { file: 'x.md', tf: tf({ kind: 'feedback', extra: { source: 'pack', link_id: undefined } }) },
    ]);
    const m = p.imports[0].metadata;
    expect(m.name).toBe('feedback_some_lesson');
    expect(m.description).toBe('A lesson');
    expect(m.type).toBe('feedback');
    expect(m.imported_from).toBe(importedFromKey('x.md'));
    expect(m.source).toBe('pack');
    expect('link_id' in m).toBe(false);
    expect(p.imports[0].kind).toBe('feedback');
  });

  it('kind falls back to the Claude type when no neutral kind is stored', () => {
    const p = plan([{ file: 'x.md', tf: tf({ kind: undefined, type: 'reference' }) }]);
    expect(p.imports[0].kind).toBe('reference');
  });

  it('exact-dup guard: an identical body already in the target scope is skipped', () => {
    const p = plan(
      [{ file: 'dup.md', tf: tf() }],
      { existingBodies: new Set([bodyKey(OWNER, 'The lesson body.')]) },
    );
    expect(p.imports).toHaveLength(0);
    expect(p.skippedExactDup).toBe(1);
  });

  it('an empty body falls back to the description; empty both is skipped', () => {
    expect(importText(tf({ body: '  ' }))).toBe('A lesson');
    const p = plan([{ file: 'empty.md', tf: tf({ body: ' ', description: '' }) }]);
    expect(p.imports).toHaveLength(0);
    expect(p.skippedEmpty).toBe(1);
  });
});
