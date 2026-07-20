/**
 * handoffs-paginated.test.ts — listHandoffsPaginated bounds the READ at the
 * storage layer (EI-18138089781782660, mirroring listEscalationsPaginated's
 * EI-1548/EI-6624/WI-4181 pattern) instead of loading the whole handoffs
 * surface (`listHandoffs` → `coordLog.readEvents`, unbounded) then folding.
 * Drives the fold + bounding through the swappable InMemoryCoordLog seam (no PG).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog, coordLog } from './log';
import { listHandoffsPaginated } from './handoffs';

afterEach(() => resetCoordLog());

async function seedOpen(n: number): Promise<void> {
  configureCoordLog(new InMemoryCoordLog());
  for (let i = 1; i <= n; i++) {
    await coordLog.putEvent('handoffs', `h${i}`, {
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      msg_id: `h${i}`,
      from: 'A',
      to: ['B'],
      kind: 'handoff',
      summary: `handoff ${i}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
}

describe('listHandoffsPaginated — bounded read (EI-18138089781782660)', () => {
  it('bounds the page to maxRecords (newest-first) and flags truncated', async () => {
    await seedOpen(5);
    const r = await listHandoffsPaginated({ maxRecords: 2 });
    expect(r.handoffs).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.handoffs.map((h) => h.record.msg_id).sort()).toEqual(['h4', 'h5']);
  });

  it('returns the full set when under the page size and is not truncated', async () => {
    await seedOpen(3);
    const r = await listHandoffsPaginated({ maxRecords: 50 });
    expect(r.handoffs).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('clamps an over-large maxRecords to the 500 ceiling without throwing', async () => {
    await seedOpen(3);
    const r = await listHandoffsPaginated({ maxRecords: 9999 });
    expect(r.handoffs).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('empty surface → no handoffs, not truncated', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const r = await listHandoffsPaginated({ maxRecords: 50 });
    expect(r.handoffs).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('folds an acceptance out of the open set (status filter still works)', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('handoffs', 'h1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'h1', from: 'A', to: ['B'],
      kind: 'handoff', summary: 'take over',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('handoffs', 'a1', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'a1', from: 'B', to: ['A'],
      kind: 'handoff_accepted', related_msg_id: 'h1', summary: 'accepted',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const open = await listHandoffsPaginated({ status: 'open', maxRecords: 50 });
    expect(open.handoffs.map((h) => h.record.msg_id)).toEqual([]); // h1 is accepted

    const accepted = await listHandoffsPaginated({ status: 'accepted', maxRecords: 50 });
    expect(accepted.handoffs.map((h) => h.record.msg_id)).toEqual(['h1']);
    expect(accepted.handoffs[0].accepted_by?.msg_id).toBe('a1');
  });

  it('an accept-heavy window does not starve status:open handoffs out of the page', async () => {
    // Mirrors EI-6624 for handoffs: a burst of unrelated acceptances newer
    // than a still-open handoff must not crowd it out of a small window.
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('handoffs', 'open1', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'open1', from: 'A', to: ['B'],
      kind: 'handoff', summary: 'still open',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    for (let i = 1; i <= 10; i++) {
      await coordLog.putEvent('handoffs', `accept${i}`, {
        ts: `2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`,
        msg_id: `accept${i}`, from: 'B', to: ['A'],
        kind: 'handoff_accepted', related_msg_id: `unrelated${i}`, summary: 'accepted',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const r = await listHandoffsPaginated({ status: 'open', maxRecords: 5 });
    expect(r.handoffs.map((h) => h.record.msg_id)).toEqual(['open1']);
  });

  it('an old ACCEPTED handoff whose acceptance was evicted from the status window does not re-materialize as open (the zombie WI-4181 fixed for escalations)', async () => {
    configureCoordLog(new InMemoryCoordLog());
    // z1: the oldest open — accepted 1s later.
    await coordLog.putEvent('handoffs', 'z1', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'z1', from: 'A', to: ['B'],
      kind: 'handoff', summary: 'take over z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('handoffs', 'az', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'az', from: 'B', to: ['A'],
      kind: 'handoff_accepted', related_msg_id: 'z1', summary: 'accepted',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // 4 newer still-open handoffs keep z1 INSIDE the newest-5 opens window…
    for (let i = 2; i <= 5; i++) {
      await coordLog.putEvent('handoffs', `o${i}`, {
        ts: `2026-01-01T00:02:${String(i).padStart(2, '0')}.000Z`, msg_id: `o${i}`, from: 'A', to: ['B'],
        kind: 'handoff', summary: `open ${i}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    // …while 6 newer unrelated acceptances EVICT az from the newest-5 status window.
    for (let i = 1; i <= 6; i++) {
      await coordLog.putEvent('handoffs', `acc${i}`, {
        ts: `2026-01-01T00:03:${String(i).padStart(2, '0')}.000Z`, msg_id: `acc${i}`, from: 'B', to: ['A'],
        kind: 'handoff_accepted', related_msg_id: `unrelated${i}`, summary: 'accepted',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const open = await listHandoffsPaginated({ status: 'open', maxRecords: 5 });
    // Pre-fix this would return ['z1','o2'..'o5'] — z1 back from the dead.
    expect(open.handoffs.map((h) => h.record.msg_id).sort()).toEqual(['o2', 'o3', 'o4', 'o5']);

    const accepted = await listHandoffsPaginated({ status: 'accepted', maxRecords: 5 });
    expect(accepted.handoffs.map((h) => h.record.msg_id)).toContain('z1');
  });
});
