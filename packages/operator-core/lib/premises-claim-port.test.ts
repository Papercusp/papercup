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
  evidenceNamesScope,
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

  /**
   * EI-19399570274386816 — POLARITY. These patterns match a surface string, not a
   * proposition, so a sentence RETRACTING an absence read identically to one asserting it.
   * That fires hardest on the exact write the guard wants to cause: the author who ran the
   * search, found the thing, and is documenting the correction. An advisory guard that
   * warns on correct behaviour trains agents to dismiss it, which costs it its real catches.
   */
  describe('polarity: a RETRACTION of an absence claim is not an absence claim', () => {
    /** VERBATIM the loop:checkpoint sentence that misfired (the filing incident). */
    const RETRACTION =
      'isCheckpointRunLockHeldCheap (release-checkpoint-launch.ts:648) IS the single ' +
      'authoritative both-origins source I claimed did not exist, so the premise was FALSE.';

    it('⭐ does not fire on the measured retraction sentence', () => {
      expect(derive(RETRACTION)).toEqual([]);
    });

    it('does not fire when a reporting VERB is captured as the subject', () => {
      // "<verb> did not exist" captured "claimed" and then told the reader to grep the
      // repo for "claimed" — a search term that names nothing.
      expect(derive('The helper I claimed did not exist is right there in the module.')).toEqual([]);
      expect(derive('The reader we assumed did not exist has been present since March.')).toEqual([]);
    });

    it('does not fire on an explicit self-retraction in the same sentence', () => {
      expect(derive('I said there is no exported reader for that table, and I was wrong.')).toEqual([]);
      expect(derive('There is no reader for the offers table — RETRACTED, it exists.')).toEqual([]);
      expect(derive('There is no such helper, but that premise was false.')).toEqual([]);
    });

    it('does not fire on a first-person reporting frame preceding the claim', () => {
      expect(derive('Earlier I claimed there is no exported read helper for that table.')).toEqual([]);
    });

    /**
     * The suppression must stay NARROW. "already exists" / "does exist" read like
     * retraction markers but legitimately share a sentence with a REAL absence claim, so
     * they are deliberately not in the marker set — including them would trade this false
     * positive for a false negative on a genuine claim.
     */
    it('STILL fires on a genuine absence that merely mentions something else existing', () => {
      expect(derive('The table already exists, but there is no reader for the offers table.')).toHaveLength(1);
      expect(derive('The flag does exist, yet nothing reads the offers table today.')).toHaveLength(1);
    });

    it('STILL fires on the root incident and the other measured shapes (no regression)', () => {
      expect(derive(WI_7042)).toHaveLength(1);
      expect(derive('That is the guard that should have caught it, and it does not exist.')).toHaveLength(1);
    });
  });

  /**
   * EI-19399570274386816 — the claim SPAN. `lastIndexOf('.')` treated every dot as a
   * sentence boundary, so a claim citing a file (the common case here) was sliced
   * mid-token: the incident emitted `"ts:648) IS the single authoritative…"`. A rendered
   * claim nobody can parse is worse than none — it looks like output and means nothing.
   */
  describe('claim span: a dot inside a token is not a sentence boundary', () => {
    it('⭐ does not start the claim mid-token on a file.ts:NNN citation', () => {
      const [p] = derive('The probe lives at release-checkpoint-launch.ts:648 and there is no caller for it.');
      expect(p).toBeDefined();
      expect(p.claim).not.toMatch(/^ts:/);
      // The whole sentence survives, so the claim reads as a claim.
      expect(p.claim).toContain('release-checkpoint-launch.ts:648');
      expect(p.claim).toContain('there is no caller');
    });

    it('still ends the claim at a REAL sentence terminator', () => {
      const [p] = derive('There is no reader for that table. A later sentence must not be swallowed.');
      expect(p.claim).toContain('There is no reader for that table');
      expect(p.claim).not.toContain('later sentence');
    });

    it('is not confused by a decimal number inside the claim', () => {
      const [p] = derive('At 1.5x load there is no headroom left on the box.');
      expect(p.claim).toContain('At 1.5x load');
    });
  });
});

describe('evidenceNamesScope (P-002)', () => {
  it('accepts evidence that names where it looked', () => {
    for (const s of [
      'grepped the whole repo 2026-08-02',
      'searched across packages/ and libs/',
      'repo-wide ripgrep, zero hits',
      'checked every call site',
      'rg over packages, libs, apps — nothing',
    ]) {
      expect(evidenceNamesScope(s), s).toBe(true);
    }
  });

  it('rejects evidence that only asserts a search happened', () => {
    for (const s of ['I checked', 'grepped for it and found nothing', 'verified, none found', '']) {
      expect(evidenceNamesScope(s), s).toBe(false);
    }
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

  it('a SCOPE-LESS declared absence premise does NOT silence the derived row (P-002)', () => {
    // WI-7042's premise WAS checked — a real grep, over the wrong leg. So "I
    // checked" is not evidence of an absence; only "I checked HERE" is.
    const declared = [
      {
        claim: 'There is no exported read helper for harness_shared.p2p_work_offers',
        verified: 'I grepped for it and found nothing',
      },
    ];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief).not.toBeNull();
    expect(brief.unverified).toBeGreaterThan(0);
    // Replaced, not annotated: no ✓ badge survives on that row.
    expect(brief.rendered.some((r) => r.startsWith('- ✓'))).toBe(false);
    expect(brief.rendered.join('\n')).toMatch(/SCOPE NOT NAMED/);
    // The original observation is preserved, not deleted.
    expect(brief.rendered.join('\n')).toContain('I grepped for it and found nothing');
  });

  it('a NON-absence premise keeps its ✓ on plain evidence (the stricter bar is absence-only)', () => {
    const declared = [{ claim: 'The gate was green at cut time', verified: 'checked at 23:00Z' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.rendered.some((r) => r.startsWith('- ✓'))).toBe(true);
  });

  it('keeps an unrelated derived row even when another premise is verified', () => {
    const declared = [{ claim: 'The gate is green', verified: 'checked at 23:00Z' }];
    const brief = buildPremisesBrief(declared, derive(WI_7042))!;
    expect(brief.premises.some((p) => p.claim.includes('exported read helper'))).toBe(true);
    expect(brief.unverified).toBe(1);
  });
});
