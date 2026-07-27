/**
 * lint-ratchet.test.ts — EI-18804290731494084, the third symptom.
 *
 * `evaluateSetContent` used to reject a write whenever the PROPOSED body had
 * any lint error. On a plan that is already in violation that is not a guard,
 * it is a deadlock: every edit is refused because of damage it did not cause,
 * including the edit that would repair the damage. Live proof — the plan
 * unified-agent-state-plane-2026-07-27 carried two duplicate-decision-id errors
 * ~370 lines apart; no single `old_string` could span both, so a repair that
 * dropped the error list 2 → 1 was still rejected and the plan could not be
 * written to at all.
 *
 * The rule is now a ratchet: reject only errors this write INTRODUCES.
 */

import { describe, it, expect } from 'vitest';
import { evaluateSetContent, errorsIntroduced } from './set-content';
import type { LintFinding } from './lint';

const err = (code: string, message: string, extra: Partial<LintFinding> = {}): LintFinding => ({
  level: 'error',
  code,
  message,
  ...extra,
});

describe('errorsIntroduced', () => {
  it('excuses an error the plan already carried', () => {
    const e = err('dup', 'Duplicate decision id: D-045');
    expect(errorsIntroduced([e], [e])).toEqual([]);
  });

  it('reports an error this write adds', () => {
    const pre = err('dup', 'Duplicate decision id: D-045');
    const added = err('unknown_decision_ref', 'Item P-001 references unknown decision D-999.');
    expect(errorsIntroduced([pre], [pre, added])).toEqual([added]);
  });

  it('rejects the FIRST error on a clean plan', () => {
    const added = err('dup', 'Duplicate decision id: D-045');
    expect(errorsIntroduced([], [added])).toEqual([added]);
  });

  it('is a MULTISET — one pre-existing instance does not excuse two', () => {
    // A count-based rule would pass this; a set-based one would too. Both are
    // wrong: the write genuinely added an occurrence.
    const e = err('dup', 'Duplicate decision id: D-045');
    expect(errorsIntroduced([e], [e, e])).toEqual([e]);
  });

  it('catches a swap that leaves the COUNT unchanged', () => {
    // Why the ratchet cannot be `proposed.length <= baseline.length`.
    const before = err('dup', 'Duplicate decision id: D-045');
    const after = err('malformed', 'Malformed item id: PP-1');
    expect(errorsIntroduced([before], [after])).toEqual([after]);
  });

  it('ignores LINE-NUMBER drift — the trap that would silently re-wedge the plan', () => {
    // Lint messages embed positions, so ANY edit that adds or removes a line
    // renumbers every finding below it. Comparing raw messages would read a
    // pre-existing error at its new line as brand new and reject the write,
    // reproducing the deadlock while appearing to work.
    const before = err('parse_warning', 'Duplicate decision id: D-045 at line 1650');
    const after = err('parse_warning', 'Duplicate decision id: D-045 at line 1673');
    expect(errorsIntroduced([before], [after])).toEqual([]);
  });

  it('does NOT excuse a different id that merely shares the message shape', () => {
    const before = err('parse_warning', 'Duplicate decision id: D-045 at line 1650');
    const after = err('parse_warning', 'Duplicate decision id: D-053 at line 1650');
    expect(errorsIntroduced([before], [after])).toEqual([after]);
  });
});

/** A plan carrying a pre-existing lint error: a malformed item id. */
const WEDGED = [
  '---',
  'title: Wedged',
  'slug: wedged-plan',
  'status: active',
  'created: 2026-07-27',
  'updated: 2026-07-27',
  '---',
  '',
  '# Wedged',
  '',
  '## Now',
  '',
  'State: broken.',
  'Next: repair.',
  '',
  '## Phase 1',
  '',
  '- **P-001** `todo` first item',
  '- **P-001** `todo` a DUPLICATE id — the pre-existing error',
  '',
  '## Decisions',
  '',
  '### D-001 — a decision',
  'Date: 2026-07-27',
  'Body.',
  '',
].join('\n');

describe('evaluateSetContent — the ratchet end to end', () => {
  it('ACCEPTS an unrelated edit to a plan that already fails lint', async () => {
    const proposed = WEDGED.replace('State: broken.', 'State: still broken, but described better.');
    const { newBody, value } = await evaluateSetContent(WEDGED, proposed, 'wedged-plan', undefined, {
      meta: null,
    });
    // Before the fix this returned lint_failed and newBody null — forever.
    expect(value.ok).toBe(true);
    expect(newBody).toContain('described better');
  });

  it('ACCEPTS the repair itself', async () => {
    const proposed = WEDGED.replace(
      '- **P-001** `todo` a DUPLICATE id — the pre-existing error',
      '- **P-002** `todo` repaired',
    );
    const { value } = await evaluateSetContent(WEDGED, proposed, 'wedged-plan', undefined, {
      meta: null,
    });
    expect(value.ok).toBe(true);
  });

  it('still REJECTS a write that introduces a NEW error, and says what was pre-existing', async () => {
    const proposed = WEDGED.replace(
      '- **P-001** `todo` first item',
      '- **P-001** `todo` first item\n- **P-003** `todo` broken ref blocked-by: P-404',
    );
    const { newBody, value } = await evaluateSetContent(WEDGED, proposed, 'wedged-plan', undefined, {
      meta: null,
    });
    expect(value.ok).toBe(false);
    expect(newBody).toBeNull();
    if (value.ok) throw new Error('unreachable');
    expect(value.code).toBe('lint_failed');
    if (value.code !== 'lint_failed') throw new Error('unreachable');
    // Only the introduced error is reported — never the plan's own baggage.
    expect(value.errors).toHaveLength(1);
    expect(value.errors[0]?.message).toContain('P-404');
    expect(value.preexistingErrors).toBeGreaterThan(0);
  });

  it('a CLEAN plan still hard-rejects its first error (the ratchet has a floor)', async () => {
    const clean = WEDGED.replace(
      '- **P-001** `todo` a DUPLICATE id — the pre-existing error',
      '- **P-002** `todo` second item',
    );
    const proposed = clean.replace('- **P-002** `todo` second item', '- **P-002** `todo` second item blocked-by: P-404');
    const { value } = await evaluateSetContent(clean, proposed, 'wedged-plan', undefined, { meta: null });
    expect(value.ok).toBe(false);
    if (value.ok) throw new Error('unreachable');
    expect(value.code).toBe('lint_failed');
  });
});
