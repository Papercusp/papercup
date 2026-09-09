/**
 * effort-scoped-continuity-2026-09-02 — P-009.
 *
 * These are the falsifiers for the plan's load-bearing claims, not coverage for its
 * own sake. Each `it` names the measured failure it guards against, because the whole
 * plan exists to stop knowledge being destroyed silently, and a test that cannot say
 * WHAT it would catch is the same failure one level up.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTAINMENT_LEVEL,
  DESCENDANT_FANOUT_CAP,
  goalThreadRef,
  mostSpecificLevel,
  planThreadRef,
} from './containment-tree';
import { extractPriorAttemptRungs, retractionText } from './prior-attempt-rungs';
import { describeCaptureGaps } from './effort-thread';
import {
  buildBoundedPriorAttemptBrief,
  collectPriorAttempts,
  compilePriorAttempts,
  getClaimTimePriorAttemptBrief,
  CLAIM_BRIEF_TOKEN_CEILING,
  ORPHAN_CLAIM_BRIEF_BUDGET,
  type PriorAttemptSource,
} from './prior-attempt-context';
import type { WorkItem } from './work-items';

// ── containment tree (P-016 / P-020) ────────────────────────────────────────────

describe('containment tree identity (P-016)', () => {
  it('REFUSES an unqualified plan thread ref, because a bare slug is not unique across harnesses', () => {
    // The same failure `workItemObjectRef` fails loud on for feature refs: two
    // harnesses can hold the same plan_slug, and an unqualified parent_ref would
    // silently MERGE their two histories into one thread. A wrong answer that looks
    // like a right one is exactly what this plan exists to remove, so it throws
    // rather than defaulting to `:<slug>`.
    expect(() => planThreadRef(null, 'my-plan')).toThrow(/no harness/);
    expect(() => planThreadRef('  ', 'my-plan')).toThrow(/no harness/);
    expect(() => planThreadRef('*', 'my-plan')).toThrow(/no harness/);
    expect(planThreadRef('papercusp', 'my-plan')).toBe('papercusp:my-plan');
  });

  it('leaves a goal ref unqualified — goal ids are workspace-unique, unlike plan slugs', () => {
    expect(goalThreadRef('goal-123')).toBe('goal-123');
  });

  it('orders levels coarse → fine so "a contains b" is a comparison, not a lookup table', () => {
    expect(CONTAINMENT_LEVEL.goal).toBeLessThan(CONTAINMENT_LEVEL.plan);
    expect(CONTAINMENT_LEVEL.plan).toBeLessThan(CONTAINMENT_LEVEL.work_item);
  });

  it('defaults the write level to the MOST SPECIFIC ref held — the item, for 94% of work', () => {
    // Measured 2026-09-02: of 16,792 open items, 15,791 (94.0%) carry neither a plan
    // nor a goal. Defaulting anywhere else would mis-file the common case.
    expect(mostSpecificLevel({ workItemId: 'WI-1', planSlug: 'p', goalId: 'g' })).toBe('work_item');
    expect(mostSpecificLevel({ planSlug: 'p', goalId: 'g' })).toBe('plan');
    expect(mostSpecificLevel({ goalId: 'g' })).toBe('goal');
    expect(mostSpecificLevel({})).toBeNull();
    expect(mostSpecificLevel({ workItemId: '   ' })).toBeNull();
  });

  it('caps descendant fan-out below the measured worst plan, so a 126-item rollup cannot be silent', () => {
    expect(DESCENDANT_FANOUT_CAP).toBeGreaterThanOrEqual(16); // admits the measured p90 plan whole
    expect(DESCENDANT_FANOUT_CAP).toBeLessThan(126); // and must NOT admit the measured worst one
  });
});

// ── the extractor, and D-010's correction (P-015) ───────────────────────────────

describe('prior-attempt rungs (D-010)', () => {
  it('populates a rung only when the writer used the trigger vocabulary', () => {
    // This is D-010's whole claim, made executable. The measured consequence: 95.6% of
    // work-item checkpoints yield NO rootCause and 97.5% no falsePremise — so a reader
    // that assumes the rungs are data will compress structure that was never produced.
    const withWords = extractPriorAttemptRungs('Root cause: the lock was never released.\nFollow-up: audit peers.');
    expect(withWords.rootCauses).toHaveLength(1);
    expect(withWords.residue).toHaveLength(1);

    const sameContentNoWords = extractPriorAttemptRungs(
      'The lock was never released, which is why it hung.\nSomeone should audit peers.',
    );
    expect(sameContentNoWords.rootCauses).toEqual([]);
    expect(sameContentNoWords.residue).toEqual([]);
  });

  it('shares one vocabulary between the retraction predicate and the falsePremises rung', () => {
    // Two copies of these patterns would drift, and the drift would be invisible: a
    // note could read as a retraction while yielding no falsePremise, or vice versa.
    const text = 'This was wrong — the earlier count came from the wrong table.';
    expect(retractionText(text)).toBe(true);
    expect(extractPriorAttemptRungs(text).falsePremises).toHaveLength(1);
    expect(retractionText('Ordinary progress note.')).toBe(false);
  });

  it('is stateless across calls despite the /g regexes it shares', () => {
    // A module-level /g regex carries `lastIndex` between calls, so the SECOND call
    // silently under-matches. Every rung would then be populated or not depending on
    // call order — the worst kind of bug for a surface whose output is advisory.
    const once = extractPriorAttemptRungs('Root cause: A');
    const twice = extractPriorAttemptRungs('Root cause: A');
    expect(twice).toEqual(once);
    expect(retractionText('was wrong')).toBe(retractionText('was wrong'));
  });
});

describe('write-time capture advisory (D-010)', () => {
  it('names the missing rung AND the words that would populate it', () => {
    // D-010: the fix is feedback, not instruction, because an agent re-reading its own
    // note finds it clear — it still holds the context the note depends on. The reader
    // is weeks later with that prior absent by construction.
    const advisory = describeCaptureGaps('Retried the suite. Still failing on the same file.');
    expect(advisory.missing.map((m) => m.rung)).toContain('rootCauses');
    expect(advisory.note).toMatch(/root\s*cause/i);
  });

  it('goes SILENT once the note carries the rungs — an advisory that always fires is unread', () => {
    const advisory = describeCaptureGaps(
      'Root cause: the pool was exhausted.\nFalse premise: I assumed the retry was idempotent.\nStill open: audit the other callers.',
    );
    expect(advisory.missing).toEqual([]);
    expect(advisory.note).toBeNull();
    expect(advisory.found).toEqual(expect.arrayContaining(['rootCauses', 'falsePremises', 'residue']));
  });
});

// ── the depth ladder and its honest degradation (P-015 / D-008 / D-010) ─────────

function source(overrides: Partial<PriorAttemptSource> = {}): PriorAttemptSource {
  return {
    scope: 'plan-wide',
    authority: 'comment',
    rawRef: 'WI-1#comment:1',
    workItemId: 'WI-1',
    at: '2026-09-02T12:00:00.000Z',
    text: 'An ordinary attempt note with no trigger vocabulary in it at all.',
    ...overrides,
  };
}

describe('rollup compression ladder (D-008, corrected by D-010)', () => {
  it.each([0, 1, 2, 4])('preserves captured corrections and residue at depth %i under growing fan-out', (depth) => {
    const correction = [
      'Root cause: the stored read swallowed a failure.',
      'False premise: an empty read proved there was no saved lesson.',
      'Outcome: the original note was recovered.',
      'Residue: verify the next consumer.',
    ].join('\n');
    const ordinary = [
      'Approach: read the stored note.',
      'Outcome: the original note was recovered.',
      'Root cause: the stored read swallowed a failure.',
      'Residue: verify the next consumer.',
    ].join('\n');
    expect(describeCaptureGaps(correction).missing).toEqual([]);
    for (const fanOut of [1, 8, DESCENDANT_FANOUT_CAP]) {
      const notes = Array.from({ length: fanOut }, (_, i) => source({
        rawRef: `WI-${i}#checkpoint`, workItemId: `WI-${i}`, authority: 'checkpoint',
        text: ordinary, depth,
      }));
      const compiled = compilePriorAttempts([
        source({ rawRef: 'plan#correction', authority: 'retraction', text: correction, depth }),
        ...notes,
      ]);
      const brief = buildBoundedPriorAttemptBrief(compiled, { maxChars: 6000, maxRecords: 16, maxTextChars: 400 })!;
      expect(brief.serializedChars).toBeLessThanOrEqual(6000);
      expect(brief.protectedRefs.authority).toContainEqual({ authority: 'retraction', rawRef: 'plan#correction' });
      for (const note of notes) {
        expect(brief.protectedRefs.residue).toContain(note.rawRef);
        // A retained detail or explicit omission must always name the original
        // immutable reference; no reduction invents a replacement lesson.
        expect(compiled.records.find((record) => record.rawRef === note.rawRef)?.text).toBe(ordinary);
      }
      for (const record of brief.attempts) {
        expect(record.rootCauses).toEqual(['the stored read swallowed a failure.']);
        if (depth >= 2) {
          expect(record.text).toBe('');
          expect(record.outcome).toBeUndefined();
        } else {
          // Checkpoints summarize the complete note in approach; outcome is
          // reserved for verified-completion records, not an "Outcome:" keyword.
          expect(record.approach).toContain('the original note was recovered.');
        }
      }
      const retainedCorrection = brief.authority.find((record) => record.rawRef === 'plan#correction');
      expect(retainedCorrection?.falsePremises).toEqual(['an empty read proved there was no saved lesson.']);
      expect(brief.protectedRefs.residue).toContain('plan#correction');
      expect([...brief.authority, ...brief.attempts].every((record) =>
        compiled.records.some((original) => original.rawRef === record.rawRef &&
          original.authority === record.authority),
      )).toBe(true);
    }
  });

  it('keeps full text at depth 0 and drops it one level down', () => {
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        source({ rawRef: 'WI-1#checkpoint', authority: 'checkpoint', text: 'Full detail at the read root.', depth: 0 }),
        source({ rawRef: 'WI-2#checkpoint', authority: 'checkpoint', text: 'A child one level down.', depth: 1 }),
      ]),
    );
    const atRoot = brief!.attempts.find((a) => a.rawRef === 'WI-1#checkpoint');
    const oneDown = brief!.attempts.find((a) => a.rawRef === 'WI-2#checkpoint');
    expect(atRoot!.text).toContain('Full detail');
    expect(oneDown!.text).toBe('');
    // `approach` is the first bounded line of a checkpoint, so a child keeps a summary.
    expect(oneDown!.approach).toContain('A child one level down');
    expect(oneDown!.depth).toBe(1);
  });

  it('OMITS a deep record whose rungs are empty rather than emitting a hollow row', () => {
    // The D-010 correction. D-008 said "keep only rootCauses + falsePremises" two
    // levels down; measured, that keeps an EMPTY record 19 times in 20. A hollow row
    // spends bytes telling the reader nothing while looking like delivered history.
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        source({ rawRef: 'WI-3#checkpoint', authority: 'checkpoint', text: 'No trigger words anywhere here.', depth: 2 }),
      ]),
    );
    expect(brief!.attempts).toHaveLength(0);
    expect(brief!.omission.omittedRefs).toEqual([
      expect.objectContaining({ rawRef: 'WI-3#checkpoint', reason: 'empty-at-depth' }),
    ]);
  });

  it('distinguishes "raise the budget" from "nothing to see at this resolution"', () => {
    // The two reasons demand OPPOSITE reader actions, and a bare count cannot tell
    // them apart: `budget` means re-fetch, `empty-at-depth` means read it at its own
    // level because a re-fetch at this one returns the same nothing.
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        source({ rawRef: 'WI-4#checkpoint', authority: 'checkpoint', text: 'Root cause: a real finding.', depth: 2 }),
        source({ rawRef: 'WI-5#checkpoint', authority: 'checkpoint', text: 'Nothing structured here.', depth: 2 }),
      ]),
      { maxRecords: 1 },
    );
    // The one WITH a rung survives at depth 2; the one without is disclosed as empty.
    expect(brief!.attempts.map((a) => a.rawRef)).toEqual(['WI-4#checkpoint']);
    expect(brief!.omission.omittedRefs).toEqual([
      expect.objectContaining({ rawRef: 'WI-5#checkpoint', reason: 'empty-at-depth' }),
    ]);
  });

  it('keeps an ancestor-reached record at full resolution — depth is charged on DESCENT only', () => {
    // Charging depth to plan decisions or plan siblings would strip text a plan-backed
    // claim receives TODAY. That is a regression dressed as a budget fix, and it is the
    // easiest mistake to make when reading D-008 as "distance in the tree".
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([source({ rawRef: 'plan#D-001', authority: 'plan-decision', scope: 'plan-wide', text: 'A ruling with real body text.' })]),
    );
    expect(brief!.authority[0]!.text).toContain('A ruling with real body text');
  });
});

// ── the stated ceiling (P-021) ─────────────────────────────────────────────────

describe('claim-time token ceiling (P-021)', () => {
  it('states a ceiling at all — the gap D-008 needed a number for', () => {
    expect(CLAIM_BRIEF_TOKEN_CEILING).toBeGreaterThan(0);
    // 5% of the 250k fleet-member compaction cap (WI-2142006).
    expect(CLAIM_BRIEF_TOKEN_CEILING).toBeLessThanOrEqual(Math.round(250_000 * 0.05));
  });

  it('sizes the ORPHAN budget from the orphan population, not the plan-backed one', () => {
    // 50_000 chars was inherited from a surface serving the 5.8% of items that carry a
    // plan. An orphan's measured history is 1.38 posts averaging 962 chars; its own
    // ring is 15 x 600 = 9,000 worst case. Letting it inherit the larger budget repeats
    // D-006's error — sizing for a population the subject is not in.
    expect(ORPHAN_CLAIM_BRIEF_BUDGET.maxChars).toBeLessThan(50_000);
    expect(ORPHAN_CLAIM_BRIEF_BUDGET.maxChars).toBeGreaterThanOrEqual(9_000 + 2_000);
    expect(Math.ceil(ORPHAN_CLAIM_BRIEF_BUDGET.maxChars / 4)).toBeLessThan(CLAIM_BRIEF_TOKEN_CEILING);
  });

  it('holds the ceiling against a history far larger than any budget', () => {
    const sources = Array.from({ length: 400 }, (_, i) =>
      source({ rawRef: `WI-9#comment:${i}`, text: `Attempt ${i}. ${'z'.repeat(3_000)}` }),
    );
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources));
    expect(brief!.estimatedTokens).toBeLessThanOrEqual(CLAIM_BRIEF_TOKEN_CEILING);
    // And the omission is DISCLOSED rather than silent. Refs are lowest-priority by
    // design — they buy only the bytes content did not want — so under extreme
    // pressure the honest outcome is an empty ref list WITH `omittedRefsTruncated`,
    // not a ref list that evicts the history it describes. Either shape is fine; a
    // truncation that says neither is the failure.
    expect(brief!.omission.truncated).toBe(true);
    expect(brief!.omission.omittedRefs.length > 0 || brief!.omission.omittedRefsTruncated).toBe(true);
  });

  it('holds the ORPHAN ceiling on the orphan budget', () => {
    const sources = Array.from({ length: 60 }, (_, i) =>
      source({ scope: 'self', rawRef: `WI-9#checkpoint-journal:${i}`, authority: 'checkpoint', text: `Ring entry ${i}. ${'y'.repeat(600)}` }),
    );
    const brief = buildBoundedPriorAttemptBrief(compilePriorAttempts(sources), ORPHAN_CLAIM_BRIEF_BUDGET);
    expect(brief!.serializedChars).toBeLessThanOrEqual(ORPHAN_CLAIM_BRIEF_BUDGET.maxChars);
  });
});

// ── the gate P-018 removed ─────────────────────────────────────────────────────

const ORPHAN: WorkItem = {
  id: 'EI-777',
  family: 'issue',
  harness: 'papercusp',
  // The 94% shape: NO plan slug, NO plan item id, NO goal.
  sourcePlanSlug: null,
  sourcePlanItemIds: [],
  goalId: null,
  payload: {},
  updatedAt: '2026-09-02T12:00:00Z',
} as unknown as WorkItem;

function orphanDeps(overrides: Record<string, unknown> = {}) {
  return {
    // A plan-less read must not touch the plan stores at all; if it does, these throw
    // and the failure is legible instead of arriving as a fail-soft null brief.
    getPlan: async () => {
      throw new Error('getPlan must not be called for an item with no plan');
    },
    specs: async () => {
      throw new Error('specs must not be called for an item with no plan');
    },
    edges: async () => {
      throw new Error('edges must not be called for an item with no plan');
    },
    evidence: async () => [],
    item: async () => ORPHAN,
    items: async () => {
      throw new Error('items must not be called for an item with no plan');
    },
    thread: async () => ({
      posts: [{ id: 3, thread_id: 't', author_id: 'agent-b', body: 'Tried the obvious fix; it regressed the parser.', created_ts: '2026-09-01T10:00:00Z' }],
      total: 1,
      topics: [],
      createdAt: '2026-08-01T00:00:00Z',
    }),
    checkpoint: async () => ({ checkpoint: 'Current state: halfway through the migration.', updatedAtMs: Date.parse('2026-09-02T09:00:00Z') }),
    journal: async () => [
      { at: Date.parse('2026-09-01T09:00:00Z'), note: 'Root cause: the resolver was reading the wrong scope.' },
      { at: Date.parse('2026-08-30T09:00:00Z'), note: 'First pass: assumed a schema change was needed. It was not.' },
    ],
    lifecycle: async () => null,
    priorWork: async () => null,
    ...overrides,
  };
}

describe('P-018 — the claim-time briefing serves an item with NO plan', () => {
  it('returns a brief for an orphan, where the plan-pointer gate returned ZERO BYTES', () => {
    // THE REGRESSION GUARD FOR THIS WHOLE PLAN. `getClaimTimePriorAttemptBrief` opened
    // with `const pointer = planPointer(opts); if (!pointer) return null;`, so 94.0% of
    // open items (15,791 of 16,792, measured 2026-09-02) received nothing at claim —
    // not a partial brief, nothing. If this ever returns null again for an orphan that
    // has history, the gate is back.
    return getClaimTimePriorAttemptBrief({ workItem: ORPHAN, workItemId: 'EI-777' }, orphanDeps() as never).then(
      (brief) => {
        expect(brief).not.toBeNull();
        expect(brief!.attempts.length + brief!.authority.length).toBeGreaterThan(0);
      },
    );
  });

  it('files the orphan\'s own records at `self` — the rung a plan-anchored ladder had no word for', async () => {
    const compilation = await collectPriorAttempts({ workItemId: 'EI-777', harnessSlug: 'papercusp' }, orphanDeps() as never);
    expect(compilation.records.length).toBeGreaterThan(0);
    expect(compilation.records.every((r) => r.scope === 'self')).toBe(true);
  });

  it('delivers the P-003 trajectory ring, which is the point of having turned it on', async () => {
    // Before P-003 the ring did not exist: a work-item checkpoint was replace-on-write,
    // so week 3's agent destroyed week 1's reasoning in place. Storing it and never
    // reading it would be the same loss with extra steps.
    const compilation = await collectPriorAttempts({ workItemId: 'EI-777', harnessSlug: 'papercusp' }, orphanDeps() as never);
    const ringRefs = compilation.records.filter((r) => r.rawRef.includes('#checkpoint-journal:'));
    expect(ringRefs.length).toBeGreaterThan(0);
    expect(ringRefs.some((r) => r.rootCauses.length > 0)).toBe(true);
  });

  it('degrades to no ring rather than failing when the store predates P-003', async () => {
    // 10,326 rows were written before journaling was on. An absent ring must read as
    // "no ring", never as a collector error that fails the whole brief soft to null.
    const compilation = await collectPriorAttempts(
      { workItemId: 'EI-777', harnessSlug: 'papercusp' },
      orphanDeps({ journal: undefined }) as never,
    );
    expect(compilation.records.some((r) => r.rawRef === 'EI-777#checkpoint')).toBe(true);
    expect(compilation.records.some((r) => r.rawRef.includes('#checkpoint-journal:'))).toBe(false);
  });

  it('does not pay for the newest ring entry twice when it duplicates the live checkpoint', async () => {
    const live = 'Current state: halfway through the migration.';
    const compilation = await collectPriorAttempts(
      { workItemId: 'EI-777', harnessSlug: 'papercusp' },
      orphanDeps({ journal: async () => [{ at: Date.parse('2026-09-02T09:00:00Z'), note: live }] }) as never,
    );
    expect(compilation.records.filter((r) => r.text === live)).toHaveLength(1);
  });
});
