/**
 * Unit tests for plan-events.ts — the working-memory history feed.
 *
 * Drives the CoordEventLog seam with an in-memory backend (no PG, no fs).
 * In production the operator backs the seam with Postgres
 * (harness_shared.coord_event_log); the in-memory double exercises the same
 * emit/read/filter logic in isolation. The legacy filesystem layout
 * (planEventsFile / monthly-rotation .jsonl files) was retired in the
 * coord-channels-pg-port cutover.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';

import { emitPlanEvent, emitPlanEventForCaller, readPlanEvents } from '../plan-events';
import { configureCoordLog, resetCoordLog } from '../log';

beforeEach(() => {
  configureCoordLog(new InMemoryCoordLog());
});
afterEach(() => {
  resetCoordLog();
});

describe('plan-events', () => {
  it('emitPlanEvent writes a typed plan_event envelope', async () => {
    await emitPlanEvent({
      planSlug: 'foo-2026-05-20',
      event: 'created',
      identity: {
        ownerId: 'agent-1',
        ownerLabel: 'a',
        source: 'omp-hook-session',
        workspaceId: 'default',
        userId: null,
      },
      detail: 'first',
    });
    const all = await readPlanEvents();
    expect(all).toHaveLength(1);
    expect(all[0]?.kind).toBe('plan_event');
    expect(all[0]?.event).toBe('created');
    expect(all[0]?.plan_slug).toBe('foo-2026-05-20');
    expect(all[0]?.from).toBe('agent-1');
    expect(all[0]?.detail).toBe('first');
  });

  it('emitPlanEventForCaller resolves identity from ctx and falls back to "system"', async () => {
    // ctx with a resolvable power-user identity
    await emitPlanEventForCaller(
      { isPowerUser: true, uiClientId: 'pus-abcdefab-cdef-...', workspaceId: 'ws' },
      { planSlug: 'p1', event: 'now_updated' },
    );
    // ctx that cannot be attributed -> from === 'system', no throw
    await emitPlanEventForCaller({}, { planSlug: 'p1', event: 'item_added', detail: 'P-001' });
    const events = await readPlanEvents();
    expect(events.map((e) => e.from)).toEqual(['pus-abcdefab-cdef-...', 'system']);
  });

  it('readPlanEvents filters by since_ts / planSlugs / events', async () => {
    await emitPlanEvent({ planSlug: 'a', event: 'created' });
    await new Promise((r) => setTimeout(r, 5));
    const cutoffTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await emitPlanEvent({ planSlug: 'a', event: 'now_updated' });
    await emitPlanEvent({ planSlug: 'b', event: 'created' });

    const sinceCutoff = await readPlanEvents({ since_ts: cutoffTs });
    expect(sinceCutoff.map((e) => e.event)).toEqual(['now_updated', 'created']);

    const onlyA = await readPlanEvents({ planSlugs: ['a'] });
    expect(onlyA.map((e) => e.plan_slug)).toEqual(['a', 'a']);

    const onlyCreated = await readPlanEvents({ events: ['created'] });
    expect(onlyCreated.map((e) => e.plan_slug)).toEqual(['a', 'b']);
  });

  it('round-trips an agent_launched event (plan-agent-launch P-014)', async () => {
    await emitPlanEvent({
      planSlug: 'launchable-plan',
      event: 'agent_launched',
      after: 42,
      detail: 'advance phase 3',
      identity: null,
    });
    const launched = await readPlanEvents({ events: ['agent_launched'] });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.plan_slug).toBe('launchable-plan');
    expect(launched[0]?.event).toBe('agent_launched');
    expect(launched[0]?.after).toBe(42);
    expect(launched[0]?.detail).toBe('advance phase 3');
  });

  it('emitPlanEventForCaller never throws — even when the backend errors', async () => {
    // Emission is best-effort observability; a backend failure must never
    // break a plans:* write. Point the seam at a log that throws on append.
    const throwing = new InMemoryCoordLog();
    throwing.appendLine = () => {
      throw new Error('backend down');
    };
    configureCoordLog(throwing);
    await expect(
      emitPlanEventForCaller({}, { planSlug: 'x', event: 'created' }),
    ).resolves.toBeUndefined();
  });
});
