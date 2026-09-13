import { describe, it, expect } from 'vitest';
import {
  detectPauseDeclaration,
  pauseNotEnforcedWarning,
} from './carry-note-pause-declaration';

/**
 * EI-19395730805289668.
 *
 * Every fixture below is REAL carry-note text from `harness_shared.carry_notes`
 * (workspace `papercusp-workspace`), not invented prose — owner names stripped per the
 * shipped-source identity lint. That matters: this detector's whole risk is firing on
 * engineering prose that says "paused" for some other reason, and the only honest way to
 * calibrate that is against the prose agents actually write.
 */

// ── The four owner-attributed pause declarations in the corpus's entire history ──────────
const REAL_DECLARATIONS = [
  'P-001 (real gym corpus) — PAUSED at owner request [owner:redacted 2026-08-02 "find a good stopping point and then pause your work"]',
  'PROGRESS (2026-07-18, su-4ae4993a) — PAUSED mid-item per owner request ("get to a stopping point then pause"). Re-grepped the tree.',
  'PAUSED per owner token-conservation directive 2026-07-11 (relayed by fleet-leader su-15179a33, verbatim quote below)',
  'PAUSED 2026-07-11 (su-7bfbbf2a) per owner directive (via fleet leader su-0e1a65bd, msg mrfug7m6): conserve tokens for the release cut',
];

/**
 * Real lines containing "paus" that must stay SILENT. Drawn from a random 40-line sample of
 * carry-note lines matching /paus/i — the first eight of which were ALL false positives for a
 * naive matcher. If this detector ever fires on one of these it has stopped being useful:
 * checkpoints are long, and a nudge that cries wolf on evidence blocks and identifiers gets
 * tuned out exactly like the prose pause it is trying to replace.
 */
const REAL_NON_DECLARATIONS = [
  // a pause belonging to OTHER work, mentioned in passing
  'Do not touch p2p-ship/WI-3500/P-306 (paused).',
  // a directive about the QUEUE, not this item's state
  'resume the backlog-drain self-pull loop — do NOT claim new items until the pause is explicitly lifted.',
  // DB column names inside a measured evidence block
  'evidence: Measured 02:18Z: armed_at 180, fire_count 169, loop_paused_reason 51, loop_paused_at 51, pause 2.',
  // historical narrative
  'Still blocked (unchanged) — re-confirmed 2026-07-10 ~15:27 EDT, post pause/resume cycle.',
  // a CODE identifier, with "owner" close enough on the line to bait a looser rule
  'the work-feed-stuck detector had no gate on hive-started (only on owner-steering pauseNewWork).',
  // a CATEGORY of rows — again with "owner" adjacent
  'Continue backlog drain; reject P2P/out-of-scope/owner-paused rows; already-fixed check first.',
  // telemetry values
  'current coord:glance reports governor.anyPaused=false paused=[]; dev:rate_governor_status buckets=[].',
  // describing CODE that is about pausing — the most seductive shape
  'COMPLETED. Queen paused-crit is frontier-aware. reconcilePausedQueen() (thresholds.ts:407-429) computes placeable.',
];

describe('detectPauseDeclaration — real owner-attributed pause declarations', () => {
  it.each(REAL_DECLARATIONS)('fires on: %s', (line) => {
    const found = detectPauseDeclaration(line);
    expect(found).not.toBeNull();
    expect(found!.line).toBe(1);
  });

  it('reports the 1-based line number inside a multi-section checkpoint', () => {
    const note = ['## Did', 'Landed the parser fix.', '', REAL_DECLARATIONS[0], '## Next'].join('\n');
    expect(detectPauseDeclaration(note)).toMatchObject({ line: 4 });
  });

  it('quotes the matched line back, trimmed', () => {
    const note = `## Did\n   ${REAL_DECLARATIONS[2]}   \n## Next`;
    expect(detectPauseDeclaration(note)!.quote).toBe(REAL_DECLARATIONS[2]);
  });

  it('bounds a pathologically long line so it cannot blow up a tool result', () => {
    const long = `PAUSED at owner request ${'x'.repeat(5000)}`;
    const quote = detectPauseDeclaration(long)!.quote;
    expect(quote.length).toBeLessThanOrEqual(161);
    expect(quote.endsWith('…')).toBe(true);
  });

  it('returns the latest active declaration when a note declares one twice', () => {
    const note = [REAL_DECLARATIONS[1], 'more prose', REAL_DECLARATIONS[3]].join('\n');
    expect(detectPauseDeclaration(note)!.line).toBe(3);
  });

  it('matches via the [owner:...] provenance tag even without request/directive wording', () => {
    expect(detectPauseDeclaration('PAUSED here [owner:redacted 2026-08-02]')).not.toBeNull();
  });

  it('retires a historical declaration when a later resume explicitly clears its pause hold', () => {
    const note = [
      REAL_DECLARATIONS[0],
      'RESUMED — superseding the earlier temporary pause. Pause hold cleared.',
    ].join('\n');
    expect(detectPauseDeclaration(note)).toBeNull();
  });

  it('keeps a later declaration after an earlier pause was cleared', () => {
    const note = [
      REAL_DECLARATIONS[0],
      'RESUMED — superseding the earlier temporary pause. Pause hold cleared.',
      REAL_DECLARATIONS[3],
    ].join('\n');
    expect(detectPauseDeclaration(note)!.line).toBe(3);
  });

  it('does not treat a negated clearance as retiring the pause', () => {
    const note = [REAL_DECLARATIONS[0], 'The pause hold was not cleared.'].join('\n');
    expect(detectPauseDeclaration(note)!.line).toBe(1);
  });
});

