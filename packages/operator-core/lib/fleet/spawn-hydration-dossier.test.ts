/**
 * spawn-hydration-dossier — P-008/P-009 coverage for the precomputed work-item
 * DOSSIER folded into the ONE spawn/wake-hydration seam (bee-context-efficiency-2026-06-14).
 *
 * Locks the dossier composition rules in the PURE assembler (no DB / no flag store):
 *   - a present dossier rides as its OWN sibling block BEFORE `## Handoff`;
 *   - the dossier carries the hive roster (D-008), so the standalone `### Hive peers`
 *     section is SUPPRESSED when a dossier is present (no double roster, D-009);
 *   - absent/null dossier ⇒ byte-unchanged from the pre-P-008 behavior (roster stands);
 *   - the dossier is fail-soft (a throwing getDossier degrades to no dossier, never the
 *     whole block) and bounded (truncated at its own budget).
 *
 * The flag gate (CUP_WAKE_DOSSIER, P-009) lives in productionSpawnHydrationDeps
 * (impure binding) — the assembler just composes whatever getDossier returns.
 */
import { describe, it, expect, vi } from 'vitest';
import { assembleSpawnHydration, type SpawnHydrationDeps } from './spawn-hydration';

const DOSSIER = [
  '## Your work-item dossier — precomputed',
  '',
  '**WI-501** — Wire the thing [feature · in_progress] · acme',
  '',
  '### Hive peers (live roster snapshot)',
  '- bee-a (bee) — on WI-777',
].join('\n');

function deps(over: Partial<SpawnHydrationDeps> = {}): SpawnHydrationDeps {
  return {
    getRoster: async () => '- standalone-peer (bee) — on WI-999',
    getCheckpoint: async () => 'last checkpoint: did step 1',
    ...over,
  };
}

describe('spawn-hydration dossier (P-008/P-009)', () => {
  it('folds a present dossier as a sibling block before `## Handoff`', async () => {
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      deps: deps({ getDossier: async () => DOSSIER }),
    });
    expect(res.text).toContain('## Your work-item dossier — precomputed');
    expect(res.text).toContain('## Handoff');
    // dossier comes BEFORE the handoff block.
    expect(res.text.indexOf('## Your work-item dossier')).toBeLessThan(res.text.indexOf('## Handoff'));
    // the checkpoint (a handoff source) still rides the handoff block.
    expect(res.text).toContain('last checkpoint: did step 1');
  });

  it('suppresses the standalone `### Hive peers` section when the dossier carries the roster (D-008/D-009)', async () => {
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      deps: deps({ getDossier: async () => DOSSIER }),
    });
    // the standalone roster body must NOT appear; only the dossier's own roster does.
    expect(res.text).not.toContain('standalone-peer');
    expect(res.text).not.toContain('### Hive peers\n'); // the handoff sub-heading, not the dossier's `### Hive peers (...)`
    expect(res.text).toContain('### Hive peers (live roster snapshot)'); // the dossier's roster survives
  });

  it('is byte-unchanged from pre-P-008 when no dossier is present (roster stands)', async () => {
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      deps: deps(), // no getDossier
    });
    expect(res.text.startsWith('## Handoff')).toBe(true);
    expect(res.text).toContain('### Hive peers');
    expect(res.text).toContain('standalone-peer');
    expect(res.text).not.toContain('## Your work-item dossier');
  });

  it('emits only the dossier block when there is no handoff content', async () => {
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      // no roster/checkpoint/handoff sources — dossier is the only content.
      deps: { getDossier: async () => DOSSIER },
    });
    expect(res.text).toContain('## Your work-item dossier');
    expect(res.text).not.toContain('## Handoff'); // never an empty handoff heading
  });

  it('is fail-soft: a throwing getDossier degrades to no dossier, never the whole block', async () => {
    const log = vi.fn();
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      deps: deps({
        getDossier: async () => {
          throw new Error('dossier read blew up');
        },
      }),
      log,
    });
    // the rest of the block survives, with the standalone roster (no dossier to suppress it).
    expect(res.text).toContain('## Handoff');
    expect(res.text).toContain('standalone-peer');
    expect(res.text).not.toContain('## Your work-item dossier');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dossier source failed'));
  });

  it('bounds the dossier at its own budget (truncates trusted text at the boundary)', async () => {
    const big = '## Your work-item dossier — precomputed\n' + 'x'.repeat(10_000);
    const res = await assembleSpawnHydration({
      harness: 'acme',
      workItemId: 'WI-501',
      maxChars: 500,
      deps: { getDossier: async () => big },
    });
    expect(res.truncated).toBe(true);
    expect(res.text).toContain('…[truncated]');
    expect(res.text.length).toBeLessThan(big.length);
  });

  it('does not compute a dossier when there is no workItemId', async () => {
    const getDossier = vi.fn(async () => DOSSIER);
    const res = await assembleSpawnHydration({
      harness: 'acme',
      // no workItemId
      deps: { getDossier },
    });
    expect(getDossier).not.toHaveBeenCalled();
    expect(res.text).not.toContain('## Your work-item dossier');
  });
});
