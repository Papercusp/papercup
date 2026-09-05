/**
 * goals-tab-improvement-2026-08-09 P-009 — the pure half of the ends editors.
 *
 * The test that matters most here is the LAST one: it pins that this module
 * forwards to the shared kill-criterion rule instead of carrying a copy. The
 * item's hard constraint is "share the check rather than re-implementing it",
 * and a behavioural test of the criterion alone cannot tell a forward apart
 * from a faithful copy — the copy passes every case until the day the shared
 * rule changes and this one does not. So the forward is asserted structurally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killCriterionProblem } from '@papercusp/operator-core/lib/goals/kill-criterion';
import {
  MAX_CEILING_USD,
  ceilingDirty,
  ceilingToInput,
  criterionDirty,
  criterionSubmitProblem,
  parseCeilingInput,
} from './goal-ends-edit-model';

describe('parseCeilingInput', () => {
  it('reads a plain amount, a $ prefix and thousands commas as the same ceiling', () => {
    for (const raw of ['500', '$500', ' 500 ', '$500.00']) {
      expect(parseCeilingInput(raw)).toEqual({ cents: 50_000, problem: null });
    }
    expect(parseCeilingInput('$1,250.50')).toEqual({ cents: 125_050, problem: null });
  });

  it('reads blank as an explicit REMOVE — null, never an omitted cents', () => {
    // The null/undefined split is the whole behaviour (EI-20072247655456262):
    // `goals:update` reads an omitted budgetCents as "leave unchanged", so a
    // blank that returned `{}` would close the editor having silently done
    // nothing. `toEqual` is deliberate over `toBe(null)` — it also pins that
    // no `problem` came back, i.e. that blank is a write and not a refusal.
    for (const raw of ['', '   ', '$', ' $ ']) {
      expect(parseCeilingInput(raw), raw).toEqual({ cents: null, problem: null });
    }
  });

  it('refuses the numbers Number() would have silently accepted', () => {
    // Each of these parses to a finite number under Number() and none of them
    // is what the owner typed a dollar amount to mean.
    for (const raw of ['1e9', '0x10', 'Infinity', '500abc', '-500', '12.345', '.5']) {
      const r = parseCeilingInput(raw);
      expect(r.problem, `expected a refusal for ${raw}`).toBeTruthy();
      expect(r.cents).toBeUndefined();
    }
  });

  it('refuses a ceiling past the typo fence, and says why', () => {
    const r = parseCeilingInput(String(MAX_CEILING_USD + 1));
    expect(r.problem).toMatch(/typo/);
    expect(r.cents).toBeUndefined();
  });

  it('never returns cents WITHOUT clearing problem, so a caller cannot write a refused value', () => {
    // The failure this prevents is quiet: `cents` undefined reaching
    // `goals:update` reads as "leave unchanged", so a refusal would land as a
    // successful-looking no-op that closes the editor.
    for (const raw of ['500', '', '1e9', 'nope']) {
      const r = parseCeilingInput(raw);
      if (r.problem) expect('cents' in r).toBe(false);
      else expect('cents' in r).toBe(true);
    }
  });
});

describe('ceilingToInput', () => {
  it('renders a whole-dollar ceiling without invoice decimals', () => {
    expect(ceilingToInput(50_000)).toBe('500');
  });

  it('keeps the cents when the stored value actually has them', () => {
    expect(ceilingToInput(125_050)).toBe('1250.50');
  });

  it('renders absence as an empty field, never as a 0 that reads like a ceiling of zero', () => {
    expect(ceilingToInput(null)).toBe('');
    expect(ceilingToInput(undefined)).toBe('');
    expect(ceilingToInput(Number.NaN)).toBe('');
  });

  it('round-trips through parseCeilingInput', () => {
    for (const cents of [0, 1, 99, 100, 50_000, 125_050]) {
      expect(parseCeilingInput(ceilingToInput(cents)).cents).toBe(cents);
    }
  });
});

describe('dirtiness', () => {
  it('treats $500, 500 and 500.00 as the same ceiling — no Save that writes nothing', () => {
    for (const draft of ['500', '$500', '500.00', ' $500 ']) {
      expect(ceilingDirty(50_000, draft)).toBe(false);
    }
    expect(ceilingDirty(50_000, '600')).toBe(true);
  });

  it('counts BLANK as dirty against a stored ceiling — that is the removal', () => {
    expect(ceilingDirty(50_000, '')).toBe(true);
    expect(ceilingDirty(50_000, '  $ ')).toBe(true);
    // A zero ceiling IS a ceiling, so blanking it is still a removal. Guards
    // the `>= 0` rather than a truthiness check, which would read 0 as absent.
    expect(ceilingDirty(0, '')).toBe(true);
  });

  it('counts BLANK as no-change when there is nothing to remove', () => {
    // Otherwise the "Set ceiling" path opens with an enabled Save that would
    // write null over null and report a removal that removed nothing.
    expect(ceilingDirty(null, '')).toBe(false);
    expect(ceilingDirty(undefined, '   ')).toBe(false);
  });

  it('counts a first ceiling on a goal that had none as dirty', () => {
    expect(ceilingDirty(null, '500')).toBe(true);
  });

  it('counts an unparseable draft as dirty so the refusal stays reachable', () => {
    // Disabling Save on garbage would hide the message that explains it.
    expect(ceilingDirty(50_000, 'nope')).toBe(true);
  });

  it('ignores surrounding whitespace on the criterion', () => {
    expect(criterionDirty('stop at 30 days', '  stop at 30 days  ')).toBe(false);
    expect(criterionDirty('stop at 30 days', 'stop at 60 days')).toBe(true);
    expect(criterionDirty(null, '')).toBe(false);
    expect(criterionDirty(null, 'stop at 30 days')).toBe(true);
  });
});

describe('criterionSubmitProblem', () => {
  it('accepts a real criterion and refuses a stub or a placeholder opener', () => {
    expect(criterionSubmitProblem('nobody buys it by day 30')).toBeNull();
    expect(criterionSubmitProblem('no sales')).toBeTruthy();
    expect(criterionSubmitProblem('TBD once we know more')).toBeTruthy();
  });

  it('refuses BLANK — this editor sets a criterion, it never clears one', () => {
    // `goals:update` does treat a blank as a clear. That capability is
    // deliberately not reachable from a control sitting under an alarm about
    // the criterion being absent; blank fails the shared rule like any other
    // non-criterion.
    expect(criterionSubmitProblem('')).toBeTruthy();
    expect(criterionSubmitProblem('   ')).toBeTruthy();
  });

  it('surfaces the SHARED message verbatim — it does not reword it', () => {
    // The shared module's header says all three callers surface its message
    // verbatim, "the inline editor as the error under the field". A reworded
    // copy here is the drift that module exists to prevent, one layer up.
    for (const draft of ['no sales', 'TBD', '']) {
      expect(criterionSubmitProblem(draft)).toBe(killCriterionProblem(draft));
    }
  });

  it('carries NO criterion rule of its own — the check is imported, not restated', () => {
    // Structural, because behaviour cannot distinguish a forward from a
    // faithful copy: a copy passes every case above until the shared rule
    // changes and this one does not.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'goal-ends-edit-model.ts'),
      'utf8',
    );
    expect(src).toMatch(
      /import\s*\{\s*killCriterionProblem\s*\}\s*from\s*'@papercusp\/operator-core\/lib\/goals\/kill-criterion'/,
    );
    // The rule's own constants/pattern must not reappear here in any form.
    expect(src).not.toMatch(/KILL_CRITERION_MIN_CHARS|PLACEHOLDER_OPENER|\btbd\b/i);
  });
});
