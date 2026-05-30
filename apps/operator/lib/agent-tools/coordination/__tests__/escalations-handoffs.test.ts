/**
 * Unit tests for escalations + handoffs (Phase C).
 * Pure filesystem (per-event files), no PG.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

let tmp = '';
let prev: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'coord-c-'));
  prev = process.env.PAPERCUSP_COORD_DIR;
  process.env.PAPERCUSP_COORD_DIR = tmp;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.PAPERCUSP_COORD_DIR;
  else process.env.PAPERCUSP_COORD_DIR = prev;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('escalations', () => {
  it('openEscalation writes a per-event file with resolved=null', async () => {
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

  it('resolveEscalation appends an escalation_resolved sibling and leaves the open file immutable', async () => {
    const A = id('A');
    const e = await openEscalation(A, { severity: 'blocker', summary: 'need a call' });
    const openPath = join(tmp, 'escalations', `${e.msg_id}.json`);
    const openBytesBefore = await fs.readFile(openPath, 'utf8');

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

    // Append-only: the open escalation file is byte-for-byte unchanged.
    const openBytesAfter = await fs.readFile(openPath, 'utf8');
    expect(openBytesAfter).toBe(openBytesBefore);
    expect(JSON.parse(openBytesAfter).resolved).toBeNull();

    // A single sibling escalation_resolved event exists, linked by related_msg_id.
    const files = await fs.readdir(join(tmp, 'escalations'));
    const events: Array<Record<string, unknown>> = [];
    for (const f of files) {
      const rec = JSON.parse(await fs.readFile(join(tmp, 'escalations', f), 'utf8'));
      if (rec.kind === 'escalation_resolved') events.push(rec);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.related_msg_id).toBe(e.msg_id);
    expect(events[0]?.choice).toBe('go');

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
});
