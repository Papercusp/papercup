/**
 * WI-6662 — coord:roster must carry the SAME payload-tier shape as coord:presence.
 *
 * Both tools return the same assemblePresenceSnapshot payload, and the codebase
 * documents them as alternate doors onto it. But only coord:presence declared a
 * `shape`, so on a trimmed session the same question cost:
 *   coord:presence — 40 rows x ~17 fields
 *   coord:roster   — 130 rows x ~37 fields   (measured live, 2026-07-28)
 * That is presence-derivation-unification's per-surface divergence showing up in
 * the PAYLOAD lane rather than the verdict lane.
 *
 * The subtle half is the INTERACTION with WI-6658's explicit project/states lens:
 * both rewrite active[], and running the tier shaper over already-projected rows
 * RE-WIDENS them — handing a trimmed caller who asked for the cheapest form a
 * BIGGER payload than the one it requested. The explicit request must win.
 */

import { describe, it, expect } from 'vitest';
import roster from './roster';
import { PRESENCE_RESPONSE_BUDGET_CHARS, PRESENCE_TIER_CAPS } from './presence-shape';

type Shaper = (data: unknown) => unknown;
const shape = (roster as unknown as { shape?: { standard?: Shaper; trimmed?: Shaper } }).shape;

/** A full snapshot as view=live emits it (unlensed): wide rows, no projection block. */
function fullSnapshot(rowCount: number) {
  return {
    as_of: '2026-07-28T13:00:00.000Z',
    scope: 'workspace',
    summary: { active: rowCount, wakeable: 2, byState: { live: 1, parked: 1, ended: 0, recorded: 0 } },
    active: Array.from({ length: rowCount }, (_, i) => ({
      ownerId: `su-${i}`,
      ownerLabel: `su · ${i}`,
      agentRole: 'engineer',
      sessionState: i === 0 ? 'live' : 'parked',
      wakeable: true,
      confirmLiveness: false,
      contextPressure: 'ok',
      intent: 'a long declared intent string that is part of why the full row is about a kilobyte',
      currentPlanSlug: 'some-plan-2026-07-28',
      claimedItems: ['WI-1', 'WI-2'],
      heartbeatAt: '2026-07-28T13:00:00.000Z',
      host: 'box',
      pid: 1234,
    })),
    etag: 'abc123',
    view: 'live',
  };
}

/** The same read AFTER a caller-requested project:'liveness' lens (WI-6658). */
function lensedSnapshot(rowCount: number) {
  const s = fullSnapshot(rowCount);
  return {
    ...s,
    active: s.active.map((r) => ({ ownerId: r.ownerId, sessionState: r.sessionState })),
    projection: { project: 'liveness', returned: rowCount, ofActive: rowCount },
  };
}

describe('coord:roster payload-tier shape (WI-6662)', () => {
  it('declares both tier shapers, like coord:presence', () => {
    expect(typeof shape?.standard).toBe('function');
    expect(typeof shape?.trimmed).toBe('function');
  });

  it('projects and caps an unlensed live read at the trimmed tier', () => {
    const out = shape!.trimmed!(fullSnapshot(130)) as {
      active: Record<string, unknown>[];
      activeTruncated: { shown: number; reason?: string };
    };
    // capped (+1 for the visible truncation notice row), with an additional
    // serialized-response budget when the tier cap itself would overflow the
    // result door.
    expect(out.active.length).toBeLessThanOrEqual(PRESENCE_TIER_CAPS.trimmed.rows + 1);
    expect(out.active.length).toBeGreaterThan(1);
    expect(out.activeTruncated.shown).toBe(out.active.length - 1);
    expect(out.activeTruncated.reason).toBe('response_budget');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(PRESENCE_RESPONSE_BUDGET_CHARS);
    // projected to the dispatch core — the heavy env fields are gone
    expect(out.active[0]).not.toHaveProperty('host');
    expect(out.active[0]).not.toHaveProperty('pid');
    expect(out.active[0]).not.toHaveProperty('heartbeatAt');
    // ...but the dispatch decision core survives
    expect(out.active[0]).toMatchObject({ ownerId: 'su-0', state: 'live', wakeable: true });
    // and the cut is VISIBLE rather than silent
    expect(out.active[out.active.length - 1].ownerId).toBe('(truncated)');
  });

  it('keeps summary verbatim — the counts contract readers are told to trust', () => {
    const input = fullSnapshot(130);
    const out = shape!.trimmed!(input) as { summary: unknown };
    expect(out.summary).toEqual(input.summary);
  });

  it('makes it meaningfully cheaper', () => {
    const input = fullSnapshot(130);
    const shaped = shape!.trimmed!(input);
    expect(JSON.stringify(shaped).length).toBeLessThan(JSON.stringify(input).length * 0.5);
  });

  it('LEAVES A CALLER-LENSED READ ALONE — the explicit request beats the tier default', () => {
    // The inversion this guard exists to prevent: without it, rows already
    // projected to {ownerId, sessionState} get re-widened to ~17 mostly-null
    // fields, so the cheapest possible request returns MORE than it asked for.
    const input = lensedSnapshot(130);
    const out = shape!.trimmed!(input) as typeof input;
    expect(out).toBe(input);
    expect(out.active[0]).toEqual({ ownerId: 'su-0', sessionState: 'live' });
    expect(out.active).toHaveLength(130);
    // and it must not have grown
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(JSON.stringify(input).length);
  });

  it('a lensed read stays cheaper than the full unlensed one', () => {
    const lensed = shape!.trimmed!(lensedSnapshot(130));
    expect(JSON.stringify(lensed).length).toBeLessThan(JSON.stringify(fullSnapshot(130)).length);
  });

  it('passes view=claims through untouched (it has no active[])', () => {
    const claims = { view: 'claims', as_of: 'x', summary: { agents: 1 }, agents: [{ agentId: 'su-0' }] };
    expect(shape!.trimmed!(claims)).toBe(claims);
  });

  it('passes view=history through untouched', () => {
    const history = { view: 'history', as_of: 'x', data: null };
    expect(shape!.trimmed!(history)).toBe(history);
  });
});
