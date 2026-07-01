/**
 * fleet-delivery — the per-member fleet delivery override's DIGEST sidecar
 * (fleet-delivery-override-mute-digest-2026-06-30 D-001).
 *
 * Exercises deliverFleetDigests with injected overrides + an in-memory sink (no PG):
 * digest members get a terse digest:true notify; full/muted are skipped; a member
 * already on the live `to` is not double-sent; fleet names are canonicalized; and
 * @fleet-leader: is not treated as a digest cohort.
 */
import { describe, it, expect } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import type { DeliveryMode } from '@papercusp/coordination/capabilities';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { deliverFleetDigests } from './fleet-delivery';

function env(over: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-06-30T12:00:00.000Z',
    msg_id: 'm-1',
    from: 'queen',
    to: [],
    kind: 'message',
    summary: 'cohort steering note',
    audience: ['@fleet:backend'],
    ...over,
  };
}

function overridesFor(map: Record<string, Record<string, DeliveryMode>>) {
  return async (slug: string) => new Map(Object.entries(map[slug] ?? {}));
}

async function digestRows(sink: InMemoryCoordLog) {
  return (await sink.readLines('messages')) as Array<Record<string, unknown>>;
}

describe('deliverFleetDigests', () => {
  it('delivers a digest:true notify to digest members; skips full + muted', async () => {
    const sink = new InMemoryCoordLog();
    const n = await deliverFleetDigests(['@fleet:backend'], env(), [], {
      getOverrides: overridesFor({ backend: { alice: 'digest', bob: 'muted', carol: 'full', dave: 'digest' } }),
      sink,
    });
    expect(n).toBe(2);
    const rows = await digestRows(sink);
    expect(new Set(rows.flatMap((r) => (r.to as string[]) ?? []))).toEqual(new Set(['alice', 'dave']));
    for (const r of rows) {
      expect(r.kind).toBe('notify');
      expect(r.digest).toBe(true);
      expect(r.delivery_mode).toBe('digest');
      expect(r.notify_kind).toBe('fleet_broadcast');
      expect(r.summary).toBe('cohort steering note');
    }
  });

  it('does not double-send to a digest member already on the live `to`', async () => {
    const sink = new InMemoryCoordLog();
    const n = await deliverFleetDigests(['@fleet:backend'], env(), ['alice'], {
      getOverrides: overridesFor({ backend: { alice: 'digest', dave: 'digest' } }),
      sink,
    });
    expect(n).toBe(1); // alice already getting the live envelope → only dave
    const rows = await digestRows(sink);
    expect(rows.flatMap((r) => (r.to as string[]) ?? [])).toEqual(['dave']);
  });

  it('canonicalizes the fleet name (@fleet:Backend Team → backend-team)', async () => {
    const sink = new InMemoryCoordLog();
    const n = await deliverFleetDigests(['@fleet:Backend Team'], env(), [], {
      getOverrides: overridesFor({ 'backend-team': { alice: 'digest' } }),
      sink,
    });
    expect(n).toBe(1);
  });

  it('returns 0 + delivers nothing when there is no @fleet: selector', async () => {
    const sink = new InMemoryCoordLog();
    let called = false;
    const n = await deliverFleetDigests(['*', '@topic:x', 'someone'], env(), [], {
      getOverrides: async (s) => {
        called = true;
        return new Map([[s, 'digest' as DeliveryMode]]) as Map<string, DeliveryMode>;
      },
      sink,
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
    expect(await digestRows(sink)).toHaveLength(0);
  });

  it('does NOT treat @fleet-leader: as a digest cohort', async () => {
    const sink = new InMemoryCoordLog();
    const n = await deliverFleetDigests(['@fleet-leader:backend'], env(), [], {
      getOverrides: overridesFor({ backend: { alice: 'digest' } }),
      sink,
    });
    expect(n).toBe(0);
    expect(await digestRows(sink)).toHaveLength(0);
  });
});
