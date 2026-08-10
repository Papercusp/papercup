import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs script, no type declarations
import {
  buildRuleEvidence,
  citationsIn,
  droppedCitations,
  sentenceBoundaries,
  splitRuleEvidence,
  tellsIn,
} from '../../../../scripts/split-claude-md-rule-evidence.mjs';

/**
 * P-015 — (rule, evidence) separation for CLAUDE.md blocks.
 *
 * ⚠ NOTHING HERE ASSERTS AGAINST THE LIVE CLAUDE.md, deliberately. Two attempts
 * to gate on the real file went red within minutes of being written, from
 * ordinary peer edits — the file changes several times an hour on this fleet —
 * and `vitest-fail-on-console` closes the console.warn escape hatch too. Every
 * case below runs on synthetic text, which is also what lets the controls assert
 * a FAILING outcome without needing a block that happens to be broken today.
 *
 * Each group carries a CONTROL that must FAIL and a CALIBRATION that must PASS.
 * A guard only ever observed passing is not a guard: `citationsIn` was corrected
 * three times while this pass was written (wrapped spans, single-character spans,
 * fenced blocks), and each correction made it accept MORE text as equivalent —
 * exactly the direction in which a weakened check keeps reporting success.
 */
describe('splitRuleEvidence — lossless cuts', () => {
  const RULE = 'Never route around a blocked lock, because that lock is a peer in-flight edit and yours is not special. ';
  const EV = 'Measured 2026-08-02: an agent renamed the file instead and stranded the peer edit (WI-7101).';

  it('cuts at a sentence boundary with the tell on the evidence side', () => {
    const cut = splitRuleEvidence(RULE + EV);
    expect(cut).not.toBeNull();
    expect(cut.rule).toBe(RULE);
    expect(cut.evidence).toBe(EV);
  });

  it('reconstructs the block EXACTLY — the property P-017 verifies', () => {
    const raw = RULE + EV;
    const { splitOffset } = splitRuleEvidence(raw);
    expect(raw.slice(0, splitOffset) + raw.slice(splitOffset)).toBe(raw);
  });

  // CONTROL: a block whose FIRST sentence already carries the tell has no seam to
  // cut — rule and evidence share a clause. It must refuse rather than invent one.
  it('CONTROL — refuses when the tell is in the first sentence (no clean seam)', () => {
    expect(splitRuleEvidence('Measured 2026-08-02, the lock was routed around and the peer edit was lost.')).toBeNull();
  });

  // CONTROL: no tell at all means nothing to separate.
  it('CONTROL — refuses a block with no evidence tell', () => {
    expect(splitRuleEvidence('Never route around a blocked lock. Pivot, retry, or yield instead.')).toBeNull();
  });
});

describe('sentenceBoundaries — spans that must never be cut', () => {
  // The mis-cut that motivated masking: a bold lede containing '?' was split in
  // half, yielding a "rule" that ended mid-clause.
  it('does not cut inside a bold lede containing a question mark', () => {
    const raw = '**Is my change live, and if not what is blocking it?** Read the position tool.';
    expect(sentenceBoundaries(raw).every((o) => o > raw.indexOf('**', 2))).toBe(true);
  });

  it('does not cut on a decimal, an abbreviation, or a dotted path', () => {
    expect(sentenceBoundaries('It exits 1 in ~0.15s. Next.')).toHaveLength(1);
    expect(sentenceBoundaries('Prefer a tool, e.g. the gate. Then re-run.')).toHaveLength(1);
    expect(sentenceBoundaries('See green-checkpoint.ts for the recursion. Then stop.')).toHaveLength(1);
  });

  // Blockquotes: a sentence ending at a line break is followed by "\n> ", so the
  // sentence-start class never matched and every `>` block reported ZERO
  // boundaries — reading as unsplittable prose. CALIBRATION for that fix.
  it('finds boundaries inside a hard-wrapped blockquote', () => {
    expect(sentenceBoundaries('> A rule stated here.\n> Another sentence follows.').length).toBeGreaterThan(0);
  });
});

describe('tellsIn — citation position, not bare word match', () => {
  it('fires on a cited observation', () => {
    expect(tellsIn('Measured 2026-08-03: the gate red-pinned.')).toContain('date');
    expect(tellsIn('The fix is WI-7035.')).toContain('artifact-id');
  });

  // CONTROL: these are the false positives that pushed 13 rule-only blocks into
  // the entangled pile. Each uses an observation verb as ordinary rule prose.
  it('CONTROL — does NOT fire on an observation verb used as ordinary prose', () => {
    expect(tellsIn('A probe negative covers only the conditions it reproduced.')).toEqual([]);
    expect(tellsIn('Read the row that says what it costs.')).toEqual([]);
  });
});

