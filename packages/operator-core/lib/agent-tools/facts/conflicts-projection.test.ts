/**
 * facts:conflicts — the pure projection half (P-011 / D-087).
 *
 * The detection logic is `agent-facts/conflicts.test.ts`; the real-PG read is
 * `agent-facts/store.integration.test.ts`. This file pins the two things a
 * projection can get wrong on its own: the CITATION grammar (a wrong ref is
 * declarable but never resolvable) and the payload diet.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/facts/conflicts-projection.test.ts
 */
import { describe, expect, it } from 'vitest';
import { CONFLICT_BODY_EXCERPT_CHARS, projectConflict } from './conflicts';
import { parseAssumptionRef } from '../../agent-facts/assumptions';
import type { AssumptionConflict } from '../../agent-facts/conflicts';

function side(over: Partial<AssumptionConflict['a']> = {}): AssumptionConflict['a'] {
  return {
    scope: 'owner',
    scopeRef: 'su-a',
    key: 'gate-reds',
    id: 42,
    createdBy: 'su-a',
    updatedAt: '2026-07-27T12:00:00.000Z',
    assertion: 'unrelated to my change',
    body: 'the gate reds are not mine',
    ...over,
  };
}

function conflict(over: Partial<AssumptionConflict> = {}): AssumptionConflict {
  return {
    referent: 'cell:gate.greenCheckpoint.verdict',
    referentKind: 'claim-subject',
    a: side(),
    b: side({ scopeRef: 'su-b', createdBy: 'su-b', id: 43, assertion: 'caused by my change' }),
    sameAuthor: false,
    ...over,
  };
}

describe('projectConflict — the citation grammar', () => {
  it('emits refs the fact layer can PARSE BACK, for every scope shape', () => {
    const owner = projectConflict(conflict(), true).a as Record<string, unknown>;
    expect(owner.ref).toBe('fact:owner:su-a:gate-reds@v42');
    expect(parseAssumptionRef(String(owner.ref))).toMatchObject({
      scope: 'owner',
      scopeRef: 'su-a',
      key: 'gate-reds',
      versionId: 42,
      absolute: true,
    });

    // The one that a hand-rolled `${scope}:${ref}:${key}` template gets wrong:
    // workspace scope carries NO ref segment, and `fact:workspace::k` does not parse.
    const ws = projectConflict(
      conflict({ a: side({ scope: 'workspace', scopeRef: null, key: 'k' }) }),
      true,
    ).a as Record<string, unknown>;
    expect(ws.ref).toBe('fact:workspace:k@v42');
    expect(parseAssumptionRef(String(ws.ref))).toMatchObject({ scope: 'workspace', key: 'k' });
  });

  it('omits the @v pin when the row carried no version id, and still parses', () => {
    const p = projectConflict(conflict({ a: side({ id: null }) }), true).a as Record<string, unknown>;
    expect(p.ref).toBe('fact:owner:su-a:gate-reds');
    expect(parseAssumptionRef(String(p.ref))).toMatchObject({ versionId: null, absolute: true });
  });
});

describe('projectConflict — payload diet and naming', () => {
  it('excerpts long bodies by default, disclosing the cut', () => {
    const body = 'x'.repeat(CONFLICT_BODY_EXCERPT_CHARS + 50);
    const p = projectConflict(conflict({ a: side({ body }) }), false).a as Record<string, unknown>;
    expect(String(p.body)).toHaveLength(CONFLICT_BODY_EXCERPT_CHARS + 1); // + the ellipsis
    expect(p.body_truncated).toBe(true);
    expect(p.body_full_chars).toBe(body.length);
  });

  it('returns bodies whole with full:true, and discloses nothing', () => {
    const body = 'y'.repeat(CONFLICT_BODY_EXCERPT_CHARS + 50);
    const p = projectConflict(conflict({ a: side({ body }) }), true).a as Record<string, unknown>;
    expect(p.body).toBe(body);
    expect(p.body_truncated).toBeUndefined();
  });

  it('names the KIND of conflict — self-contradiction and disagreement need different fixes', () => {
    expect(projectConflict(conflict({ sameAuthor: true }), false).conflictKind).toBe('self-contradiction');
    expect(projectConflict(conflict({ sameAuthor: false }), false).conflictKind).toBe('cross-agent');
  });

  it('keeps the compared assertions on both sides — the excerpt is never the evidence', () => {
    const p = projectConflict(conflict(), false);
    expect((p.a as Record<string, unknown>).assertion).toBe('unrelated to my change');
    expect((p.b as Record<string, unknown>).assertion).toBe('caused by my change');
    expect(p.referent).toBe('cell:gate.greenCheckpoint.verdict');
  });
});
