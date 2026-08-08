import { describe, it, expect } from 'vitest';
import { derivedColumnsFrom, isDerivedColumnType, stripDerivedCols } from './derived-cols';

/**
 * Regression guard for EI-19900345996596896 — 17/17 hives failed `[git-export]` boot
 * with `expected 768 dimensions, not 384`, because committed state files carried a
 * stale-width `body_embedding` and one throw aborted the whole hive's hydrate (so it
 * never reached `startGitExportDrain`; 1,166 outbox rows went undrained).
 *
 * FALSIFIABILITY (CLAUDE.md § proving a guard is falsifiable, tier 1): the subject is
 * an importable module, so the deliberately-wrong implementation lives HERE, permanently,
 * as a control — the shared tree is never mutated to prove the guard can fail. The
 * control is the tempting name-anchored rule; the cases below are chosen precisely
 * because they SEPARATE it from the schema-anchored real one. If a future edit makes the
 * real implementation match on names, the two "control disagrees" tests go red.
 */
const NAME_ANCHORED_CONTROL = (cols: readonly { column_name: string }[]): Set<string> =>
  new Set(cols.filter((c) => c.column_name.endsWith('_embedding')).map((c) => c.column_name));

describe('git-export derived-cols (EI-19900345996596896)', () => {
  it('classifies by live PG type, not by column name', () => {
    expect(isDerivedColumnType('vector')).toBe(true);
    expect(isDerivedColumnType('text')).toBe(false);
    expect(isDerivedColumnType(null)).toBe(false);
    expect(isDerivedColumnType(undefined)).toBe(false);
  });

  // CALIBRATION — the real, live shape. If this fails, the discriminating cases below
  // prove nothing, because the property itself is broken.
  it('strips the real harness_escalations shape (body_embedding vector(768))', () => {
    const schema = [
      { column_name: 'id', udt_name: 'text' },
      { column_name: 'body', udt_name: 'text' },
      { column_name: 'body_embedding', udt_name: 'vector' },
    ];
    expect([...derivedColumnsFrom(schema)]).toEqual(['body_embedding']);
    expect(NAME_ANCHORED_CONTROL(schema).has('body_embedding')).toBe(true); // both agree here
  });

  it('does NOT strip a text column merely named *_embedding (control disagrees)', () => {
    const schema = [
      { column_name: 'id', udt_name: 'text' },
      // A prose column that happens to carry the suffix — stripping it would silently
      // delete real document content on every export.
      { column_name: 'notes_embedding', udt_name: 'text' },
    ];
    expect(derivedColumnsFrom(schema).size).toBe(0);
    // The name-anchored control gets this WRONG — which is what makes the case load-bearing.
    expect(NAME_ANCHORED_CONTROL(schema).has('notes_embedding')).toBe(true);
  });

  it('DOES strip a vector column not named *_embedding (control disagrees)', () => {
    const schema = [
      { column_name: 'id', udt_name: 'text' },
      { column_name: 'vec', udt_name: 'vector' },
    ];
    expect([...derivedColumnsFrom(schema)]).toEqual(['vec']);
    // The name-anchored control MISSES it — the exact false negative that would let a
    // stale-width vector back into a committed file and re-break hydrate fleet-wide.
    expect(NAME_ANCHORED_CONTROL(schema).has('vec')).toBe(false);
  });

  it('drops the stale-width vector from a legacy file row, keeping everything else', () => {
    const derived = derivedColumnsFrom([
      { column_name: 'id', udt_name: 'text' },
      { column_name: 'body', udt_name: 'text' },
      { column_name: 'body_embedding', udt_name: 'vector' },
    ]);
    // Shaped like the real committed frontmatter: a 384-dim pgvector text literal
    // against a vector(768) column — the value that threw on every boot.
    const legacyRow = {
      id: 'git-sync-content',
      body: 'escalation body',
      body_embedding: `[${Array.from({ length: 384 }, () => '0.1').join(',')}]`,
    };
    const out = stripDerivedCols(legacyRow, derived);
    expect(out).toEqual({ id: 'git-sync-content', body: 'escalation body' });
    expect('body_embedding' in out).toBe(false);
    expect(legacyRow.body_embedding).toBeTypeOf('string'); // input not mutated
  });

  it('returns the same object when there is nothing to strip', () => {
    const row = { id: 'a', body: 'b' };
    expect(stripDerivedCols(row, new Set())).toBe(row);
    expect(stripDerivedCols(row, new Set(['body_embedding']))).toBe(row);
  });
});
