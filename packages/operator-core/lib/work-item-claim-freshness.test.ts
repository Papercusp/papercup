import { describe, expect, it } from 'vitest';
import { assessClaimFreshness, createBugFreshnessEnvelope } from './work-item-claim-freshness';

const NOW = Date.parse('2026-08-11T20:00:00.000Z');
/**
 * Source and runtime identity are DELIBERATELY different values here.
 *
 * EI-22283949842250645: these fixtures used to set both sides of both pairs to one
 * sha, which is the exact collapse the production caller had — and it made the
 * suite assert the resulting double-count as intended behavior. The scorer now
 * detects that shape and refuses to score one input as two axes, so a collapsed
 * fixture can no longer exercise the independent-axis path at all. Keeping them
 * distinct is what makes these tests measure two axes rather than one twice.
 */
const current = { headSha: 'src9999', runtimeSha: 'abc1234', runtimeVersion: '1.2.3' };

describe('claim-time bug freshness (P-014)', () => {
  it('routes a current-generation, recently reproduced bug to implementation', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-11T19:00:00.000Z',
      sourceSha: 'src9999',
      runtimeSha: 'abc1234',
      reporterSession: 'su-a',
      reporterRuntimeVersion: '1.2.3',
      lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
    });
    expect(assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW)).toMatchObject({
      lane: 'implementation',
      likelyStale: false,
      score: 1,
    });
  });

  it('routes a moved source/runtime generation to cheap validation, never a terminal verdict', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-10T19:00:00.000Z',
      sourceSha: 'oldsrc1',
      runtimeSha: 'oldrun1',
      reporterSession: 'su-a',
    });
    const verdict = assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW);
    expect(verdict).toMatchObject({ lane: 'validation', likelyStale: true });
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'source HEAD moved since observation',
      'runtime/deploy generation moved since observation',
    ]));
    expect(verdict.instruction).toContain('never auto-closes');
  });

  it('routes pre-envelope legacy bugs through validation instead of guessing or closing', () => {
    expect(assessClaimFreshness({}, current, NOW)).toMatchObject({
      lane: 'validation',
      score: 0.2,
      reasons: ['no freshness envelope (pre-envelope or unknown-generation report)'],
    });
  });

  describe('measured source axis (EI-22283949842250645)', () => {
    const envelope = () =>
      createBugFreshnessEnvelope({
        now: '2026-08-11T19:00:00.000Z',
        sourceSha: 'src9999',
        runtimeSha: 'abc1234',
        lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
      });

    it('routes an item whose own paths moved to validation, naming the paths', () => {
      const verdict = assessClaimFreshness({ freshnessEnvelope: envelope() }, {
        ...current,
        sourceSignal: { kind: 'paths-moved', paths: ['packages/operator-core/lib/x.ts'] },
      }, NOW);
      expect(verdict.lane).toBe('validation');
      expect(verdict.likelyStale).toBe(true);
      expect(verdict.reasons.join(' ')).toContain('packages/operator-core/lib/x.ts');
    });

    it('keeps a measured-unchanged item in the implementation lane', () => {
      expect(
        assessClaimFreshness({ freshnessEnvelope: envelope() }, {
          ...current,
          sourceSignal: { kind: 'paths-unchanged', checked: ['a.ts'] },
        }, NOW),
      ).toMatchObject({ lane: 'implementation', likelyStale: false });
    });

    /**
     * The calibration this fix turns on. An unmeasured axis must not be scored in
     * either direction: the original defect was rewarding it (+0.25 for a comparison
     * that could not fail), and penalising it would route the ~62% of open bugs with
     * no resolvable paths into validation on ignorance rather than evidence.
     */
    it('scores an unmeasured axis NEUTRALLY, and says so instead of affirming', () => {
      const unmeasured = assessClaimFreshness({ freshnessEnvelope: envelope() }, {
        ...current,
        sourceSignal: { kind: 'unmeasured', reason: 'item names no resolvable source paths' },
      }, NOW);
      const unchanged = assessClaimFreshness({ freshnessEnvelope: envelope() }, {
        ...current,
        sourceSignal: { kind: 'paths-unchanged', checked: ['a.ts'] },
      }, NOW);

      // Neutral, not punitive: the lane is unchanged by the absence of a measurement.
      expect(unmeasured.lane).toBe('implementation');
      // ...but it is NOT scored as freshly-confirmed either, and it never claims to be.
      expect(unmeasured.score).toBeLessThan(unchanged.score);
      expect(unmeasured.reasons.join(' ')).toContain('source generation unmeasured');
      expect(unmeasured.reasons.join(' ')).not.toContain('matches the current source/runtime generation');
    });

    /**
     * THE REGRESSION GUARD. The defect was not a wrong score — it was that the caller
     * fed one value into two axes, so source and runtime could never disagree. Hold
     * the runtime axis FIXED and vary only the source evidence: if these three verdicts
     * ever collapse onto one score, the axes have been re-collapsed.
     */
    it('source and runtime axes are independently observable', () => {
      const scoreFor = (sourceSignal: Parameters<typeof assessClaimFreshness>[1]['sourceSignal']) =>
        assessClaimFreshness({ freshnessEnvelope: envelope() }, { ...current, sourceSignal }, NOW).score;

      const moved = scoreFor({ kind: 'paths-moved', paths: ['a.ts'] });
      const unmeasured = scoreFor({ kind: 'unmeasured', reason: 'x' });
      const unchanged = scoreFor({ kind: 'paths-unchanged', checked: ['a.ts'] });

      expect(new Set([moved, unmeasured, unchanged]).size).toBe(3);
      expect(moved).toBeLessThan(unmeasured);
      expect(unmeasured).toBeLessThan(unchanged);
    });

    it('falls back to the legacy sha compare when no signal is supplied', () => {
      // A caller that cannot measure keeps today's behavior rather than losing the axis.
      expect(assessClaimFreshness({ freshnessEnvelope: envelope() }, current, NOW)).toMatchObject({
        lane: 'implementation',
      });
    });

    /**
     * THE CLASS GUARD — this is the shape the production caller actually had.
     * `scheduler:get_next` fed `getBuildInfo().sha` to both `headSha` and
     * `runtimeSha`, and `issues-engineer` writes both envelope shas from the same
     * value, so all four collapsed to two. Scored naively that is +0.25 AND +0.20
     * for a single fact, with the source axis affirming a comparison that could not
     * fail. A future caller re-collapsing the inputs must not get that back.
     */
    it('refuses to score one collapsed input as two independent axes', () => {
      const collapsedEnvelope = createBugFreshnessEnvelope({
        now: '2026-08-11T19:00:00.000Z',
        sourceSha: 'abc1234',
        runtimeSha: 'abc1234',
        lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
      });
      const collapsed = assessClaimFreshness({ freshnessEnvelope: collapsedEnvelope }, {
        headSha: 'abc1234',
        runtimeSha: 'abc1234',
        runtimeVersion: '1.2.3',
      }, NOW);

      // The source axis is reported as unmeasured, not as a second confirmation...
      expect(collapsed.reasons.join(' ')).toContain('source generation unmeasured');
      expect(collapsed.reasons.join(' ')).toContain('cannot disagree');
      expect(collapsed.reasons.join(' ')).not.toContain('source HEAD moved since observation');

      // ...and it scores strictly below the same item measured on two real axes,
      // which is the double-count being removed.
      const independent = assessClaimFreshness({ freshnessEnvelope: envelope() }, current, NOW);
      expect(collapsed.score).toBeLessThan(independent.score);
    });
  });

  it('linked fixing work forces validation even when the generation matches', () => {
    const envelope = createBugFreshnessEnvelope({
      now: '2026-08-11T19:00:00.000Z',
      sourceSha: 'src9999',
      runtimeSha: 'abc1234',
      lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
      linkedFixRefs: ['WI-42'],
    });
    expect(assessClaimFreshness({ freshnessEnvelope: envelope }, current, NOW)).toMatchObject({
      lane: 'validation',
      likelyStale: true,
    });
  });
});

