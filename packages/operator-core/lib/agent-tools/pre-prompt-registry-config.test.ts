/**
 * pre-prompt-registry-config.test.ts — the host config of which tools get Tier-3
 * prompt-declared column schemas. Two load-bearing invariants: (1) entry names are
 * UNIQUE (the registry is keyed by name; a dup makes lookup ambiguous), and (2) the
 * work_items:* write candidates stay GATED `write:'off'` — flipping them to
 * positional before the P-013 emit-correctness gate would let a swapped row write
 * wrong-but-valid data (D-007), since their misalignment guard is arity-only. This
 * test fails loudly if someone flips that default prematurely.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pre-prompt-registry-config.test.ts
 */
import { describe, expect, it } from 'vitest';
import { PRE_PROMPT_REGISTRY } from './pre-prompt-registry-config';

describe('PRE_PROMPT_REGISTRY', () => {
  it('has unique, non-empty entry names', () => {
    const names = PRE_PROMPT_REGISTRY.map((e) => e.name);
    for (const n of names) expect(typeof n === 'string' && n.length > 0).toBe(true);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it('keeps the work_items:* write candidates GATED off (D-007 safety until P-013)', () => {
    for (const name of ['work_items:set_state', 'work_items:claim']) {
      const e = PRE_PROMPT_REGISTRY.find((x) => x.name === name);
      expect(e, name).toBeDefined();
      // The safety gate: NOT flipped to positional. A regression that sets
      // write:'positional' here (before the enum/regex guard exists) is the exact
      // wrong-data-write risk this pins.
      expect(e?.write).not.toBe('positional');
    }
  });

  it('activates the audit:list read path (the one clean flat-row read)', () => {
    expect(PRE_PROMPT_REGISTRY.find((e) => e.name === 'audit:list')?.read).toBe('csv');
  });
});
