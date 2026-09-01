import { describe, it, expect } from 'vitest';
import {
  announceQuiesce,
  endQuiesce,
  announcedQuiesceIsActive,
  readActiveAnnouncedQuiesce,
  MAX_QUIESCE_MS,
  type AnnouncedQuiesceState,
  type AnnouncedQuiesceRecord,
  type AnnouncedQuiesceStoreDeps,
} from './announced-quiesce';

function memoryDeps(initial: AnnouncedQuiesceState = {}): AnnouncedQuiesceStoreDeps {
  let state = initial;
  return {
    async update(mutate) {
      state = mutate(state);
      return state;
    },
    async read() {
      return state;
    },
  };
}

describe('announcedQuiesceIsActive (pure)', () => {
  const record: AnnouncedQuiesceRecord = { reason: 'r', by: 'agent', announcedAt: 0, until: 1000 };

  it('active strictly before until', () => {
    expect(announcedQuiesceIsActive(record, 999)).toBe(true);
  });

  it('inactive AT until — the boundary is exclusive, so expiry fails closed the instant it passes', () => {
    expect(announcedQuiesceIsActive(record, 1000)).toBe(false);
  });

  it('inactive after until', () => {
    expect(announcedQuiesceIsActive(record, 1001)).toBe(false);
  });

  it('inactive with no record at all', () => {
    expect(announcedQuiesceIsActive(undefined, 0)).toBe(false);
  });
});

describe('announceQuiesce / readActiveAnnouncedQuiesce round-trip (DI, no PG)', () => {
  it('announces and reads back active evidence', async () => {
    const deps = memoryDeps();
    const now = 1_000_000;
    const rec = await announceQuiesce('bg-host', { reason: 'seed cut', by: 'su-x', untilMs: now + 60_000 }, now, deps);
    expect(rec).toEqual({ reason: 'seed cut', by: 'su-x', announcedAt: now, until: now + 60_000 });

    const evidence = await readActiveAnnouncedQuiesce('bg-host', now + 1000, deps);
    expect(evidence).toEqual({
      active: true,
      subject: 'bg-host',
      reason: 'seed cut',
      by: 'su-x',
      until: new Date(now + 60_000).toISOString(),
    });
  });

  it('reads inactive for a subject nothing was announced under', async () => {
    const deps = memoryDeps();
    await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: 60_000 }, 0, deps);
    expect(await readActiveAnnouncedQuiesce('some-other-subject', 0, deps)).toEqual({ active: false });
  });

  it('reads inactive once the window has expired — no separate end call is required (fail-closed by expiry)', async () => {
    const deps = memoryDeps();
    await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: 1000 }, 0, deps);
    expect((await readActiveAnnouncedQuiesce('bg-host', 999, deps)).active).toBe(true);
    expect(await readActiveAnnouncedQuiesce('bg-host', 1000, deps)).toEqual({ active: false });
    expect(await readActiveAnnouncedQuiesce('bg-host', 5000, deps)).toEqual({ active: false });
  });

  it('re-announcing the same subject extends/replaces the prior record', async () => {
    const deps = memoryDeps();
    await announceQuiesce('bg-host', { reason: 'first', by: 'a', untilMs: 1000 }, 0, deps);
    await announceQuiesce('bg-host', { reason: 'second', by: 'b', untilMs: 5000 }, 0, deps);
    const evidence = await readActiveAnnouncedQuiesce('bg-host', 2000, deps);
    expect(evidence).toMatchObject({ active: true, reason: 'second', by: 'b' });
  });
});

describe('endQuiesce', () => {
  it('clears an active announcement early', async () => {
    const deps = memoryDeps();
    await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: 60_000 }, 0, deps);
    expect((await readActiveAnnouncedQuiesce('bg-host', 100, deps)).active).toBe(true);

    await endQuiesce('bg-host', deps);
    expect(await readActiveAnnouncedQuiesce('bg-host', 100, deps)).toEqual({ active: false });
  });

  it('is a no-op when nothing is registered for the subject', async () => {
    const deps = memoryDeps();
    await expect(endQuiesce('nothing-registered-here', deps)).resolves.toBeUndefined();
  });

  it('does not disturb other subjects\' announcements', async () => {
    const deps = memoryDeps();
    await announceQuiesce('bg-host', { reason: 'r1', by: 'a', untilMs: 60_000 }, 0, deps);
    await announceQuiesce('other-subject', { reason: 'r2', by: 'b', untilMs: 60_000 }, 0, deps);

    await endQuiesce('bg-host', deps);

    expect((await readActiveAnnouncedQuiesce('bg-host', 100, deps)).active).toBe(false);
    expect((await readActiveAnnouncedQuiesce('other-subject', 100, deps)).active).toBe(true);
  });
});

describe('MAX_QUIESCE_MS clamping — a missed end() cannot wedge suppression open forever', () => {
  it('clamps an untilMs far in the future to now + MAX_QUIESCE_MS', async () => {
    const deps = memoryDeps();
    const now = 5_000_000;
    const rec = await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: now + MAX_QUIESCE_MS * 10 }, now, deps);
    expect(rec.until).toBe(now + MAX_QUIESCE_MS);
  });

  it('leaves an untilMs within the cap untouched', async () => {
    const deps = memoryDeps();
    const now = 0;
    const rec = await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: 60_000 }, now, deps);
    expect(rec.until).toBe(60_000);
  });

  it('the clamp is inclusive of exactly the max window', async () => {
    const deps = memoryDeps();
    const now = 0;
    const rec = await announceQuiesce('bg-host', { reason: 'r', by: 'a', untilMs: MAX_QUIESCE_MS }, now, deps);
    expect(rec.until).toBe(MAX_QUIESCE_MS);
  });
});

describe('readActiveAnnouncedQuiesce fails CLOSED on a read failure — even via the injected DI seam', () => {
  it('a throwing deps.read() reads as inactive, never as quiesced', async () => {
    const deps: AnnouncedQuiesceStoreDeps = {
      async update(mutate) {
        return mutate({});
      },
      async read() {
        throw new Error('pg unreachable');
      },
    };
    await expect(readActiveAnnouncedQuiesce('bg-host', 0, deps)).resolves.toEqual({ active: false });
  });
});
