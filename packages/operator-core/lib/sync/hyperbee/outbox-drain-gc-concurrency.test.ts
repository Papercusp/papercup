/**
 * EI-218417: boot-all bounds handle creation, but each startOutboxDrain call
 * detaches its immediate catch-up pass. Without a process-wide GC admission
 * guard, a large registry therefore launches one inline DELETE loop per
 * harness at once and can wedge the host before real outbox rows drain.
 */
import { describe, expect, it } from 'vitest';
import type { BootedHarnessHandle } from './boot';
import {
  DEFAULT_OUTBOX_DRAIN_CONCURRENCY,
  drainOutboxOnce,
  startOutboxDrain,
} from './outbox-drain';

function emptyResult(): unknown[] & { count?: number } {
  const rows = [] as unknown[] & { count?: number };
  rows.count = 0;
  return rows;
}

function fakeHandle(harnessSlug: string): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug,
    ownLog: { keyHex: 'aa'.repeat(32) },
    append: async () => {},
  } as unknown as BootedHarnessHandle;
}

function fakePg(onGc: () => Promise<void>) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/WITH del AS/.test(sql)) await onGc();
    return emptyResult();
  };
  return tag as never;
}

describe('process-wide inline outbox GC admission (EI-218417)', () => {
  it('admits one harness GC at a time and lets a contending harness drain without queueing behind it', async () => {
    let releaseFirstGc!: () => void;
    const firstGcBlocked = new Promise<void>((resolve) => {
      releaseFirstGc = resolve;
    });
    let firstGcEntered!: () => void;
    const firstGcStarted = new Promise<void>((resolve) => {
      firstGcEntered = resolve;
    });

    let activeGc = 0;
    let maxActiveGc = 0;
    let firstGcCalls = 0;
    let secondGcCalls = 0;

    const firstPg = fakePg(async () => {
      firstGcCalls += 1;
      activeGc += 1;
      maxActiveGc = Math.max(maxActiveGc, activeGc);
      firstGcEntered();
      try {
        await firstGcBlocked;
      } finally {
        activeGc -= 1;
      }
    });
    const secondPg = fakePg(async () => {
      secondGcCalls += 1;
      activeGc += 1;
      maxActiveGc = Math.max(maxActiveGc, activeGc);
      activeGc -= 1;
    });

    const firstDrain = drainOutboxOnce(fakeHandle('first'), firstPg);
    await firstGcStarted;

    // The second drain must skip best-effort GC and reach its real row SELECT;
    // it must not sit behind the first harness's slow maintenance query.
    await expect(drainOutboxOnce(fakeHandle('second'), secondPg)).resolves.toBe(0);
    expect(secondGcCalls).toBe(0);

    releaseFirstGc();
    await expect(firstDrain).resolves.toBe(0);
    expect(firstGcCalls).toBe(1);
    expect(maxActiveGc).toBe(1);
  });
});

function fakeLoopPg(harnessSlug: string, onBatch: (harnessSlug: string) => Promise<void>) {
  const tag = async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name, op, key, row, ts/.test(sql)) await onBatch(harnessSlug);
    return emptyResult();
  };
  (tag as unknown as { listen: () => Promise<{ unlisten: () => Promise<void> }> }).listen = async () => ({
    unlisten: async () => {},
  });
  return tag as never;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

describe('process-wide outbox batch admission (EI-21855287664853515)', () => {
  it('bounds detached catch-up SELECT batches and hands the FIFO slot to the next harness', async () => {
    const total = DEFAULT_OUTBOX_DRAIN_CONCURRENCY + 3;
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const drains = Array.from({ length: total }, (_, i) => {
      const slug = `h${i}`;
      const pg = fakeLoopPg(slug, async (enteredSlug) => {
        started.push(enteredSlug);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      });
      return startOutboxDrain(fakeHandle(slug), pg, { pollMs: 0, _passTimeoutMs: 0 });
    });

    await waitUntil(
      () => started.length === DEFAULT_OUTBOX_DRAIN_CONCURRENCY,
      'initial admitted drain wave did not start',
    );
    expect(maxActive).toBe(DEFAULT_OUTBOX_DRAIN_CONCURRENCY);
    // Inline GC runs inside each already-admitted pass before the main SELECT,
    // so those four may reach onBatch in any order. The admitted SET is stable;
    // FIFO becomes observable at the first queued harness below.
    expect([...started].sort()).toEqual(
      Array.from({ length: DEFAULT_OUTBOX_DRAIN_CONCURRENCY }, (_, i) => `h${i}`),
    );

    // Releasing one admitted batch must admit exactly the oldest waiter; the
    // remaining queued harnesses stay out of postgres JSONB decoding.
    releases.shift()!();
    await waitUntil(
      () => started.length === DEFAULT_OUTBOX_DRAIN_CONCURRENCY + 1,
      'next FIFO drain did not acquire the released slot',
    );
    expect(started.at(-1)).toBe(`h${DEFAULT_OUTBOX_DRAIN_CONCURRENCY}`);
    expect(maxActive).toBe(DEFAULT_OUTBOX_DRAIN_CONCURRENCY);

    while (releases.length > 0) releases.shift()!();
    await waitUntil(() => started.length === total, 'all queued drains were not eventually admitted');
    while (releases.length > 0) releases.shift()!();
    await waitUntil(() => active === 0, 'admitted drains did not settle');
    await Promise.all(drains.map((drain) => drain.stop()));
  });
});
