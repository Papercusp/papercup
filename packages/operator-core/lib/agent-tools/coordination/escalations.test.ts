/**
 * escalations.test.ts — listEscalationsPaginated bounds the READ at the storage
 * layer (EI-1548) instead of loading the whole surface then truncating. Drives
 * the fold + bounding through the swappable InMemoryCoordLog seam (no PG).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog, coordLog } from './log';
import { listEscalationsPaginated } from './escalations';

afterEach(() => resetCoordLog());

async function seedOpen(n: number): Promise<void> {
  configureCoordLog(new InMemoryCoordLog());
  for (let i = 1; i <= n; i++) {
    await coordLog.putEvent('escalations', `e${i}`, {
      ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      msg_id: `e${i}`,
      from: 'A',
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: `esc ${i}`,
      resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
}

describe('listEscalationsPaginated — bounded read (EI-1548)', () => {
  it('bounds the page to maxRecords (newest-first) and flags truncated', async () => {
    await seedOpen(5);
    const r = await listEscalationsPaginated({ maxRecords: 2 });
    expect(r.escalations).toHaveLength(2);
    expect(r.truncated).toBe(true);
    // The bounded read selected the 2 NEWEST (e4,e5) — not the oldest. (Post-fold
    // ordering is foldEscalations' concern, so assert the SET, not the sequence.)
    expect(r.escalations.map((e) => e.msg_id).sort()).toEqual(['e4', 'e5']);
  });

  it('returns the full set when under the page size and is not truncated', async () => {
    await seedOpen(3);
    const r = await listEscalationsPaginated({ maxRecords: 50 });
    expect(r.escalations).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('clamps an over-large maxRecords to the 500 ceiling', async () => {
    await seedOpen(3);
    // maxRecords 9999 must not throw / must still return; ceiling is internal.
    const r = await listEscalationsPaginated({ maxRecords: 9999 });
    expect(r.escalations).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('folds a resolve out of the open set (status filter still works)', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'e1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'e1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'needs a human', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'r1', {
      ts: '2026-01-01T00:00:02.000Z', msg_id: 'r1', from: 'A', to: ['human'],
      kind: 'escalation_resolved', related_msg_id: 'e1', choice: 'ok', summary: 'resolved',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const open = await listEscalationsPaginated({ status: 'open', maxRecords: 50 });
    expect(open.escalations.map((e) => e.msg_id)).toEqual([]); // e1 is resolved

    const resolved = await listEscalationsPaginated({ status: 'resolved', maxRecords: 50 });
    expect(resolved.escalations.map((e) => e.msg_id)).toEqual(['e1']);
  });

  it('empty surface → no escalations, not truncated', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const r = await listEscalationsPaginated({ maxRecords: 50 });
    expect(r.escalations).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});