describe('citationsIn — the authored-pair invariant', () => {
  it('extracts ids, dates, clock times and backticked identifiers', () => {
    const c = citationsIn('On 2026-08-02 at 08:37Z, `dev:pipeline_position` fixed WI-7035.');
    expect(c).toContain('2026-08-02');
    expect(c).toContain('08:37Z');
    expect(c).toContain('dev:pipeline_position');
    expect(c).toContain('WI-7035');
  });

  // Regression #1: a code span wrapped across a hard line break could not match,
  // so the scanner paired that span's CLOSING backtick with the next OPENING one
  // and minted a citation out of the prose between them.
  it('extracts a code span that WRAPS across a line, and mints no phantom', () => {
    const c = citationsIn('Run `node scripts/next-migration.mjs --name <slug>\n  --intent "x"` (or `npm run db:next-migration`) FIRST.');
    expect(c).toContain('npm run db:next-migration');
    expect([...c].some((x) => x.startsWith('(or'))).toBe(false);
  });

  // Regression #2: a SINGLE-character span was skipped by a {2,} minimum, leaving
  // its backticks unconsumed so every later pairing in the block was off by one.
  it('consumes a single-character span without recording it, keeping later pairs aligned', () => {
    const c = citationsIn('Any `;`- or `&&`-chained command, then `capability:bash` returns `exit_code`.');
    expect(c).toContain('capability:bash');
    expect(c).toContain('exit_code');
    expect(c).not.toContain(';');
  });

  // Regression #3: a ``` fence is not a span delimiter, and leaving its three
  // backticks in front of the inline scanner unbalanced everything after it.
  it('removes fenced blocks so inline pairing after a fence stays aligned', () => {
    const c = citationsIn('Before.\n\n```bash\nnpx tsc --noEmit\n```\n\nAfter, `lint:tsc:operator` covers it.');
    expect(c).toContain('lint:tsc:operator');
  });
});

describe('droppedCitations — CONTROLS that must FAIL', () => {
  const ORIGINAL = 'Prefer `work_items:claimable`. Measured 2026-08-02 (WI-6409): a raw query overcounted ~13x.';

  it('CALIBRATION — a faithful re-authoring drops nothing', () => {
    const faithful = 'Prefer `work_items:claimable` over a raw floor query.\nMeasured 2026-08-02 (WI-6409): the raw query overcounted ~13x.';
    expect(droppedCitations(ORIGINAL, faithful)).toEqual([]);
  });

  it('CONTROL — catches a dropped work-item id', () => {
    expect(droppedCitations(ORIGINAL, 'Prefer `work_items:claimable`. Measured 2026-08-02: it overcounted.')).toEqual(['WI-6409']);
  });

  it('CONTROL — catches a dropped date', () => {
    expect(droppedCitations(ORIGINAL, 'Prefer `work_items:claimable` (WI-6409): it overcounted.')).toEqual(['2026-08-02']);
  });

  it('CONTROL — catches a dropped tool name', () => {
    expect(droppedCitations(ORIGINAL, 'Prefer the claimable tool. Measured 2026-08-02 (WI-6409).')).toEqual(['work_items:claimable']);
  });
});

describe('buildRuleEvidence — every block is accounted for', () => {
  const DOC = [
    '# Doc',
    '',
    'Never route around a blocked lock, because that lock is a peer in-flight edit. Measured 2026-08-02: an agent renamed the file (WI-7101).',
    '',
    'A rule with no evidence tell at all.',
    '',
    'Measured 2026-08-02 (WI-1): rule and evidence share this one clause.',
    '',
  ].join('\n');

  it('classifies every block into exactly one mode and loses none', () => {
    const a = buildRuleEvidence(DOC, {});
    const { total, clean, split, authored, needsAuthoring } = a.summary;
    expect(clean + split + authored + needsAuthoring).toBe(total);
    expect(a.pairs).toHaveLength(total);
    expect(a.summary.split).toBeGreaterThan(0);
    expect(a.summary.clean).toBeGreaterThan(0);
    expect(a.summary.needsAuthoring).toBeGreaterThan(0);
  });

  // An authored pair keyed by a sha that is no longer present must NOT be applied
  // to whatever block drifted into that position — the D-011 renumbering failure.
  it('CONTROL — an authored pair whose blockSha is absent is never applied', () => {
    const a = buildRuleEvidence(DOC, { deadbeefdeadbeef: { rule: 'r', evidence: 'e' } });
    expect(a.summary.authored).toBe(0);
    expect(a.pairs.some((p: { mode: string }) => p.mode === 'authored')).toBe(false);
  });

  it('CONTROL — an authored pair that drops a citation is reported as a problem', () => {
    const target = buildRuleEvidence(DOC, {}).pairs.find((p: { mode: string }) => p.mode === 'needs-authoring');
    const a = buildRuleEvidence(DOC, { [target.blockSha]: { rule: 'Rule with no referents.', evidence: 'Nothing cited.' } });
    expect(a.problems.length).toBeGreaterThan(0);
    expect(a.problems[0]).toMatch(/drops \d+ citation/);
  });
});
