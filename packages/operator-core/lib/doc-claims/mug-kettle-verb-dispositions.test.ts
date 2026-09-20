/**
 * WI-10002068 step 2 — prose may not state a mug/kettle verb's disposition on its own
 * authority. See `mug-kettle-verb-dispositions.ts` for why, and for the two legs.
 *
 * ⚠ The `PRE_FIX_*` fixtures below are CONTROLS, not documentation, and they are the
 * reason this suite cannot quietly rot into a vacuous green. They are verbatim copies of
 * the four sentences that were actually live and actually wrong on 2026-09-20. If a
 * later edit to `DISPOSITION_PHRASES` stops catching them, these fail — even if every
 * pinned surface has gone silent in the meantime. Do not "simplify" them into strings
 * that no longer resemble real prose: an unmatchable fixture passes vacuously and takes
 * the whole detector's credibility with it.
 */
import { describe, expect, it } from 'vitest';

import {
  MUG_KETTLE_BLOCK_BEGIN,
  MUG_KETTLE_BLOCK_END,
  MUG_KETTLE_VERBS,
  renderMugKettleDispositionBlock,
  renderMugKettleDispositionProse,
} from '../agent-tools/_mug-kettle-gate-population';
import {
  ALL_DISPOSITIONS,
  JUDGED_CLAIM_FLOOR,
  PINNED_SURFACES,
  readSurface,
  scanDispositionClaims,
  violationsOf,
} from './mug-kettle-verb-dispositions';

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** Verbatim: `apps/operator/prompts/papercusp-su-power.tools.md` line 63, pre-fix. */
const PRE_FIX_POWER_CUP_SPAWN =
  '**RETIRED** permanently — the gate flag was DELETED: `cup:spawn` REFUSES, so a\nFLEET is the only fan-out.';

/** Verbatim: `apps/operator/prompts/papercusp-su-power.tools.md` line 994, pre-fix. */
const PRE_FIX_POWER_DECLARE_WAKE =
  '`kettle:declare-wake` REFUSES; `pot:declare-wake` survives ungated.';

/** Verbatim: `apps/operator/prompts/papercusp-su-engineer.tools.md` lines 436–437, pre-fix. */
const PRE_FIX_ENGINEER_DECLARE_WAKE =
  'permanently (the gate flag was DELETED): `kettle:declare-wake` REFUSES, while\n`pot:declare-wake` survives ungated (D-003 keeps the shared pot substrate).';

/** Verbatim: `agent-insights/mug-kettle-cup-tier-is-retired.mdx` line 132, pre-fix. */
const PRE_FIX_INSIGHT_GATE_LIST =
  'The five gated actuator tools: `cup:spawn`, `pot:start`, `pot:wake`, `overwatch:start`,\n`overwatch:declare_wake`.';

