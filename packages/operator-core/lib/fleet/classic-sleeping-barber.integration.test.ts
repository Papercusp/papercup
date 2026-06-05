/**
 * classic-sleeping-barber.integration.test.ts — D-008 (sleeping barber).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Lost-wakeup safety in the
 * subscribe→inject loop: a notify posted while the curator/consumer is "asleep" (not
 * currently reading) must NOT be lost. The coordination substrate is lost-wakeup-safe
 * because delivery is a DURABLE event log read by watermark — not an edge-triggered
 * signal that evaporates if no one is listening. This drives the REAL coord message
 * channel over the in-memory backend (no live DB needed; same fold logic as PG).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../agent-tools/coordination/log';
import { sendMessage, readInbox } from '../agent-tools/coordination/messages';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

const customer = (id: string): AgentIdentity => ({ ownerId: id, ownerLabel: id, source: 'principal', workspaceId: 'default', userId: null });

beforeEach(() => configureCoordLog(new InMemoryCoordLog()));
afterEach(() => resetCoordLog());

describe('sleeping barber — lost-wakeup safety (D-008)', () => {
  it('notifies posted while the consumer is asleep are all delivered on wake', async () => {
    // Barber asleep (nobody reading). Two customers arrive → post to 'barber'.
    await sendMessage(customer('cust-1'), { to: ['barber'], summary: 'haircut 1' });
    await sendMessage(customer('cust-2'), { to: ['barber'], summary: 'haircut 2' });
    // Barber wakes → both are there (durable log, not a lost edge signal).
    const inbox = await readInbox('barber');
    expect(inbox.map((m) => m.summary)).toEqual(['haircut 1', 'haircut 2']);
  });

  it('reads are non-destructive (re-reading does not consume) and the watermark filters', async () => {
    await sendMessage(customer('c'), { to: ['barber'], summary: 'one' });
    await sendMessage(customer('c'), { to: ['barber'], summary: 'two' });

    // Two independent wakeups see the SAME durable set — a read never drops a message.
    expect((await readInbox('barber')).map((m) => m.summary)).toEqual(['one', 'two']);
    expect((await readInbox('barber')).map((m) => m.summary)).toEqual(['one', 'two']);

    // A watermark strictly after both → empty (no re-delivery of already-seen work).
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await readInbox('barber', { since_ts: future })).toEqual([]);
  });

  it('a broadcast notify is delivered to a consumer that was asleep when it was posted', async () => {
    await sendMessage(customer('operator'), { to: ['*'], summary: 'fleet-wide notice' });
    const inbox = await readInbox('any-late-waker');
    expect(inbox.map((m) => m.summary)).toContain('fleet-wide notice');
  });
});