/**
 * EI-23791154428101928. The validation lane tells a claimant to run the cheapest
 * reproduction FIRST, which is the moment it is least equipped to notice that the
 * filer-supplied falsifier it was handed is itself broken. Measured on WI-10002068:
 * the quoted falsifier was a bare `grep -rn 'GATED\|EXCLUDED'`, which matched ~20
 * unrelated modules and read as FIRING, i.e. "already done" for a real unstarted item.
 *
 * This failure direction is the dangerous one. The false-instrument family already
 * documented in CLAUDE.md (a `head`-truncated search, `pgrep -q`, a wrong-relation SQL
 * zero-row) fails toward a false ABSENCE and causes loud rework; this one fails toward
 * a false PRESENCE of the fix and silently closes real work, leaving no error to notice.
 */
describe('validation-lane instruction frames a filer-supplied falsifier as unvalidated', () => {
  const staleEnvelope = createBugFreshnessEnvelope({
    now: '2026-08-10T19:00:00.000Z',
    sourceSha: 'oldsrc1',
    runtimeSha: 'oldrun1',
    reporterSession: 'su-a',
  });

  it('names the falsifier as an instrument rather than an oracle, and demands a negative control', () => {
    const verdict = assessClaimFreshness({ freshnessEnvelope: staleEnvelope }, current, NOW);
    expect(verdict.lane).toBe('validation');
    expect(verdict.instruction).toMatch(/FALSIFIER/);
    expect(verdict.instruction).toMatch(/unvalidated instrument/i);
    expect(verdict.instruction).toMatch(/not an oracle/i);
    // The actionable half: without this the warning is a mood, not a procedure.
    expect(verdict.instruction).toMatch(/negative control/i);
  });

  it('carries the same framing when there is no envelope at all', () => {
    // The envelope-less path builds its verdict separately, so it can regress alone.
    const verdict = assessClaimFreshness({}, current, NOW);
    expect(verdict.lane).toBe('validation');
    expect(verdict.instruction).toMatch(/negative control/i);
  });

  it('does NOT put the falsifier warning on the implementation lane', () => {
    // This file's own design note ("every row, which trains readers to ignore the lane
    // it is supposed to sharpen") is the reason this is asserted rather than assumed:
    // a warning printed on each claim is one a claimant learns to skip.
    const fresh = createBugFreshnessEnvelope({
      now: '2026-08-11T19:00:00.000Z',
      sourceSha: 'src9999',
      runtimeSha: 'abc1234',
      reporterSession: 'su-a',
      reporterRuntimeVersion: '1.2.3',
      lastSuccessfulReproductionAt: '2026-08-11T19:30:00.000Z',
    });
    const verdict = assessClaimFreshness({ freshnessEnvelope: fresh }, current, NOW);
    expect(verdict.lane).toBe('implementation');
    expect(verdict.instruction).not.toMatch(/negative control/i);
  });
});
