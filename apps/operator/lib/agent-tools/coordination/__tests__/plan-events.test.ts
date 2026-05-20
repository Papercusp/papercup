/**
 * Unit tests for plan-events.ts — the working-memory history feed.
 * Pure filesystem, no PG. Uses PAPERCUSP_COORD_DIR.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emitPlanEvent,
  emitPlanEventForCaller,
  listPlanEventsFiles,
  planEventsFile,
  readPlanEvents,
} from '../plan-events';

let tmp = '';
let prev: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'plan-events-'));
  prev = process.env.PAPERCUSP_COORD_DIR;
  process.env.PAPERCUSP_COORD_DIR = tmp;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.PAPERCUSP_COORD_DIR;
  else process.env.PAPERCUSP_COORD_DIR = prev;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('plan-events', () => {
  it('emitPlanEvent writes a typed envelope to coord/plan-events.jsonl', async () => {
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
    const ym = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`;
    expect(planEventsFile()).toBe(join(tmp, `plan-events-${ym}.jsonl`));
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
    await emitPlanEventForCaller(
      {},
      { planSlug: 'p1', event: 'item_added', detail: 'P-001' },
    );
    const events = await readPlanEvents();
    expect(events.map((e) => e.from)).toEqual([
      'pus-abcdefab-cdef-...',
      'system',
    ]);
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

  it('emitPlanEventForCaller never throws — even with a bad coord dir', async () => {
    // Point coord dir at a path we cannot write (a regular file).
    const sentinel = join(tmp, 'sentinel');
    await fs.writeFile(sentinel, 'x');
    process.env.PAPERCUSP_COORD_DIR = sentinel; // file, not a directory
    await expect(
      emitPlanEventForCaller({}, { planSlug: 'x', event: 'created' }),
    ).resolves.toBeUndefined();
  });

  it('reads across legacy + monthly rotation files (F-M2)', async () => {
    // A pre-rotation legacy file with one old event.
    await fs.writeFile(
      join(tmp, 'plan-events.jsonl'),
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        msg_id: '0-0-old',
        from: 'system',
        to: ['*'],
        kind: 'plan_event',
        plan_slug: 'legacy-plan',
        event: 'created',
      }) + '\n',
    );
    // An out-of-band older monthly file.
    await fs.writeFile(
      join(tmp, 'plan-events-2026-03.jsonl'),
      JSON.stringify({
        ts: '2026-03-15T00:00:00.000Z',
        msg_id: '1-0-mar',
        from: 'system',
        to: ['*'],
        kind: 'plan_event',
        plan_slug: 'march-plan',
        event: 'item_added',
      }) + '\n',
    );
    // A current-month event via the normal emit path.
    await emitPlanEvent({ planSlug: 'current-plan', event: 'promoted', identity: null });

    const files = await listPlanEventsFiles();
    // legacy first, then monthly chronological — current month last.
    expect(files[0]?.endsWith('plan-events.jsonl')).toBe(true);
    expect(files.length).toBe(3);

    const all = await readPlanEvents();
    expect(all.map((e) => e.plan_slug)).toEqual([
      'legacy-plan',
      'march-plan',
      'current-plan',
    ]);

    // filesBack caps to the most-recent N files.
    const recent = await readPlanEvents({ filesBack: 1 });
    expect(recent.map((e) => e.plan_slug)).toEqual(['current-plan']);
  });
});
