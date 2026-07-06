/**
 * pre-prompt-registry-config.test.ts — the host config of which tools get Tier-3
 * prompt-declared column schemas. Two load-bearing invariants: (1) entry names are
 * UNIQUE (the registry is keyed by name; a dup makes lookup ambiguous), and (2) the
 * work_items:* write defaults are `write:'positional'` — LIVE since 2026-07-06,
 * when the P-013 emit-correctness gate passed (su-S07 verdict=pass with a distinct
 * judge, positional assert 6/6; su-S08 3/3 — see
 * definetool-token-reduction-uncovered-surfaces-2026-07-06 P-001/P-002). This test
 * now pins the flipped default so a silent regression back to 'off' (losing the
 * ~4-5× output-token write win) fails loudly.
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

  it('keeps the work_items:* write defaults POSITIONAL (P-013 gate passed 2026-07-06)', () => {
    for (const name of ['work_items:set_state', 'work_items:claim']) {
      const e = PRE_PROMPT_REGISTRY.find((x) => x.name === name);
      expect(e, name).toBeDefined();
      // The gate passed (su-S07 pass w/ distinct judge; positional assert 6/6;
      // su-S08 3/3) — positional write is the live default. A silent regression
      // back to 'off' loses the ~4-5× output-token write win; an intentional
      // rollback must update this pin with its reason.
      expect(e?.write).toBe('positional');
    }
  });

  it('activates the audit:list read path (the one clean flat-row read)', () => {
    expect(PRE_PROMPT_REGISTRY.find((e) => e.name === 'audit:list')?.read).toBe('csv');
  });
});
