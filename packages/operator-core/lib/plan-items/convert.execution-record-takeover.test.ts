/**
 * EI-22427741014249929 — `plans:set-status wip` (via convert-at-pickup) silently
 * stole the linked work-item off a LIVE peer.
 *
 * The resume path called `claimWorkItem`, and on failure force-released and
 * re-claimed on the stated assumption that a failed claim means a LAPSED peer.
 * That assumption is false: `claimWorkItem`'s compare-and-claim refuses ANY held
 * row regardless of its holder's liveness, so the two cases are indistinguishable
 * at that call site and the unconditional release transferred live peers'
 * execution records mid-lane (observed twice in ~10min, on P-003 and P-004).
 *
 * `work_items:claim` has required a checked verdict for the same mutation since
 * WI-4198. These pin the plan-item path to the SAME verdict, so the two surfaces
 * cannot drift back into opposite safety postures for one write.
 */
import { describe, expect, it } from 'vitest';
import { assessExecutionRecordTakeover } from './convert';

const BASE = {
  callerOwnerId: 'su-caller',
  holderOwnerId: 'su-holder',
  workspaceId: 'ws',
  itemLastProgressAt: null,
};

describe('assessExecutionRecordTakeover', () => {
  it('REFUSES the takeover when the guard says the holder is still live', async () => {
    const res = await assessExecutionRecordTakeover(BASE, {
      assess: async () => ({ allowed: false }),
    });
    expect(res.allowed).toBe(false);
  });

  it('ALLOWS the takeover when the guard authorizes it, and carries the basis through', async () => {
    const res = await assessExecutionRecordTakeover(BASE, {
      assess: async () => ({ allowed: true, basis: 'holder-not-live' }),
    });
    expect(res.allowed).toBe(true);
    expect(res.basis).toBe('holder-not-live');
  });

  it('passes the caller, holder, workspace and progress stamp through to the guard', async () => {
    const seen: unknown[] = [];
    await assessExecutionRecordTakeover(
      { ...BASE, itemLastProgressAt: '2026-09-05T13:00:00.000Z' },
      {
        assess: async (i) => {
          seen.push(i);
          return { allowed: true, basis: 'holder-not-live' };
        },
      },
    );
    expect(seen).toEqual([
      {
        callerOwnerId: 'su-caller',
        holderOwnerId: 'su-holder',
        workspaceId: 'ws',
        itemLastProgressAt: '2026-09-05T13:00:00.000Z',
      },
    ]);
  });

  it('does not consult the guard at all when the caller ALREADY holds the record', async () => {
    let called = 0;
    const res = await assessExecutionRecordTakeover(
      { ...BASE, holderOwnerId: 'su-caller' },
      {
        assess: async () => {
          called += 1;
          return { allowed: false };
        },
      },
    );
    expect(res.allowed).toBe(true);
    expect(called).toBe(0); // reclaiming your own record is not a cross-holder takeover
  });

  it('FAILS CLOSED when the guard is unavailable — an unknown verdict must not authorize a seizure', async () => {
    const res = await assessExecutionRecordTakeover(BASE, {
      assess: async () => {
        throw new Error('oracle down');
      },
    });
    expect(res.allowed).toBe(false);
  });

  /**
   * Falsifiability control. Every assertion above is satisfied by a stub `assess`;
   * none of them proves the ordering that makes the fix real — that the REFUSAL is
   * reached from a LIVE-holder verdict rather than from the self-holder short
   * circuit. A deliberately-wrong implementation that returned `{allowed:true}`
   * unconditionally passes the self-holder case and the allow case, so this pins
   * the one pairing that separates the fix from the bug: same input shape, opposite
   * verdicts, driven only by what the guard said.
   */
  it('control: the verdict tracks the guard, not the inputs', async () => {
    const refuse = await assessExecutionRecordTakeover(BASE, { assess: async () => ({ allowed: false }) });
    const allow = await assessExecutionRecordTakeover(BASE, {
      assess: async () => ({ allowed: true, basis: 'holder-warm-idle' }),
    });
    expect([refuse.allowed, allow.allowed]).toEqual([false, true]);
    expect(allow.basis).toBe('holder-warm-idle');
  });
});
