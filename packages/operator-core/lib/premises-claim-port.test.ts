/**
 * premises-claim-port.test.ts — false-premise-in-prescriptive-artifacts-2026-08-02
 * P-001.
 *
 * The fixtures are REAL body text sampled from `harness_shared.work_items`
 * (harness papercusp, 2026-08-02) rather than invented sentences — including the
 * measured false positive (WI-7132), whose absence phrase sits entirely inside a
 * backticked error string. A detector validated only against sentences its author
 * wrote is validated against its own assumptions, which is the defect this whole
 * plan is about.
 */
import { describe, it, expect } from 'vitest';
import {
  stripNonProse,
  detectAbsencePremises,
  buildPremisesBrief,
  type DerivedPremise,
} from './premises-claim-port';

/** WI-7042 — the root incident. A real search over the wrong scope, stated as an
 *  absolute absence, prescribing a module that already existed. */
const WI_7042 = `Thin PG read for delegated spawn-request facts.
There is no exported read helper for harness_shared.p2p_work_offers, so this needs
a thin PG read module before the trace can synthesize a verdict.`;

/** WI-7132 — the measured FALSE POSITIVE: the only absence phrase is quoted tool
 *  output the author PASTED AS EVIDENCE, not a claim about the codebase. */
const WI_7132 =
  'The query died on real Postgres with `column "payload" does not exist` — the ' +
  'derived table projected narrowly, so compileRank ORDER BY vocabulary regressed.';

const derive = (t: string): DerivedPremise[] => detectAbsencePremises(t, 'work-item');

describe('stripNonProse (the measured false-positive fix)', () => {
  it('blanks inline code spans while preserving offsets', () => {
    const out = stripNonProse('a `bad does not exist` b');
    expect(out).toHaveLength('a `bad does not exist` b'.length);
    expect(out).not.toContain('does not exist');
  });

  it('blanks fenced blocks', () => {
    expect(stripNonProse('x\n```\nthere is no foo\n```\ny')).not.toContain('there is no foo');
  });
});

describe('detectAbsencePremises', () => {
  it('fires on the root incident (WI-7042) and captures the subject', () => {
    const [p, ...rest] = derive(WI_7042);
    expect(rest).toHaveLength(0);
    expect(p.kind).toBe('absence');
    expect(p.source).toBe('work-item');
    expect(p.claim).toContain('no exported read helper');
    // D-001 (c): the recheck must NAME the thing to search for...
    expect(p.recheck).toContain('exported read helper');
    // ...and demand the SCOPE, since scope-of-inference is the measured failure.
    expect(p.recheck).toMatch(/whole repo/i);
    expect(p.recheck).toMatch(/scope/i);
  });

  it('does NOT fire on quoted tool output (WI-7132, the measured FP)', () => {
    expect(derive(WI_7132)).toEqual([]);
  });

  it('is silent on prose with no absence claim, and on stubs', () => {
    expect(derive('Refactor the resolver to use the shared helper and add a test.')).toEqual([]);
    expect(derive('fix it')).toEqual([]);
    expect(derive('')).toEqual([]);
  });

  it('catches the other measured absence shapes', () => {
    expect(derive('That is the guard that should have caught it, and it does not exist.')).toHaveLength(1);
    expect(derive('There is no such thing as a safe default here, so nothing reads the flag today.')).not.toHaveLength(
      0,
    );
    expect(derive('We have no reader for the offers table, so one must be written.')).toHaveLength(1);
  });

  it('dedups repeated claims and bounds the row count', () => {
    const many = Array.from({ length: 9 }, (_, i) => `There is no helper number ${i} anywhere.`).join('\n');
    expect(derive(many).length).toBeLessThanOrEqual(4);
    const repeated = 'There is no reader here.\nThere is no reader here.';
    expect(derive(repeated)).toHaveLength(1);
  });

  it('tags plan-item provenance separately', () => {
    expect(detectAbsencePremises(WI_7042, 'plan-item')[0].source).toBe('plan-item');
  });
});

describe('buildPremisesBrief', () => {
  it('returns null when there is nothing to warn about', () => {
    expect(buildPremisesBrief([], [])).toBeNull();
  });

  it('frames the item as a HYPOTHESIS rather than annotating the prescription', () => {
    const brief = buildPremisesBrief([], derive(WI_7042))!;
    expect(brief.unverified).toBe(1);
    expect(brief.note).toMatch(/HYPOTHESIS, not a spec/);
    expect(brief.note).toMatch(/BEFORE building/);
    expect(brief.rendered[0].startsWith('- ?')).toBe(true); // PREDICTED badge
  });

  it('a VERIFIED declared premise REPLACES the overlapping derived row (D-001 a)', () => {
    const declared = [
      {
        claim: 'There is no exported read helper for harness_shared.p2p_work_offers',
        verified: 'grepped the whole repo 2026-08-02 — offer-store.ts exports none',
      },
    ];
    // Verified + no surviving unverified row ⇒ silent, not "here is a premise, and
    // also it might be wrong".
    expect(buildPremisesBrief(declared, derive(WI_7042))).toBeNull();
  });

  it('an UNVERIFIED declared premise does not silence the derived row', () => {
    const declared = [{ claim: 'There is no exported read helper for harness_shared.p2p_work_offers' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.unverified).toBeGreaterThan(0);
  });

  it('keeps an unrelated derived row even when another premise is verified', () => {
    const declared = [{ claim: 'The gate is green', verified: 'checked at 23:00Z' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.premises.some((p) => p.claim.includes('exported read helper'))).toBe(true);
    expect(brief.unverified).toBe(1);
  });
});
