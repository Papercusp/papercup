/**
 * EI-218417: boot-all bounds handle creation, but each startOutboxDrain call
 * detaches its immediate catch-up pass. Without a process-wide GC admission
 * guard, a large registry therefore launches one inline DELETE loop per
 * harness at once and can wedge the host before real outbox rows drain.
 */
import { describe, expect, it } from 'vitest';
import type { BootedHarnessHandle } from './boot';
import { drainOutboxOnce } from './outbox-drain';

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
