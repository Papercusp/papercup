import { describe, expect, it } from 'vitest';
import {
  VAL_BLOCK_HEADER_LINE_RE,
  VAL_RETIREMENT_REFUSAL_CODES,
  findValBlocks,
  valRetirementRefusal,
  type ValRetirementRefusalCode,
} from './val-retirement';
import { VAL_BLOCK_HEADER_PG_PATTERN } from '../../verification-health';

const PLAN = [
  '# Plan',
  'Prose that mentions [VAL-x-001] is not a block.',
  '- **P-001** `todo` First item.',
  '  - **[VAL-plan-001]**',
  '    - **Verify:** it works',
  '- **P-002** `todo` Second item.',
  '  - [VAL-plan-002] scoper-written form',
  '- **P-003** `todo` Third item, malformed block.',
  '    - **[VAL-',
  '- **P-004** `todo` No block.',
].join('\n');

describe('VAL-* retirement refusal codes', () => {
  it('exports exactly the three typed refusal codes', () => {
    const codes: readonly ValRetirementRefusalCode[] = VAL_RETIREMENT_REFUSAL_CODES;
    expect([...codes].sort()).toEqual(['val-block-retired', 'val-read-retired', 'val-write-retired']);
  });

  it.each(VAL_RETIREMENT_REFUSAL_CODES)('builds a typed refusal for %s', (code) => {
    const r = valRetirementRefusal(code, 'detail here');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(r.successor).toBe('requirement-contract');
    expect(r.message).toContain(code);
    expect(r.message).toContain('detail here');
    expect(r.repair.length).toBeGreaterThan(0);
    expect(r.httpStatus).toBe(code === 'val-block-retired' ? 409 : 410);
    // The P-003 census forbids naming the legacy store anywhere in non-test source;
    // the refusal text must not reintroduce it.
    expect(r.message).not.toMatch(/harness_plan_assert/);
  });
});

describe('findValBlocks', () => {
  it('finds header-shaped blocks, including malformed ones, and ignores prose mentions', () => {
    const blocks = findValBlocks(PLAN);
    expect(blocks.map((b) => [b.planItemId, b.valId])).toEqual([
      ['P-001', 'VAL-plan-001'],
      ['P-002', 'VAL-plan-002'],
      ['P-003', 'VAL-'],
    ]);
    expect(blocks[0].line).toBe(4);
  });

  it('scopes to the requested items', () => {
    expect(findValBlocks(PLAN, new Set(['P-002', 'P-004'])).map((b) => b.planItemId)).toEqual([
      'P-002',
    ]);
    expect(findValBlocks(PLAN, new Set(['P-004']))).toEqual([]);
  });

  it('agrees with the health-cell census pattern on every fixture line', () => {
    // The live census (verification-health) and the promotion gate must call the
    // same lines blocks, or the cell could read 0 while promotion still refuses.
    const pg = new RegExp(VAL_BLOCK_HEADER_PG_PATTERN);
    for (const line of PLAN.split('\n')) {
      expect(VAL_BLOCK_HEADER_LINE_RE.test(line)).toBe(pg.test(line));
    }
    expect(pg.test(PLAN)).toBe(true);
    expect(pg.test('Prose that mentions [VAL-x-001] only.')).toBe(false);
  });
});