describe('the rendered block is derived from the population, not typed', () => {
  it('names every verb in the population exactly once', () => {
    const prose = renderMugKettleDispositionProse();
    expect(MUG_KETTLE_VERBS.length).toBeGreaterThanOrEqual(10);
    for (const verb of MUG_KETTLE_VERBS) {
      expect(countOf(prose, `\`${verb.name}\``), `${verb.name} in the rendered prose`).toBe(1);
    }
  });

  it('represents all three dispositions, so no side can silently empty out', () => {
    for (const disposition of ALL_DISPOSITIONS) {
      expect(
        MUG_KETTLE_VERBS.filter((v) => v.disposition === disposition).length,
        `${disposition} rows`,
      ).toBeGreaterThan(0);
    }
  });

  it('is a single line between its markers — prompts carry it in every su context', () => {
    const block = renderMugKettleDispositionBlock();
    expect(block.split('\n')).toHaveLength(3);
    expect(block.startsWith(MUG_KETTLE_BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(MUG_KETTLE_BLOCK_END)).toBe(true);
  });
});

describe('pinned surfaces', () => {
  it('is a non-empty set, and at least one surface carries the block', () => {
    expect(PINNED_SURFACES.length).toBeGreaterThanOrEqual(4);
    expect(PINNED_SURFACES.filter((s) => s.carriesBlock).length).toBeGreaterThanOrEqual(3);
  });

  it.each(PINNED_SURFACES.map((s) => [s.relpath, s] as const))(
    '%s exists and is readable',
    (_relpath, surface) => {
      // A missing surface reads as '' from readSurface, which would make every other
      // assertion below pass vacuously. This is the check that turns a moved or renamed
      // prompt into a loud red instead of a silent stand-down.
      expect(readSurface(surface.relpath).length, `${surface.relpath} — ${surface.why}`).toBeGreaterThan(
        500,
      );
    },
  );

  it.each(PINNED_SURFACES.filter((s) => s.carriesBlock).map((s) => [s.relpath] as const))(
    '%s carries the generated block verbatim, exactly once',
    (relpath) => {
      const text = readSurface(relpath);
      const block = renderMugKettleDispositionBlock();
      expect(countOf(text, MUG_KETTLE_BLOCK_BEGIN), `${relpath}: opening marker count`).toBe(1);
      expect(countOf(text, MUG_KETTLE_BLOCK_END), `${relpath}: closing marker count`).toBe(1);
      expect(
        text.includes(block),
        [
          `${relpath} does not carry the current generated block.`,
          'The population changed, or the block was hand-edited. Replace the marked region with EXACTLY:',
          '',
          block,
          '',
          'Source of truth: packages/operator-core/lib/agent-tools/_mug-kettle-gate-population.ts',
          'If this is a prompt override, RE-SEED it after editing — the .md is the source, Postgres is what agents receive.',
        ].join('\n'),
      ).toBe(true);
    },
  );
});

describe('no pinned surface places a verb on the wrong side', () => {
  it.each(PINNED_SURFACES.map((s) => [s.relpath] as const))('%s', (relpath) => {
    const violations = violationsOf(scanDispositionClaims(readSurface(relpath)));
    expect(
      violations.map((v) => `line ${v.line}: ${v.verb} is '${v.actual}' but the prose claims '${v.claimed}' — ${v.excerpt.replace(/\s+/g, ' ')}`),
    ).toEqual([]);
  });

  it('judges enough claims to mean something', () => {
    // The denominator. An unrecognised claim is indistinguishable from no claim, so a
    // rewording that escapes DISPOSITION_PHRASES would otherwise turn this whole leg
    // into a silent pass. Falling through the floor is how that becomes a red instead.
    const judged = PINNED_SURFACES.flatMap((s) => scanDispositionClaims(readSurface(s.relpath)));
    expect(judged.length).toBeGreaterThanOrEqual(JUDGED_CLAIM_FLOOR);
  });
});

describe('CONTROL — the scanner still catches the drift that was actually live', () => {
  it('catches `cup:spawn` REFUSES (it is deleted, not gated)', () => {
    const violations = violationsOf(scanDispositionClaims(PRE_FIX_POWER_CUP_SPAWN));
    expect(violations.map((v) => [v.verb, v.actual, v.claimed])).toEqual([
      ['cup:spawn', 'deleted', 'gated'],
    ]);
  });

  it('catches both halves of "`kettle:declare-wake` REFUSES; `pot:declare-wake` survives ungated"', () => {
    const violations = violationsOf(scanDispositionClaims(PRE_FIX_POWER_DECLARE_WAKE));
    expect(violations.map((v) => [v.verb, v.actual, v.claimed]).sort()).toEqual(
      [
        ['kettle:declare-wake', 'deleted', 'gated'],
        ['pot:declare-wake', 'gated', 'excluded'],
      ].sort(),
    );
  });

  it('catches the engineer playbook copy of the same two claims', () => {
    const violations = violationsOf(scanDispositionClaims(PRE_FIX_ENGINEER_DECLARE_WAKE));
    expect(violations.map((v) => v.verb).sort()).toEqual([
      'kettle:declare-wake',
      'pot:declare-wake',
    ]);
  });

  it('catches a leading-list claim ("The five gated actuator tools: `cup:spawn`, …")', () => {
    const violations = violationsOf(scanDispositionClaims(PRE_FIX_INSIGHT_GATE_LIST));
    expect(violations.map((v) => [v.verb, v.actual, v.claimed, v.form])).toEqual([
      ['cup:spawn', 'deleted', 'gated', 'leading-list'],
    ]);
  });

  it('does NOT flag a correct sentence, so the detector is not simply always-red', () => {
    const correct =
      '`kettle:declare-wake` was deleted outright and the TOOL `pot:declare-wake` REFUSES.';
    const claims = scanDispositionClaims(correct);
    expect(violationsOf(claims)).toEqual([]);
    expect(claims.length).toBeGreaterThan(0);
  });

  it('does not judge the generated block itself — it is stripped before scanning', () => {
    expect(scanDispositionClaims(renderMugKettleDispositionBlock())).toEqual([]);
  });
});
