/**
 * Operator-level tests for the escalations + handoffs channels
 * (openEscalation / resolveEscalation / openHandoff / acceptHandoff …).
 *
 * These exercise the real fold logic (append-only resolve, open↔acceptance
 * grouping) against an in-memory CoordEventLog double — NO Postgres, NO live
 * `harness_shared.coord_event_log`. (The PG backend itself is covered by the
 * package's event-log conformance suite, run against PgCoordLog in
 * `event-log-conformance.test.ts`.) Earlier this file claimed "pure
 * filesystem, no PG" and set PAPERCUSP_COORD_DIR + read per-event `.json`
 * files, but after the FS→PG cutover (coord-channels-pg-port) the channel
 * modules route through `coordLog` (PgCoordLog), which ignored that env — so
 * the tests failed AND wrote real escalations/handoffs into the live coord
 * table. Injecting `InMemoryCoordLog` via the `configureCoordLog` seam is the
 * fix; the append-only invariant is now asserted through the log itself
 * instead of by reading files.
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/escalations-handoffs.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

import { configureCoordLog, resetCoordLog, coordLog } from '../log';
import {
  getEscalation,
  listEscalations,
  openEscalation,
  resolveEscalation,
} from '../escalations';
import {
  acceptHandoff,
  getHandoff,
  listHandoffs,
  openHandoff,
} from '../handoffs';
import type { AgentIdentity } from '../identity';

function id(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'omp-hook-session',
    workspaceId: 'default',
    userId: null,
  };
}

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
});
afterEach(() => {
  resetCoordLog();
});

describe('escalations', () => {
  it('openEscalation writes a per-event record with resolved=null', async () => {
    const A = id('A');
    const rec = await openEscalation(A, {
      severity: 'question',
      summary: 'pick A or B?',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    });
    expect(rec.kind).toBe('escalation');
    expect(rec.resolved).toBeNull();
    expect(rec.to).toEqual(['human']);
    expect(rec.severity).toBe('question');
    const round = await getEscalation(rec.msg_id);
    expect(round?.options).toHaveLength(2);
  });

  it('listEscalations filters by status', async () => {
    const A = id('A');
    const e1 = await openEscalation(A, { severity: 'advisory', summary: 'x' });
    await openEscalation(A, { severity: 'blocker', summary: 'y' });
    await resolveEscalation({ msg_id: e1.msg_id, choice: 'ok' });

    const open = await listEscalations({ status: 'open' });
    expect(open.map((e) => e.summary)).toEqual(['y']);

    const resolved = await listEscalations({ status: 'resolved' });
    expect(resolved.map((e) => e.summary)).toEqual(['x']);
    expect(resolved[0]?.resolved?.choice).toBe('ok');
  });

  it('resolveEscalation reports not_found and already_resolved', async () => {
    const A = id('A');
    const e = await openEscalation(A, { severity: 'question', summary: 'q' });
    expect(await resolveEscalation({ msg_id: 'nope', choice: 'x' })).toBe(
      'not_found',
    );
    await resolveEscalation({ msg_id: e.msg_id, choice: 'first' });
    expect(
      await resolveEscalation({ msg_id: e.msg_id, choice: 'second' }),
    ).toBe('already_resolved');
    const round = await getEscalation(e.msg_id);
    // First resolution sticks; second is rejected.
    expect(round?.resolved?.choice).toBe('first');
  });

  it('resolveEscalation appends an escalation_resolved sibling and leaves the open record immutable', async () => {
    const A = id('A');
    const e = await openEscalation(A, { severity: 'blocker', summary: 'need a call' });

    const out = await resolveEscalation({
      msg_id: e.msg_id,
      choice: 'go',
      note: 'approved',
      resolver: 'human',
    });
    if (typeof out === 'string') throw new Error(`expected record, got ${out}`);
    expect(out.resolved?.choice).toBe('go');
    expect(out.resolved?.note).toBe('approved');
    expect(out.resolved?.by).toBe('human');

    // Append-only: the stored open escalation record is never mutated — read
    // it raw from the log and confirm it still carries resolved=null.
    const rawOpen = await coordLog.getEvent('escalations', e.msg_id);
    expect(rawOpen?.kind).toBe('escalation');
    expect(rawOpen?.resolved).toBeNull();

    // A single sibling escalation_resolved event exists, linked by related_msg_id.
    const events = await coordLog.readEvents('escalations');
    const resolvedEvents = events.filter((r) => r.kind === 'escalation_resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]?.related_msg_id).toBe(e.msg_id);
    expect(resolvedEvents[0]?.choice).toBe('go');

    // Read-time fold reflects the resolution.
    const round = await getEscalation(e.msg_id);
    expect(round?.resolved?.choice).toBe('go');
    expect((await listEscalations({ status: 'resolved' })).map((x) => x.msg_id)).toEqual([
      e.msg_id,
    ]);
    expect(await listEscalations({ status: 'open' })).toEqual([]);
  });
});

describe('handoffs', () => {
  it('openHandoff + acceptHandoff produce two sibling records linked by related_msg_id', async () => {
    const A = id('A');
    const B = id('B');
    const h = await openHandoff(A, {
      to: ['B'],
      plan_slug: 'plan-x-2026-05-20',
      summary: 'phase 1 done',
      next_action: 'implement phase 2',
      files_modified: ['lib/foo.ts'],
    });
    expect(h.kind).toBe('handoff');
    const acc = await acceptHandoff(B, h.msg_id, 'on it');
    expect(acc?.kind).toBe('handoff_accepted');
    expect(acc?.related_msg_id).toBe(h.msg_id);
    expect(acc?.to).toEqual(['A']);
    expect(acc?.plan_slug).toBe('plan-x-2026-05-20');
  });

  it('acceptHandoff returns null when target does not exist', async () => {
    const B = id('B');
    expect(await acceptHandoff(B, 'never')).toBeNull();
  });

  it('listHandoffs annotates each handoff with its acceptance and filters by status', async () => {
    const A = id('A');
    const B = id('B');
    const h1 = await openHandoff(A, { to: ['B'], plan_slug: 'p', summary: 's1' });
    const h2 = await openHandoff(A, { to: ['B'], plan_slug: 'p', summary: 's2' });
    await acceptHandoff(B, h1.msg_id);

    const all = await listHandoffs();
    expect(all.map((x) => x.record.summary).sort()).toEqual(['s1', 's2']);
    const accepted = await listHandoffs({ status: 'accepted' });
    expect(accepted.map((x) => x.record.summary)).toEqual(['s1']);
    expect(accepted[0]?.accepted_by?.kind).toBe('handoff_accepted');
    const open = await listHandoffs({ status: 'open' });
    expect(open.map((x) => x.record.summary)).toEqual(['s2']);

    // sanity: h2 has no acceptance
    expect(await getHandoff(h2.msg_id)).not.toBeNull();
  });

  it('double-accept is append-only but the fold still reports the handoff accepted exactly once (P-018)', async () => {
    const A = id('A');
    const B = id('B');
    const h = await openHandoff(A, { to: ['B'], plan_slug: 'p', summary: 'dup-accept' });

    const acc1 = await acceptHandoff(B, h.msg_id, 'first');
    const acc2 = await acceptHandoff(B, h.msg_id, 'second');

    // acceptHandoff is NOT idempotent at the event level: each call appends a
    // distinct handoff_accepted sibling (append-only log, no in-place mutation).
    expect(acc1?.msg_id).toBeTruthy();
    expect(acc2?.msg_id).toBeTruthy();
    expect(acc1?.msg_id).not.toBe(acc2?.msg_id);
    const acceptedEvents = (await coordLog.readEvents('handoffs')).filter(
      (r) => r.kind === 'handoff_accepted' && r.related_msg_id === h.msg_id,
    );
    expect(acceptedEvents).toHaveLength(2);

    // ...but the read-time fold collapses the duplicate acceptances: the handoff
    // appears EXACTLY ONCE in the accepted list (and never as still-open), so a
    // double-accept can't duplicate or de-sync the handoff's reported state.
    const accepted = await listHandoffs({ status: 'accepted' });
    expect(accepted.filter((x) => x.record.msg_id === h.msg_id)).toHaveLength(1);
    const all = await listHandoffs();
    expect(all.filter((x) => x.record.msg_id === h.msg_id)).toHaveLength(1);
    expect(await listHandoffs({ status: 'open' })).toEqual([]);
  });
});
