/**
 * Unit tests for watermarks (F-H2 — turn-start inbox scoping).
 * Pure filesystem, no PG.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyWatermark, readWatermark, writeWatermark } from '../watermarks';
import { watermarkFile } from '../paths';

let tmp = '';
let prev: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'coord-wm-'));
  prev = process.env.PAPERCUSP_COORD_DIR;
  process.env.PAPERCUSP_COORD_DIR = tmp;
});
afterEach(async () => {
  if (prev === undefined) delete process.env.PAPERCUSP_COORD_DIR;
  else process.env.PAPERCUSP_COORD_DIR = prev;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('readWatermark', () => {
  it('returns an empty watermark when the file does not exist', async () => {
    expect(await readWatermark('agent-a')).toEqual(emptyWatermark());
  });

  it('returns an empty watermark when the file is malformed', async () => {
    const file = watermarkFile('agent-a');
    await fs.mkdir(join(tmp, 'watermarks'), { recursive: true });
    await fs.writeFile(file, '{ not json', 'utf8');
    expect(await readWatermark('agent-a')).toEqual(emptyWatermark());
  });

  it('round-trips a written watermark', async () => {
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T10:00:00.000Z' });
    const wm = await readWatermark('agent-a');
    expect(wm.messages_since_ts).toBe('2026-05-20T10:00:00.000Z');
  });
});

describe('writeWatermark', () => {
  it('is a partial update — omitted fields keep their value', async () => {
    await writeWatermark('agent-a', {
      messages_since_ts: '2026-05-20T10:00:00.000Z',
      escalations_since_ts: '2026-05-20T09:00:00.000Z',
    });
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T11:00:00.000Z' });
    const wm = await readWatermark('agent-a');
    expect(wm.messages_since_ts).toBe('2026-05-20T11:00:00.000Z');
    // escalations_since_ts untouched by the second partial write.
    expect(wm.escalations_since_ts).toBe('2026-05-20T09:00:00.000Z');
  });

  it('replaces subscriptions_fired wholesale when supplied', async () => {
    await writeWatermark('agent-a', { subscriptions_fired: ['m1', 'm2'] });
    await writeWatermark('agent-a', { subscriptions_fired: ['m3'] });
    expect((await readWatermark('agent-a')).subscriptions_fired).toEqual(['m3']);
  });

  it('keeps two agents independent', async () => {
    await writeWatermark('agent-a', { messages_since_ts: '2026-05-20T10:00:00.000Z' });
    await writeWatermark('agent-b', { messages_since_ts: '2026-05-20T20:00:00.000Z' });
    expect((await readWatermark('agent-a')).messages_since_ts).toBe('2026-05-20T10:00:00.000Z');
    expect((await readWatermark('agent-b')).messages_since_ts).toBe('2026-05-20T20:00:00.000Z');
  });

  it('returns the merged watermark it persisted', async () => {
    const ret = await writeWatermark('agent-a', { plan_events_since_ts: '2026-05-20T12:00:00.000Z' });
    expect(ret.plan_events_since_ts).toBe('2026-05-20T12:00:00.000Z');
    expect(ret).toEqual(await readWatermark('agent-a'));
  });
});
