/**
 * carry-brief — unit tests (compaction-continuity-hardening-2026-07-07 P-003).
 *
 * The builder is exercised through its injectable seams (no PG); the renderers
 * are pure. The load-bearing contracts:
 *   - every read leg is independently best-effort (a throwing reader yields an
 *     empty section, never a failed brief);
 *   - the focus renderer is HARD-capped and pointer-styled (ids, not copies);
 *   - the cold-extras renderer skips empty sections and caps per-entry bytes.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCarryBrief,
  renderCarryBriefFocus,
  renderCarryBriefColdExtras,
  renderCarryBriefText,
  CARRY_BRIEF_FOCUS_MAX,
  CARRY_BRIEF_MAX_FACTS,
  CARRY_BRIEF_MAX_AWAITS,
  type CarryBrief,
  type BuildCarryBriefOpts,
} from './carry-brief';

function fullOpts(overrides: Partial<BuildCarryBriefOpts> = {}): BuildCarryBriefOpts {
  return {
    workspaceId: 'ws-test',
    getLoopStatusFn: async () => ({ harnessSlug: 'papercusp', active: true, intervalSec: 120 }),
    getLoopCarryNoteWithMetaFn: async () => ({
      note: '## Did\nlanded the thing\n\n## Next action\nship P-004',
      updatedAtMs: Date.now() - 5 * 60_000,
    }),
    readHeldWorkItemsFn: async () => [
      {
        id: 'WI-3319',
        title: 'Shared carry-brief builder',
        body: 'One function assembles the carry brief.',
        harness: 'papercusp',
        checkpoint: 'wired request-compaction; watchdog next',
      },
    ],
    listOwnerFactsFn: async () => [
      { key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' },
    ],
    listActiveAwaitsFn: async () => [
      { eventKey: 'coord:inbox-wake:su-abc', note: 'always-armed inbox-wake' },
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ],
    getFleetFn: async () => ({ slug: 'bug-drain', role: 'leader' }),
    ...overrides,
  };
}

describe('buildCarryBrief — assembly + per-leg fail-soft', () => {
  it('assembles every section from the injected readers', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.ownerId).toBe('su-abc');
    expect(brief.loop).toMatchObject({ harness: 'papercusp', active: true, intervalSec: 120 });
    expect(brief.loop?.carryNote).toContain('ship P-004');
    expect(brief.loop?.carryNoteUpdatedAtMs).toBeTypeOf('number');
    expect(brief.heldItems.map((h) => h.id)).toEqual(['WI-3319']);
    expect(brief.facts).toEqual([
      { key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' },
    ]);
    expect(brief.fleet).toEqual({ slug: 'bug-drain', role: 'leader' });
  });

  it('filters infra inbox-wake awaits and keeps real ones', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.awaits).toEqual([
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ]);
  });

  it('caps facts and awaits at the section bounds', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOwnerFactsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, body: `b${i}` })),
        listActiveAwaitsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ eventKey: `ev:${i}`, note: null })),
      }),
    );
    expect(brief.facts.length).toBe(CARRY_BRIEF_MAX_FACTS);
    expect(brief.awaits.length).toBe(CARRY_BRIEF_MAX_AWAITS);
  });

  it('a throwing leg yields that section empty, never a failed brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopStatusFn: async () => {
          throw new Error('pg down');
        },
        readHeldWorkItemsFn: async () => {
          throw new Error('pg down');
        },
        listOwnerFactsFn: async () => {
          throw new Error('pg down');
        },
        listActiveAwaitsFn: async () => {
          throw new Error('pg down');
        },
        getFleetFn: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(brief).toEqual({
      ownerId: 'su-abc',
      loop: null,
      heldItems: [],
      facts: [],
      awaits: [],
      fleet: null,
    });
  });

  it('a loop with no carry-note still reports the loop (note null)', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
    );
    expect(brief.loop).toMatchObject({ harness: 'papercusp', carryNote: null });
  });

  it('no loop routine ⇒ loop null', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts({ getLoopStatusFn: async () => null }));
    expect(brief.loop).toBeNull();
  });
});

describe('renderCarryBriefFocus — the /compact focus line', () => {
  it('names the real anchors as pointers, not copies', async () => {
    const focus = renderCarryBriefFocus(await buildCarryBrief('su-abc', fullOpts()));
    expect(focus).toContain('WI-3319');
    expect(focus).toContain('POINTERS');
    expect(focus).toContain('armed loop @papercusp 120s');
    expect(focus).toContain('zombie-pids-wall');
    expect(focus).toContain('deploy:done:release-77');
    expect(focus).toContain('fleet bug-drain (leader)');
    // The standing preserve set stays first; the drop clause survives.
    expect(focus.startsWith('keep the identity block')).toBe(true);
    expect(focus).toContain('drop resolved tool output');
    // It must NOT copy checkpoint/note bodies.
    expect(focus).not.toContain('wired request-compaction');
    expect(focus).not.toContain('ship P-004');
  });

  it('an empty brief renders exactly the standing preserve set', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(empty);
    expect(focus).toBe(
      'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.',
    );
  });

  it('is HARD-capped at the focus max, ellipsis-marked, for any brief size', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readHeldWorkItemsFn: async () =>
          Array.from({ length: 6 }, (_, i) => ({
            id: `WI-${9000 + i}`,
            title: 'long '.repeat(40),
            body: null,
            harness: 'papercusp',
            checkpoint: null,
          })),
        listOwnerFactsFn: async () =>
          Array.from({ length: 8 }, (_, i) => ({ key: `a-very-long-standing-fact-key-${i}`, body: 'x' })),
      }),
    );
    const focus = renderCarryBriefFocus(brief);
    expect(focus.length).toBeLessThanOrEqual(CARRY_BRIEF_FOCUS_MAX);
    expect(focus.endsWith('…')).toBe(true);
    // Held-item ids outrank facts under truncation (ordered most-load-bearing first).
    expect(focus).toContain('WI-9000');
  });
});

describe('renderCarryBriefColdExtras — the cold-anchor sections after the note', () => {
  it('renders held items with capped checkpoints, facts, awaits, and the fleet pointer', async () => {
    const out = renderCarryBriefColdExtras(await buildCarryBrief('su-abc', fullOpts()));
    expect(out).toContain('You still HOLD these work-items');
    expect(out).toContain('WI-3319 — Shared carry-brief builder');
    expect(out).toContain('checkpoint: wired request-compaction; watchdog next');
    expect(out).toContain('zombie-pids-wall: 3 zombie PIDs await owner OK to kill');
    expect(out).toContain('armed awaits are still live');
    expect(out).toContain('deploy:done:release-77');
    expect(out).toContain('Fleet: you are in "bug-drain" as leader');
    // The loop note is the injection core, NOT part of the extras.
    expect(out).not.toContain('ship P-004');
  });

  it('returns "" when the brief carries nothing beyond the loop note', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: { harness: 'h', active: true, intervalSec: 60, carryNote: 'n', carryNoteUpdatedAtMs: 1 },
      heldItems: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    expect(renderCarryBriefColdExtras(empty)).toBe('');
  });

  it('caps a long checkpoint and flags a missing one', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [
        { id: 'WI-1', title: null, body: null, harness: 'h', checkpoint: 'y'.repeat(2000) },
        { id: 'WI-2', title: null, body: null, harness: 'h', checkpoint: null },
      ],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    const ckptLine = out.split('\n').find((l) => l.includes('checkpoint: yyy'))!;
    expect(ckptLine.length).toBeLessThan(600);
    expect(ckptLine.endsWith('…')).toBe(true);
    expect(out).toContain('(no checkpoint written — read the item via work_items:get before acting)');
  });
});

describe('renderCarryBriefText — the full brief (P-004 recovery-hook payload)', () => {
  it('leads with the loop note + write age, then the extras sections', async () => {
    const now = Date.now();
    const out = renderCarryBriefText(await buildCarryBrief('su-abc', fullOpts()), now);
    expect(out).toContain('Armed loop @papercusp (active, every 120s)');
    expect(out).toContain('written 5m ago');
    expect(out).toContain('ship P-004'); // the note itself, verbatim
    expect(out.indexOf('Armed loop')).toBeLessThan(out.indexOf('You still HOLD'));
  });

  it('a loop with no note says so instead of rendering an empty block', async () => {
    const out = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
      ),
    );
    expect(out).toContain('No carry-note written.');
  });
});
