import { describe, it, expect } from 'vitest';
import {
  lintCarrySurfaceProvenance,
  provenanceLintField,
  PROVENANCE_LINT_NOTE,
} from './carry-surface-provenance-lint';

describe('lintCarrySurfaceProvenance', () => {
  it('is clean on empty / null / undefined text', () => {
    expect(lintCarrySurfaceProvenance('')).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(null)).toEqual({ flagged: false, matches: [] });
    expect(lintCarrySurfaceProvenance(undefined)).toEqual({ flagged: false, matches: [] });
  });

  it('is clean on ordinary progress-note prose with no attribution phrasing', () => {
    const text = 'Finished the migration, ran the affected suite (12/12 green), left the docs update for next wake.';
    expect(lintCarrySurfaceProvenance(text)).toEqual({ flagged: false, matches: [] });
  });

  it('flags an untagged "the owner said" imperative', () => {
    const r = lintCarrySurfaceProvenance('the owner said to hold off on deploying until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
  });

  it('flags "owner wants" / "owner approved" / "owner requires" variants', () => {
    expect(lintCarrySurfaceProvenance('owner wants this shipped dark for now').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('the owner approved the force-deploy').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('owner requires a second review before merge').flagged).toBe(true);
  });

  it('flags a bare "do not X until Y" gate imperative even without the word owner', () => {
    const r = lintCarrySurfaceProvenance('do NOT resolve WI-3532 until the UI pass is done');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  // EI-16031: a "do not X until Y" match must be an IMPERATIVE (no expressed
  // subject) to flag — a DECLARATIVE sentence describing some other subject's
  // behavior is a measurement, not a directive, and must not false-positive.
  it('EI-16031: does NOT flag a descriptive "<subject> do not X until Y" sentence with no attribution', () => {
    const r = lintCarrySurfaceProvenance(
      'tag_weight is in the claim-spec rank vocabulary but compiles to NEUTRAL ' +
        '("they do not reorder until their lanes ship"), referenced by 0 of 133 live specs.',
    );
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-16031: does NOT flag other third-person-subject "does not ... until" descriptions', () => {
    expect(lintCarrySurfaceProvenance('the scheduler does not reorder until lanes ship').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('it does not retry until the backoff window elapses').flagged).toBe(false);
  });

  it('EI-16031: still flags a genuine bare directive at the start of a sentence', () => {
    const r = lintCarrySurfaceProvenance('do not resolve WI-3532 until the UI pass is done');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('EI-16031: still flags a bare directive after a sentence boundary', () => {
    const r = lintCarrySurfaceProvenance('Finished the audit pass. Do not deploy until reviewed.');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('bare-gate-imperative');
  });

  it('does NOT flag when the line carries a NON-OWNER source tag', () => {
    expect(lintCarrySurfaceProvenance('[self-imposed] do not resolve WI-3532 until the UI pass is done').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[peer:su-4dc3b] the owner approved this').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('[inferred] owner wants this merged').flagged).toBe(false);
  });

  // P-014 (deterministic-context-carry): manual [owner:…] tags are retired as
  // evidence — a turn ref is the verifiable anchor.
  it('P-014: a manual [owner:…] tag with NO turn ref is flagged manual-owner-tag', () => {
    const r = lintCarrySurfaceProvenance('[owner:jane 2026-07-10] the owner said to hold off until Friday');
    expect(r.flagged).toBe(true);
    expect(r.matches[0].kind).toBe('manual-owner-tag');
  });

  // EI-18672153930631150: the lint could not tell a MENTION of the `[owner:…]`
  // convention (documenting/comparing its syntax) from a real USE of it.
  describe('EI-18672153930631150: mention vs use of the [owner:…] tag convention', () => {
    it('downgrades a placeholder-name tag to possible-owner-tag-mention (the filed repro)', () => {
      const r = lintCarrySurfaceProvenance(
        'the detector matches the bracket form [owner:Name] and the parenthetical form',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0].kind).toBe('possible-owner-tag-mention');
    });

    it('never flags a backtick-quoted tag at all (definite quoting, not a use)', () => {
      const r = lintCarrySurfaceProvenance(
        '   `[owner:Name]` + parenthetical `OWNER MANDATE (Name, date)`), imported by BOTH consumers',
      );
      expect(r.flagged).toBe(false);
      expect(r.matches).toEqual([]);
    });

    it('downgrades other placeholder stand-ins: <name>, foo, ...', () => {
      expect(
        lintCarrySurfaceProvenance('the tag looks like [owner:<name>]').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
      expect(
        lintCarrySurfaceProvenance('a fixture asserting [owner:foo] gets scrubbed').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
      expect(
        lintCarrySurfaceProvenance('write it as [owner:...] with a real name and date').matches[0]?.kind,
      ).toBe('possible-owner-tag-mention');
    });

    it('downgrades on nearby mention-context words even with a name-shaped placeholder', () => {
      const r = lintCarrySurfaceProvenance('e.g. [owner:Name] is the bracket convention');
      expect(r.matches[0]?.kind).toBe('possible-owner-tag-mention');
    });

    it('still flags manual-owner-tag for a REAL name with no quoting/placeholder/context', () => {
      const r = lintCarrySurfaceProvenance('[owner:jane 2026-07-10] the owner said to hold off until Friday');
      // two matches expected: the tag itself, plus the "the owner said" phrase on the same line
      // is suppressed by SOURCE_TAG_RE continuing past it — assert on the tag-kind specifically.
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(false);
    });

    // EI-18762822878138952: the repo's OWN documented tag shape — root CLAUDE.md's
    // "Directive provenance" convention spells the example as `[owner:<name> <date>]`,
    // chaining TWO placeholder tokens. Before the fix, only a single placeholder token
    // was recognized, so this exact canonical example (which any agent implementing or
    // documenting the convention naturally reproduces) fell through to the loud
    // `manual-owner-tag` category instead of being downgraded as a mention.
    it('EI-18762822878138952: downgrades a chained multi-token placeholder like [owner:<name> <date>]', () => {
      const r = lintCarrySurfaceProvenance(
        'tag every directive with its source: [owner:<name> <date>] · [self-imposed] · [peer:<sid>] · [inferred]',
      );
      expect(r.flagged).toBe(true);
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(false);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(true);
    });

    it('EI-18762822878138952: a real name chained with a placeholder token still flags manual-owner-tag', () => {
      const r = lintCarrySurfaceProvenance('[owner:jane <date>] hold off until Friday');
      expect(r.matches.some((m) => m.kind === 'manual-owner-tag')).toBe(true);
      expect(r.matches.some((m) => m.kind === 'possible-owner-tag-mention')).toBe(false);
    });

    // EI-18762822878138952 (filed repro): a bare `|`-separated ENUMERATION of the P-010
    // evidence-band vocabulary (observed / tool-output / reported-by / inferred / assumed)
    // — no brackets, no owner attribution, no completed-action claim. None of the tag/
    // attribution/action regexes require brackets or an assertive verb be absent, so this
    // was never actually reachable through the bracket-gated OWNER_TAG_RE path; locking it
    // in here as a named regression so a future tightening of any of the line-scoped
    // detectors can't reintroduce a false positive on vocabulary-listing prose like this.
    it('EI-18762822878138952: does NOT flag a bare enumeration of the evidence-band vocabulary', () => {
      const line =
        'Shipped the evidence band INSIDE relay-provenance.ts (the item forbids a third provenance surface): ' +
        'observed | tool-output | reported-by | inferred | assumed. Confidence is DERIVED via a total mapping';
      expect(lintCarrySurfaceProvenance(line)).toEqual({ flagged: false, matches: [] });
      expect(
        lintCarrySurfaceProvenance('observed | tool-output | reported-by | inferred | assumed'),
      ).toEqual({ flagged: false, matches: [] });
    });
  });

  it('P-014: a [turn:<session>@<ts>] ref clears the line — with or without an owner tag', () => {
    expect(
      lintCarrySurfaceProvenance(
        '[owner:jane 2026-07-10] [turn:bf1881bc@2026-07-14T17:42:41.307Z] hold off until Friday',
      ).flagged,
    ).toBe(false);
    expect(
      lintCarrySurfaceProvenance('the owner said to ship dark [turn:bf1881bc@2026-07-14T17:42:41.307Z]').flagged,
    ).toBe(false);
  });

  it('is LINE-scoped: a tag on one line does not mask an untagged imperative on another', () => {
    const text = ['[self-imposed] finished the audit pass.', 'the owner said to skip the retro this week.'].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toContain('the owner said to skip the retro this week.');
  });

  it('caps at MAX_MATCH_LINES (5) even when many lines match', () => {
    const text = Array.from({ length: 10 }, (_, i) => `the owner said item ${i} is done`).join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.matches.length).toBe(5);
  });

  it('truncates an overlong matched line to 200 chars', () => {
    const long = 'the owner said ' + 'x'.repeat(500);
    const r = lintCarrySurfaceProvenance(long);
    expect(r.matches[0].line.length).toBe(200);
  });

  // EI-10994: complying with the bare-gate nudge (writing an explicit, source-tagged
  // PROVENANCE block that restates the imperative it attributes) must CLEAR the flag —
  // before the fix it re-fired on the original line AND on the block's own restatement line.
  it('EI-10994: an explicit source-tagged PROVENANCE block clears the bare-gate-imperative it attributes', () => {
    const text = [
      'do not widen the isCapacityError match until the SDK ships the typed error',
      '',
      "PROVENANCE: the 'do not widen isCapacityError until the SDK ships' constraint above",
      '  is [self-imposed] by su-eb9b7ae3 on 2026-07-13. It is NOT an owner directive.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-10994: a PROVENANCE block with NO source tag does not suppress — still nudges to tag it', () => {
    const text = [
      'do not resolve WI-3532 until the UI pass is done',
      'PROVENANCE: this constraint above — I forgot to actually tag it.',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'bare-gate-imperative')).toBe(true);
  });

  it('EI-10994: a tagged PROVENANCE block does not launder an affirmative "the owner said" claim on another line', () => {
    const text = [
      "PROVENANCE: the 'do not merge until review' gate is [self-imposed] by su-abc on 2026-07-13.",
      'the owner said to ship this dark',
    ].join('\n');
    const r = lintCarrySurfaceProvenance(text);
    expect(r.flagged).toBe(true);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].kind).toBe('owner-attribution');
    expect(r.matches[0].line).toContain('the owner said to ship this dark');
  });

  // EI-18226077402946717: a checkpoint that NARRATES a coordination side-effect as
  // already DONE ("posted evidence to WI-####", "messaged fleet leader su-…") with no
  // verifiable anchor is the shape that silently drops a handoff when it never happened.
  it('EI-18226077402946717: flags the exact bug shape — a narrated post + peer message with a coordination target', () => {
    const r = lintCarrySurfaceProvenance(
      'Posted full evidence to WI-5672 (posts 53500-53501) and updated the plan. Messaged fleet leader su-bce40c51 directly.',
    );
    expect(r.flagged).toBe(true);
    const kinds = r.matches.map((m) => m.kind);
    expect(kinds).toContain('unverified-action-claim');
  });

  it('EI-18226077402946717: flags "commented on WI-…" / "notified the fleet" / "escalated to su-…" narrated actions', () => {
    expect(lintCarrySurfaceProvenance('commented on WI-5137 that the gate is green').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('notified the fleet that the reds are cleared').flagged).toBe(true);
    expect(lintCarrySurfaceProvenance('escalated to su-a7d08fd3 for the credential').flagged).toBe(true);
  });

  it('EI-18226077402946717: a [turn:…] ref on the action line CLEARS it — the one valid completion anchor', () => {
    const r = lintCarrySurfaceProvenance(
      'Posted evidence to WI-5672 (post 53502) [turn:6ffd5ea8@2026-07-21T04:14:03.101Z]',
    );
    expect(r.flagged).toBe(false);
    expect(r.matches).toEqual([]);
  });

  it('EI-18226077402946717: does NOT flag ordinary in-file progress prose (past verbs, no coordination target)', () => {
    // These carry past-tense verbs but describe the agent's OWN in-tree work, not a
    // cross-agent/cross-item side-effect — must stay clean (high-precision discipline).
    expect(lintCarrySurfaceProvenance('committed the fix and posted the results to the log').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('sent the request to the embedding sidecar; notified the user via toast').flagged).toBe(false);
    expect(lintCarrySurfaceProvenance('replied to the review comment and refactored the helper').flagged).toBe(false);
  });

  it('EI-18226077402946717: does NOT flag a PLAN (base-form verb) to do the action next', () => {
    // A checkpoint's "Next:" line uses the base form — a plan, not a completed claim.
    expect(lintCarrySurfaceProvenance('Next: post evidence to WI-5672 and message the fleet leader').flagged).toBe(false);
  });

  it('EI-18226077402946717: an action-claim is NOT laundered by a [self-imposed] directive tag on the same line', () => {
    // A source tag attributes the DIRECTIVE that ordered the action; it does not prove
    // the action happened — so the action-claim still flags (only a [turn:…] ref clears it).
    const r = lintCarrySurfaceProvenance('[self-imposed] posted evidence to WI-5672 for the handoff');
    expect(r.flagged).toBe(true);
    expect(r.matches.some((m) => m.kind === 'unverified-action-claim')).toBe(true);
  });
});

describe('provenanceLintField', () => {
  it('returns undefined on a clean write (no noise on the common case)', () => {
    expect(provenanceLintField('routine progress note, nothing attributed')).toBeUndefined();
    expect(provenanceLintField(null)).toBeUndefined();
  });

  it('returns { flagged:true, note, matches } on a flagged write', () => {
    const field = provenanceLintField('the owner said to hold off until reviewed');
    expect(field).toBeDefined();
    expect(field?.flagged).toBe(true);
    expect(field?.note).toBe(PROVENANCE_LINT_NOTE);
    expect(field?.matches.length).toBeGreaterThan(0);
  });
});
