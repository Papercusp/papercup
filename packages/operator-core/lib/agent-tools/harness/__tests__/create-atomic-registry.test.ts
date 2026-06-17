/**
 * harness:create — atomic registry write (audit P-006 / EI-82).
 *
 * REGRESSION GUARD for the lost-update race the sibling HTTP route
 * (POST /harness/projects) already closed with `mutateHarnessRegistry`
 * (projects.ts:312-328) but the agent-facing `harness:create` tool did NOT.
 *
 * The buggy shape was: `loadHarnessRegistry()` → `reg.projects.push(entry)` →
 * `saveHarnessRegistry(reg)`. Two concurrent creates each read the SAME stale
 * snapshot, each push their own entry onto it, and the second save silently
 * reverts the first → a harness vanishes with no error. The fix routes the
 * write through `mutateHarnessRegistry((reg) => …)` so the two writes serialize
 * on the operator-state row's FOR UPDATE tx (each sees the prior commit), with
 * an in-transaction duplicate-slug re-check (the top-of-handler dup check is a
 * pure TOCTOU window).
 *
 * PG-free: registry/schema/triggers are doMock'd (same rig as
 * create-git-sync-seed.test.ts). The mock's registry-write seam carries a
 * one-shot BARRIER so we can force the worst-case interleaving DETERMINISTICALLY
 * (vitest's concurrent dynamic-import mocks are unreliable under raw
 * Promise.all). Create B is parked at its write holding its pre-write read;
 * create C then runs to completion; B is released to write LAST. Against the
 * buggy load/push/save B's stale write reverts C (final = [a,b]); against the
 * atomic mutate B re-reads inside the tx and both survive (final = [a,b,c]).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAKE_CTX = () =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'x',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

type Entry = { slug: string; path: string } & Record<string, unknown>;

/** The shared committed registry the mock serves and mutates — the one row the
 *  real operator-state FOR UPDATE tx serializes on. */
let store: { projects: Entry[] } & Record<string, unknown>;

// One-shot barrier on the registry-WRITE seam: the FIRST writer to arrive parks
// on `gate` (after signalling `firstArrived`) so a second create can interleave
// its full read+write before the first commits. Re-armed each test.
let gate: Promise<void>;
let openGate: () => void;
let firstArrived: () => void;
let firstArrivedP: Promise<void>;

const clone = (projects: Entry[]): Entry[] => projects.map((p) => ({ ...p }));

beforeEach(() => {
  vi.resetModules();
  store = { projects: [{ slug: 'a', path: '/a' }] };
  gate = new Promise<void>((r) => (openGate = r));
  firstArrivedP = new Promise<void>((r) => (firstArrived = r));
  let armed = true;
  // The first write-seam arrival blocks on the gate; subsequent arrivals pass.
  const arriveBlock = async () => {
    if (armed) {
      armed = false;
      firstArrived();
      await gate;
    }
  };

  vi.doMock('../../../harness-registry', () => ({
    // A snapshot read of the committed value (not a live row handle).
    loadHarnessRegistry: async () => ({ ...store, projects: clone(store.projects) }),
    // Legacy non-atomic sink: blind last-write-wins overwrite of the row. Gated
    // at the write seam to force the lost-update interleaving.
    saveHarnessRegistry: async (reg: { projects: Entry[] }) => {
      await arriveBlock();
      store = { ...store, projects: clone(reg.projects) };
    },
    // Atomic RMW: re-read the CURRENT committed value inside the (modeled) FOR
    // UPDATE tx and commit the mutator's result. Same gate so the interleaving
    // is identical — only the re-read distinguishes the two.
    mutateHarnessRegistry: async (
      mutator: (reg: { projects: Entry[] }) => { projects: Entry[] },
    ) => {
      await arriveBlock();
      const current = { ...store, projects: clone(store.projects) };
      const next = mutator(current);
      store = { ...store, projects: clone(next.projects) };
      return store;
    },
  }));
  vi.doMock('../../../scaffold-harness-schema', () => ({
    scaffoldHarnessSchema: async () => {},
  }));
  vi.doMock('../../../blueprint/materialize-triggers', () => ({
    materializeBlueprintTriggers: async () => [],
  }));
});
afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../scaffold-harness-schema');
  vi.doUnmock('../../../blueprint/materialize-triggers');
});

async function loadTool(): Promise<{
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
}> {
  return (await import('../create')).default as never;
}

function makeArgs(slug: string, dir: string) {
  return {
    slug,
    path: dir,
    blueprint: { id: slug, extends: 'coding', dependencies: { tools: [], packs: [], plugins: [] } },
  };
}

describe('harness:create — atomic registry write (lost-update guard)', () => {
  it('two interleaved creates both survive — the final registry contains BOTH new slugs', async () => {
    const tool = await loadTool();
    const dirB = await fs.mkdtemp(join(tmpdir(), 'create-atomic-b-'));
    const dirC = await fs.mkdtemp(join(tmpdir(), 'create-atomic-c-'));
    try {
      // Start B; it reaches its registry-write seam and parks there, holding the
      // {projects:[{slug:'a'}]} snapshot it read before any commit.
      const pB = tool.handler(makeArgs('b', dirB), MAKE_CTX());
      await firstArrivedP;
      // Run C to completion — its write passes the (now-disarmed) gate, so it
      // reads + commits against the current store while B is still parked.
      const resC = await tool.handler(makeArgs('c', dirC), MAKE_CTX());
      // Release B — its write lands LAST. The buggy load/push/save would now
      // overwrite the row with B's stale [a,b], reverting C.
      openGate();
      const resB = await pB;

      expect(parsePayload(resB).ok).toBe(true);
      expect(parsePayload(resC).ok).toBe(true);

      const slugs = store.projects.map((p) => p.slug).sort();
      // The pre-existing 'a' plus BOTH new slugs. The lost-update bug drops one.
      expect(slugs).toEqual(['a', 'b', 'c']);
    } finally {
      await fs.rm(dirB, { recursive: true, force: true });
      await fs.rm(dirC, { recursive: true, force: true });
    }
  });

  it('rejects a slug that already exists in the committed registry (in-transaction dup re-check)', async () => {
    const tool = await loadTool();
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-atomic-dup-'));
    try {
      // 'dup' is already committed; the create must reject it and never write a
      // duplicate row — the same guard the in-tx re-check enforces when the slug
      // appears between the top-of-handler read and the serialized write.
      store = { projects: [{ slug: 'a', path: '/a' }, { slug: 'dup', path: '/existing' }] };
      const payload = parsePayload(await tool.handler(makeArgs('dup', dir), MAKE_CTX()));
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/slug already exists/);
      expect(store.projects.filter((p) => p.slug === 'dup')).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
