/**
 * P-004 (fleet-leadership-continuity-and-actuation-2026-08-01) — a worked-and-released item must
 * be programmatically DISTINGUISHABLE from a never-started one at EVERY read surface an agent uses
 * to decide whether to build.
 *
 * The WI-6096 shape: a compaction released a claim and lost the checkpoint on a fully-built,
 * CI-wired feature. The row was then open, unassigned and checkpoint-less — byte-identical, to
 * every reader, to work nobody had ever touched. An agent claimed it and started rebuilding.
 *
 * P-001 added the `priorWork` banner for exactly that. This test exists because a guard wired into
 * SOME read surfaces looks finished from any single one of them: the failure is only visible when
 * you ask all three the same question side by side. It earned its keep immediately — P-001 named
 * `work_items:claim`, `work_items:get` AND `scheduler:get_next`, but shipped only the first two,
 * leaving the hole in the primary SELF-PULL path every fleet member claims through. This is the
 * regression test for that whole class, not for one call.
 *
 * SURFACE-COVERAGE is asserted structurally (the list below), so ADDING a new claim-decision read
 * surface without the banner fails here rather than silently reopening the gap.
 */
import { describe, expect, it } from 'vitest';
import { priorWorkWarning, parseWorkedByHistory } from './work-item-prior-work';

/**
 * The read surfaces an agent uses to decide "is this fresh work?". Each must carry the banner.
 * Sourced by grep at authoring time; the assertion below pins that each named surface still
 * references the shared helper, so deleting the wiring reds THIS test with a clear reason.
 */
const CLAIM_DECISION_SURFACES = [
  'packages/operator-core/lib/agent-tools/work_items/claim.ts',
  'packages/operator-core/lib/agent-tools/work_items/get.ts',
  'packages/operator-core/lib/agent-tools/scheduler/get_next.ts',
] as const;

/** EI-18765234433145274's revalidation signal belongs on every surface that COMMITS a claim. */
const CLAIM_COMMIT_SURFACES = [
  'packages/operator-core/lib/agent-tools/work_items/claim.ts',
  'packages/operator-core/lib/agent-tools/scheduler/get_next.ts',
  'packages/operator-core/lib/agent-tools/work_items/claim_next.ts',
] as const;

describe('P-004 — prior work is distinguishable at every claim-decision surface', () => {
  it.each(CLAIM_DECISION_SURFACES)('%s wires the prior-work banner', async (rel) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    // repo root = four levels up from packages/operator-core/lib
    const abs = resolve(__dirname, '../../..', rel);
    const src = await readFile(abs, 'utf8');
    expect(
      src.includes('getClaimTimePriorWorkHint'),
      `${rel} must surface the P-001 prior-work banner — an already-worked item is otherwise ` +
        `indistinguishable from never-started work on this surface`,
    ).toBe(true);
    expect(
      src.includes('currentClaimant'),
      `${rel} must identify the post-claim holder so migration 806's current history entry ` +
        `cannot manufacture a prior-work warning for a fresh claim`,
    ).toBe(true);
  });

  const worked = {
    lastReleasedBy: 'su-A',
    releasedAtMs: Date.now() - 3_600_000,
    attempts: 1,
    priorWorkers: ['su-A', 'su-B'],
  };

  it('the banner ESCALATES when no checkpoint exists — the WI-6096 case exactly', () => {
    const withCheckpoint = priorWorkWarning({ ...worked, hasCheckpoint: true });
    const without = priorWorkWarning({ ...worked, hasCheckpoint: false });
    expect(withCheckpoint).toBeTruthy();
    expect(without).toBeTruthy();
    // Both must name the item as already-worked...
    expect(withCheckpoint).toContain('PRIOR WORK');
    expect(without).toContain('PRIOR WORK');
    // ...but the checkpoint-LESS case is the dangerous one (no other guard flags it: there is no
    // checkpoint for EI-529 to show, and the row is not terminal for WI-5826 to catch), so it
    // must not be the quieter of the two.
    expect(without!.length).toBeGreaterThanOrEqual(withCheckpoint!.length);
  });

  it('carries the provenance an agent needs to go READ the prior work', () => {
    const warn = priorWorkWarning({ ...worked, hasCheckpoint: false })!;
    expect(warn).toContain('su-A'); // who released it
    expect(warn).toContain('su-B'); // who else worked it
    expect(warn).toContain('prior claim attempt'); // that it was attempted
  });

  it('stays SILENT for a genuinely never-started item (the negative control)', () => {
    // A never-started row yields a NULL hint from getClaimTimePriorWorkHint — that is where the
    // silence comes from, so a null hint must never render a banner.
    expect(priorWorkWarning(null)).toBeFalsy();
  });

  it('treats a release with no surviving checkpoint as prior work (not as fresh)', () => {
    // The minimal WI-6096 row: released once, never attempted again, no checkpoint left behind.
    expect(
      priorWorkWarning({
        lastReleasedBy: 'su-A',
        releasedAtMs: Date.now() - 60_000,
        attempts: 0,
        priorWorkers: [],
        hasCheckpoint: false,
      }),
    ).toBeTruthy();
  });

  it('parseWorkedByHistory tolerates the shapes the column actually holds', () => {
    expect(parseWorkedByHistory(null)).toEqual([]);
    expect(parseWorkedByHistory(['su-A', 'su-B'])).toEqual(['su-A', 'su-B']);
    // Rows are also written as objects; the reader must accept both spellings.
    expect(parseWorkedByHistory([{ owner: 'su-A' }, { ownerId: 'su-B' }])).toEqual(['su-A', 'su-B']);
    expect(parseWorkedByHistory(['  ', 'su-C'])).toEqual(['su-C']);
    expect(parseWorkedByHistory('not an array')).toEqual([]);
  });
});

describe('EI-18765234433145274 — ended-author revalidation is visible on every claim surface', () => {
  it.each(CLAIM_COMMIT_SURFACES)('%s wires the shared authorship advisory', async (rel) => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const src = await readFile(resolve(__dirname, '../../..', rel), 'utf8');
    expect(src).toContain('getClaimTimeAuthorshipRevalidationHint');
    expect(src).toContain('authorshipRevalidationWarning');
    expect(src).toContain('authorshipRevalidation');
  });
});
