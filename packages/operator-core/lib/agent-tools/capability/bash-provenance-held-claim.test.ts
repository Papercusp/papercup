/**
 * Task provenance falls back to the caller's held claim (EI-21548894457555139).
 *
 * `resolveBashTaskProvenance` derived `workItemId` from the goal ref alone, and a goal
 * ref is only SOMETIMES a work-item id: a fleet leader declares `fleet:<slug>` and a
 * plan-bound agent declares `<plan>#P-NNN`. Both landed in the task ledger unlinked, so
 * `processes:list` could not answer "which work-item is this process for?" even while
 * the agent was holding one.
 *
 * The fallback is deliberately narrow. A fabricated work-item association is WORSE than
 * an absent one — absent reads as "unknown", wrong reads as fact and misattributes both
 * the cost and the provenance of a run — so it fires only when the held claim is
 * unambiguous. These tests pin that boundary in both directions.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveBashTaskProvenance } from './bash-task-provenance';

const OWNER = 'su-b5f45c90-be2b-4ad6-b9fc-a03353f6b3bb';

const heldItem = (id: string) => ({
  id,
  title: null,
  body: null,
  harness: 'papercusp',
  checkpoint: null,
});

function deps(over: {
  goalRef?: string | null;
  held?: Array<{ id: string }>;
  throws?: boolean;
}) {
  return {
    resolveIdentity: (() => ({ ownerId: OWNER })) as never,
    readStamp: (() => ({ goalRef: over.goalRef ?? null })) as never,
    resolveGoal: (async () => null) as never,
    readHeldWorkItems: (async () => {
      if (over.throws) throw new Error('pg down');
      return (over.held ?? []).map((h) => heldItem(h.id));
    }) as never,
  };
}

const CTX = { workspaceId: 'papercusp-workspace' } as never;

describe('bash task provenance — goal ref that IS a work-item id', () => {
  it('uses the goal ref directly and does not consult held claims', async () => {
    // Control: the pre-existing path must be unchanged.
    const readHeld = vi.fn(async () => []);
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'EI-21548894457555139' }),
      readHeldWorkItems: readHeld as never,
    });
    expect(p.workItemId).toBe('EI-21548894457555139');
    expect(readHeld).not.toHaveBeenCalled();
  });
});

describe('bash task provenance — goal ref that is NOT a work-item id', () => {
  it('falls back to the single held claim for a fleet-scoped goal', async () => {
    // The incident shape: a fleet leader whose goal ref names the fleet, not an item.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [{ id: 'EI-21548894457555139' }] }),
    });
    expect(p.workItemId).toBe('EI-21548894457555139');
  });

  it('falls back for a plan-item goal too, without disturbing planSlug', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'my-plan#P-003', held: [{ id: 'WI-1234' }] }),
    });
    expect(p.workItemId).toBe('WI-1234');
    expect(p.planSlug).toBe('my-plan');
  });
});

describe('bash task provenance — the fallback refuses to guess', () => {
  it('stays NULL when the caller holds SEVERAL items', async () => {
    // Two claims give no basis for choosing, and a wrong association reads as fact.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [{ id: 'WI-1' }, { id: 'WI-2' }] }),
    });
    expect(p.workItemId).toBeNull();
  });

  it('stays NULL when the caller holds nothing', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [] }),
    });
    expect(p.workItemId).toBeNull();
  });

  it('stays NULL — and still returns a usable provenance — when the read THROWS', async () => {
    // Provenance is fail-soft by contract: an unreadable claim must never block the shell.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', throws: true }),
    });
    expect(p.workItemId).toBeNull();
    expect(p.launchedBy).toBe(OWNER);
  });
});
