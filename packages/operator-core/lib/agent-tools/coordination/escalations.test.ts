/**
 * escalations.test.ts — listEscalationsPaginated bounds the READ at the storage
 * layer (EI-1548) instead of loading the whole surface then truncating. Drives
 * the fold + bounding through the swappable InMemoryCoordLog seam (no PG).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog, coordLog } from './log';
import {
  expireStaleAdvisoryEscalations,
  listEscalations,
  listEscalationsPaginated,
  openEscalation,
  resolveEscalationsBatch,
} from './escalations';
import type { AgentIdentity } from './identity';

afterEach(() => resetCoordLog());

/** An InMemoryCoordLog that counts how many times the FULL surface is scanned
 *  (`readEvents`) — the O(n²) signal the batch resolve must NOT trip. */
class CountingCoordLog extends InMemoryCoordLog {
  readEventsCalls = 0;
  override readEvents(surface: Parameters<InMemoryCoordLog['readEvents']>[0]) {
    this.readEventsCalls += 1;
    return super.readEvents(surface);
  }
}

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

  it('EI-6624: a resolve-heavy window does not starve status:open opens out of the page', async () => {
    // Reproduces the reported symptom: an active fleet resolving many escalations
    // recently means a maxRecords-sized COMBINED window (old behavior) could be
    // almost entirely `escalation_resolved` events, crowding out genuinely open
    // escalations and returning escalations:[] with a misleading nonzero total.
    configureCoordLog(new InMemoryCoordLog());
    // One still-open escalation, oldest of all events.
    await coordLog.putEvent('escalations', 'open1', {
      ts: '2026-01-01T00:00:00.000Z', msg_id: 'open1', from: 'A', to: ['human'],
      kind: 'escalation', summary: 'still open', resolved: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // A burst of 10 unrelated resolve events, all NEWER than open1 — under the
    // old shared-window design with maxRecords:5 these alone would fill the
    // entire window and open1 would never be scanned.
    for (let i = 1; i <= 10; i++) {
      await coordLog.putEvent('escalations', `resolve${i}`, {
        ts: `2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`,
        msg_id: `resolve${i}`, from: 'A', to: ['human'],
        kind: 'escalation_resolved', related_msg_id: `unrelated${i}`, choice: 'ok', summary: 'resolved',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    const r = await listEscalationsPaginated({ status: 'open', maxRecords: 5 });
    expect(r.escalations.map((e) => e.msg_id)).toEqual(['open1']);
    expect(r.total).toBe(1); // total matches what's actually returned — never a misleading nonzero-with-empty-array
  });
});

describe('resolveEscalationsBatch — single-load drain (EI-1490)', () => {
  async function seedOpens(log: InMemoryCoordLog, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const id = `e${i}`;
      ids.push(id);
      await log.putEvent('escalations', id, {
        ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        msg_id: id,
        from: 'system:hive-placement-watchdog',
        to: ['human'],
        kind: 'escalation',
        severity: 'advisory',
        summary: `esc ${id}`,
        resolved: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    return ids;
  }

  it('reads the FULL surface exactly ONCE regardless of batch size (no O(n²))', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const ids = await seedOpens(log, 25);
    log.readEventsCalls = 0; // ignore the seeding reads (putEvent does none, but be safe)

    const r = await resolveEscalationsBatch(
      ids.map((id) => ({ msg_id: id, choice: 'auto-reconciled', resolver: 'system:test' })),
    );

    expect(r.resolved).toBe(25);
    // The whole batch drained from ONE load — the regression: the old per-item
    // path scanned the entire surface once PER item (would be 25 here).
    expect(log.readEventsCalls).toBe(1);

    // And they really are folded out of the open set afterwards.
    const open = await listEscalationsPaginated({ status: 'open', maxRecords: 500 });
    expect(open.escalations).toHaveLength(0);
  });

  it('reports notFound / alreadyResolved / duplicate-in-batch without extra loads', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const [e1] = await seedOpens(log, 1);
    log.readEventsCalls = 0;

    const r = await resolveEscalationsBatch([
      { msg_id: e1, choice: 'x' }, // resolves
      { msg_id: e1, choice: 'x' }, // duplicate in same batch → alreadyResolved
      { msg_id: 'missing', choice: 'x' }, // notFound
    ]);

    expect(r).toMatchObject({ resolved: 1, alreadyResolved: 1, notFound: 1, requiresSpawnApprove: 0 });
    expect(log.readEventsCalls).toBe(1);
  });

  it('never auto-resolves a spawn-approval request', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    await log.putEvent('escalations', 'spawn1', {
      ts: '2026-01-01T00:00:01.000Z', msg_id: 'spawn1', from: 'bee-7', to: ['human'],
      kind: 'escalation', severity: 'blocker', summary: 'approve spawn?', resolved: null,
      spawnRequest: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const r = await resolveEscalationsBatch([{ msg_id: 'spawn1', choice: 'auto-reconciled' }]);
    expect(r).toMatchObject({ resolved: 0, requiresSpawnApprove: 1 });
  });

  it('empty batch → no load, zero counts', async () => {
    const log = new CountingCoordLog();
    configureCoordLog(log);
    const r = await resolveEscalationsBatch([]);
    expect(r).toEqual({ resolved: 0, notFound: 0, alreadyResolved: 0, requiresSpawnApprove: 0 });
    expect(log.readEventsCalls).toBe(0);
  });
});

describe('openEscalation dedup + advisory expiry (WI-1503)', () => {
  const identity = { ownerId: 'bee-7' } as AgentIdentity;

  it('dedups a repeat open escalation onto the existing row instead of stacking a second open event', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const first = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });
    const second = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });

    expect(second.msg_id).toBe(first.msg_id);
    expect((second as Record<string, unknown>).repeatCount).toBe(2);

    const open = await listEscalations({ status: 'open' });
    expect(open.map((e) => e.msg_id)).toEqual([first.msg_id]);

    const raw = await coordLog.readEvents('escalations');
    expect(raw.filter((r) => r.kind === 'escalation')).toHaveLength(1);
  });

  it('does not dedup across dedupKind boundaries', async () => {
    configureCoordLog(new InMemoryCoordLog());
    const advisory = await openEscalation(identity, { severity: 'advisory', summary: 'same subject' });
    const blocker = await openEscalation(identity, { severity: 'blocker', summary: 'same subject' });

    expect(blocker.msg_id).not.toBe(advisory.msg_id);
    expect((await listEscalations({ status: 'open' })).map((e) => e.msg_id).sort()).toEqual(
      [advisory.msg_id, blocker.msg_id].sort(),
    );
  });

  it('auto-expires only stale advisory escalations; blocker/question rows remain open', async () => {
    configureCoordLog(new InMemoryCoordLog());
    await coordLog.putEvent('escalations', 'adv-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'adv-old',
      from: 'bee-1',
      to: ['human'],
      kind: 'escalation',
      severity: 'advisory',
      summary: 'old advisory',
      resolved: null,
      dedupKind: 'advisory',
      subjectSignature: 'old advisory',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'ask-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'ask-old',
      from: 'bee-2',
      to: ['human'],
      kind: 'escalation',
      severity: 'question',
      summary: 'old question',
      resolved: null,
      dedupKind: 'question',
      subjectSignature: 'old question',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await coordLog.putEvent('escalations', 'block-old', {
      ts: '2026-01-01T00:00:00.000Z',
      msg_id: 'block-old',
      from: 'bee-3',
      to: ['human'],
      kind: 'escalation',
      severity: 'blocker',
      summary: 'old blocker',
      resolved: null,
      dedupKind: 'blocker',
      subjectSignature: 'old blocker',
      repeatCount: 1,
      lastSeenTs: '2026-01-01T00:00:00.000Z',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const out = await expireStaleAdvisoryEscalations({
      olderThanMs: 60 * 60 * 1000,
      limit: 10,
    });

    expect(out).toMatchObject({ scanned: 3, eligible: 1, expired: 1, truncated: false });
    expect((await listEscalations({ status: 'open' })).map((e) => e.msg_id).sort()).toEqual(['ask-old', 'block-old']);
    expect((await listEscalations({ status: 'resolved' })).map((e) => e.msg_id)).toContain('adv-old');
  });
});

describe('openEscalation — harness_slug federation (WI-1375)', () => {
  const identity = { ownerId: 'bee-7' } as AgentIdentity;

  it('stamps harness_slug on the record when a harness-scoped agent escalates (federates to the hub)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const rec = await openEscalation(identity, {
      severity: 'blocker',
      summary: 'need a human',
      harness_slug: 'shared-hive',
    });
    // Federation column PgCoordLog projects to coord_event_log.harness_slug: a
    // peer-machine escalation "to human" now reaches the hub inbox (NOT NULL ⇒ capture enqueues).
    expect(rec.harness_slug).toBe('shared-hive');
    expect(rec.to).toEqual(['human']); // still addressed to the human — the scope only routes it there
    const persisted = await log.getEvent('escalations', rec.msg_id);
    expect((persisted as { harness_slug?: string }).harness_slug).toBe('shared-hive');
  });

  it('leaves harness_slug unset for an operator/SU escalation (stays workspace-local)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    // The coord:escalate tool passes NO harness_slug for a '*'/unset scope; the adapter
    // must not invent one, so the record stays LOCAL (unfederated).
    const rec = await openEscalation(identity, { severity: 'advisory', summary: 'fyi' });
    expect('harness_slug' in rec).toBe(false);
  });

  it('keeps meta.harnessSlug (inbox chat-scoping) distinct from the top-level harness_slug (federation)', async () => {
    const log = new InMemoryCoordLog();
    configureCoordLog(log);
    const rec = await openEscalation(identity, {
      severity: 'question',
      summary: 'which way?',
      harness_slug: 'shared-hive',
      meta: { harnessSlug: 'shared-hive' },
    });
    expect(rec.harness_slug).toBe('shared-hive'); // federation column (snake_case)
    expect((rec as { harnessSlug?: string }).harnessSlug).toBe('shared-hive'); // human-inbox chat scope (camelCase, via meta)
  });
});
