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
import { advertisedArgsSchema, isPositionalReadEncoding } from '@papercusp/result-encoding';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { PRE_PROMPT_REGISTRY } from './pre-prompt-registry-config';
import './work_items/set_state';
import './work_items/claim';

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

  it('serves the audit:list read as self-describing TOON, never a headerless positional body (EI-136)', () => {
    const e = PRE_PROMPT_REGISTRY.find((x) => x.name === 'audit:list');
    expect(e, 'audit:list must stay in the governed registry').toBeDefined();
    // EI-136 measured a ~1/3 COLUMN-SHIFT MISREAD of this exact result under the
    // headerless form (2 pass / 1 fail over 3 runs) — the reader had to map 5
    // bare positions to a column order held thousands of tokens away in the
    // prompt legend. TOON carries `fields[5]: …` adjacent to the rows instead.
    expect(e?.read).toBe('toon');
    // The load-bearing property is POSITIONAL-ness, not the literal string: any
    // future flip to another headerless encoding (tsv) re-arms the same misread.
    expect(
      isPositionalReadEncoding(e?.read),
      'audit:list must not be served in a headerless positional encoding — see EI-136',
    ).toBe(false);
  });

  it('hardens the work_items:* misalignment guard with columnOverrides (D-007 residual, EI-7927)', () => {
    const setState = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:set_state');
    expect(setState?.columnOverrides?.id?.pattern).toBe('^(WI|F|EI)-\\d+$');
    // The state vocabulary must be non-trivial (covers both families' native
    // states + every cross-dialect alias) and include a representative token
    // from each source it's unioned from, so a future alias added upstream is
    // still covered without anyone having to remember to touch this file.
    const stateVocab = setState?.columnOverrides?.state?.enumValues ?? [];
    for (const token of ['open', 'resolved', 'closed', 'todo', 'passed', 'deprecated', 'done', 'wip', 'needs-human']) {
      expect(stateVocab, `expected "${token}" in the derived state vocabulary`).toContain(token);
    }

    const claim = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:claim');
    expect(claim?.columnOverrides?.id?.pattern).toBe('^(WI|F|EI)-\\d+$');
  });

  it('advertises real work_items bulk schemas as row+keyed oneOf, not inert keyed-only fallback (WI-3260)', () => {
    for (const [name, expectedOrder] of [
      ['work_items:set_state', 'id, state, harness?'],
      ['work_items:claim', 'id, assignee?, harness?'],
    ] as const) {
      const projected = lookupByMcpName(name);
      expect(projected, name).toBeDefined();
      const advertised = advertisedArgsSchema(name, projected!.inputSchema as Record<string, unknown>);
      const oneOf = (advertised as { oneOf?: unknown[] }).oneOf;
      expect(oneOf, name).toHaveLength(2);
      const row = oneOf![0] as { properties?: Record<string, { description?: string }> };
      expect(row.properties?.row?.description).toContain(expectedOrder);
      const keyed = oneOf![1] as { properties?: Record<string, unknown> };
      expect(keyed.properties).toHaveProperty('ids');
      expect(keyed.properties).toHaveProperty('items');
    }
  });
});