describe('detectPauseDeclaration — real prose that must NOT fire', () => {
  it.each(REAL_NON_DECLARATIONS)('stays silent on: %s', (line) => {
    expect(detectPauseDeclaration(line)).toBeNull();
  });

  it('does not fire on an all-caps PAUSED with no owner attribution', () => {
    // Real hive-scope note. This is the closest near-miss in the corpus: the token IS all-caps
    // and standalone, so ONLY the attribution requirement separates it from a true positive.
    expect(
      detectPauseDeclaration('Wake 2026-08-02T01:20Z, pot PAUSED (pauseNewWork=true) — spawned nothing, correctly.'),
    ).toBeNull();
  });

  it('does not fire on a capitalised-but-not-all-caps "Paused" narrating a finished action', () => {
    expect(
      detectPauseDeclaration('Paused after resolution confirmation and checkpoint refresh. No remaining work.'),
    ).toBeNull();
  });

  it('does not fire on PAUSED inside an identifier', () => {
    expect(detectPauseDeclaration('const IS_PAUSED_BY_OWNER_REQUEST = readOwnerDirective();')).toBeNull();
  });

  it('handles empty / absent input', () => {
    expect(detectPauseDeclaration(null)).toBeNull();
    expect(detectPauseDeclaration(undefined)).toBeNull();
    expect(detectPauseDeclaration('')).toBeNull();
  });

  it('a naive /paus/i matcher would fire on EVERY negative above — which is why this is a whitelist', () => {
    // Pins the calibration claim itself, so nobody "simplifies" this to a substring match:
    // the measured false-positive rate of the obvious implementation is 100% on this sample.
    const naive = REAL_NON_DECLARATIONS.filter((l) => /paus/i.test(l));
    expect(naive).toHaveLength(REAL_NON_DECLARATIONS.length);
    expect(REAL_NON_DECLARATIONS.filter((l) => detectPauseDeclaration(l) !== null)).toHaveLength(0);
  });
});

describe('KNOWN LIMIT — an unconventionally-phrased owner pause is MISSED', () => {
  /**
   * Read a null from this detector as "no pause in the convention this was calibrated against",
   * NEVER as "no pause here". Pinned as a test rather than a comment because the failure mode is
   * silent and reads as an all-clear — the same shape as the zero-result trap that made a
   * doc-claims extractor report a known-bad file as clean.
   *
   * Widening it is a real option, but it must be paid for with corpus evidence, not intuition:
   * the negatives above show how fast a looser rule starts firing on identifiers and telemetry.
   */
  const MISSED_BUT_GENUINE = [
    "I have stopped work on this at the owner's request until further notice.",
    'Halting here — owner asked us to wind down for the night.',
    'On hold pending the owner coming back to me about scope.',
  ];

  it.each(MISSED_BUT_GENUINE)('misses (documented, not a regression): %s', (line) => {
    expect(detectPauseDeclaration(line)).toBeNull();
  });

  it('the missed cases really ARE owner pauses — so this limit cannot be read as "would have passed anyway"', () => {
    for (const line of MISSED_BUT_GENUINE) {
      expect(line.toLowerCase()).toMatch(/owner/);
      expect(line.toLowerCase()).toMatch(/stopped|halting|on hold/);
    }
  });
});

describe('pauseNotEnforcedWarning', () => {
  const decl = detectPauseDeclaration(REAL_DECLARATIONS[0])!;

  it('names the durable mechanism the author should reach for', () => {
    expect(pauseNotEnforcedWarning(decl)).toContain('work_items:hold_open');
  });

  it('states the SECOND failure direction — an unexpired situational pause misleads forever', () => {
    // The counter-intuitive half, and the reason this is a nudge rather than an auto-hold:
    // two corpus items sat open-and-"paused" for weeks on directives that had expired, so
    // silently converting prose into a hold would have made those worse, not better.
    const w = pauseNotEnforcedWarning(decl);
    expect(w).toMatch(/situational/i);
    expect(w).toMatch(/expiry/i);
  });

  it('quotes the offending line and its number back to the author', () => {
    const w = pauseNotEnforcedWarning(decl);
    expect(w).toContain(decl.quote);
    expect(w).toContain(`line ${decl.line}`);
  });
});
