/** maintenance-carry (deterministic-context-carry P-017 deterministic core): the
 *  producer that turns an ownerId into the `{ summary }` shape omp's remote-
 *  compaction client expects — buildCarryDoc → renderCarryDoc held to budget B,
 *  fail-soft to null (→ the caller falls back to the LLM summarizer, never
 *  strands a compaction). */
import { describe, it, expect, vi } from 'vitest';
import type { CarryBrief } from './carry-brief';
import { renderCarryDoc, carryDocBudgetChars, type CarryDoc, type CarryDocContinuation } from './carry-doc';
import { buildMaintenanceCarrySummary, renderMaintenanceCarrySummary } from './maintenance-carry';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-1',
    loop: { harness: 'papercusp', active: true, intervalSec: 60, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

const NO_OWNER: CarryDocContinuation = { lastOwnerMessage: null, answered: true, deliberate: false, selfRequested: false };

function doc(over: Partial<CarryDoc> = {}): CarryDoc {
  return {
    brief: brief(),
    identity: {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      fleet: null,
      account: null,
    },
    sessionMode: {
      modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }],
      loopActive: true,
      loopIntervalSec: 60,
    },
    planItems: [],
    asks: [],
    tail: [],
    continuation: NO_OWNER,
    ...over,
  };
}

describe('renderMaintenanceCarrySummary — pure', () => {
  it('renders the doc to the { summary } shape at budget B, wired through renderCarryDoc', () => {
    const out = renderMaintenanceCarrySummary(doc(), { effectiveWindowTokens: 400_000, now: NOW });
    expect(out).not.toBeNull();
    expect(out!.deterministic).toBe(true);
    expect(out!.budgetChars).toBe(carryDocBudgetChars(400_000));
    // The summary IS renderCarryDoc held to that exact budget — wired through, not re-implemented.
    expect(out!.summary).toBe(renderCarryDoc(doc(), NOW, { budgetChars: out!.budgetChars }).trim());
    // Minimum-viable orientation the successor summarizer folds in.
    expect(out!.summary).toContain('Carry document (deterministic');
    expect(out!.summary).toContain('su · su-1');
    expect(out!.summary).toContain('Self-recall');
  });

  it('floors the budget to a coherent tail when no window is supplied', () => {
    const out = renderMaintenanceCarrySummary(doc(), { now: NOW });
    expect(out).not.toBeNull();
    expect(out!.budgetChars).toBe(carryDocBudgetChars(0)); // the floor
  });

  it('holds the summary within the constant budget B', () => {
    const bigTail = doc({
      tail: Array.from({ length: 8 }, (_, i) => ({ speaker: 'assistant' as const, text: 'x'.repeat(6000) + ` t${i}`, ts: null })),
    });
    const out = renderMaintenanceCarrySummary(bigTail, { effectiveWindowTokens: 1000, now: NOW });
    expect(out).not.toBeNull();
    expect(out!.summary.length).toBeLessThanOrEqual(out!.budgetChars);
  });

  it('returns null when the render yields no usable text (→ LLM fallback, not an empty summary)', () => {
    const out = renderMaintenanceCarrySummary(doc(), { now: NOW, renderFn: () => '   \n  ' });
    expect(out).toBeNull();
  });
});

describe('buildMaintenanceCarrySummary — impure edge, fail-soft', () => {
  it('assembles then renders, forcing boundaryDeliberate:false (a compaction is a forced cut)', async () => {
    const buildFn = vi.fn(async () => doc());
    const out = await buildMaintenanceCarrySummary('su-1', { effectiveWindowTokens: 400_000, now: NOW, buildFn });
    expect(out).not.toBeNull();
    expect(out!.deterministic).toBe(true);
    expect(out!.summary).toContain('Carry document (deterministic');
    expect(buildFn).toHaveBeenCalledTimes(1);
    expect(buildFn).toHaveBeenCalledWith('su-1', expect.objectContaining({ boundaryDeliberate: false }));
  });

  it('threads buildOpts through (workspaceId, harness, …) while keeping the forced-cut default', async () => {
    const buildFn = vi.fn(async () => doc());
    await buildMaintenanceCarrySummary('su-1', {
      buildFn,
      buildOpts: { workspaceId: 'ws-9', harness: 'papercusp' },
    });
    expect(buildFn).toHaveBeenCalledWith(
      'su-1',
      expect.objectContaining({ boundaryDeliberate: false, workspaceId: 'ws-9', harness: 'papercusp' }),
    );
  });

  it('lets an explicit buildOpts.boundaryDeliberate override the forced-cut default', async () => {
    const buildFn = vi.fn(async () => doc());
    await buildMaintenanceCarrySummary('su-1', { buildFn, buildOpts: { boundaryDeliberate: true } });
    expect(buildFn).toHaveBeenCalledWith('su-1', expect.objectContaining({ boundaryDeliberate: true }));
  });

  it('a blank / whitespace ownerId ⇒ null and never builds', async () => {
    const buildFn = vi.fn(async () => doc());
    expect(await buildMaintenanceCarrySummary('', { buildFn })).toBeNull();
    expect(await buildMaintenanceCarrySummary('   ', { buildFn })).toBeNull();
    expect(buildFn).not.toHaveBeenCalled();
  });

  it('trims the ownerId before building (URL params can arrive padded)', async () => {
    const buildFn = vi.fn(async () => doc());
    await buildMaintenanceCarrySummary('  su-1  ', { buildFn });
    expect(buildFn).toHaveBeenCalledWith('su-1', expect.anything());
  });

  it('a throwing build ⇒ null (fail-soft, so the caller falls back to the LLM path)', async () => {
    const buildFn = vi.fn(async () => {
      throw new Error('db down');
    });
    expect(await buildMaintenanceCarrySummary('su-1', { buildFn })).toBeNull();
  });

  it('a build that renders to blank ⇒ null even though the build succeeded', async () => {
    const buildFn = vi.fn(async () => doc());
    const out = await buildMaintenanceCarrySummary('su-1', { buildFn, renderFn: () => '  ' });
    expect(out).toBeNull();
  });
});
