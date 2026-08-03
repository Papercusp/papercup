import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSiblingManagedTimers,
  describeProcessRole,
  listSiblingOperators,
  ownHonoPort,
  probeSibling,
  type SiblingOperator,
} from './schedule-federation';

const sibling = (over: Partial<SiblingOperator> = {}): SiblingOperator => ({
  port: 3271,
  pid: 4242,
  startedAt: 1_700_000_000_000,
  ...over,
});

/** A fetch stub answering the managed-timers probe with `timers`. */
const okFetch =
  (body: Record<string, unknown>) =>
  async () => ({ ok: true, status: 200, json: async () => body });

describe('describeProcessRole', () => {
  it('reports bg-host only when background workers are actually enabled', () => {
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '1' })).toBe('bg-host');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: 'true' })).toBe('bg-host');
    // The falsy spellings must NOT read as bg-host — a mislabelled row would send a
    // reader to the wrong process to explain a stalled timer.
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '0' })).toBe('operator');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: 'false' })).toBe('operator');
    expect(describeProcessRole({ PAPERCUSP_BACKGROUND_WORKERS: '' })).toBe('operator');
    expect(describeProcessRole({})).toBe('operator');
  });
});

describe('ownHonoPort', () => {
  it('matches the expression the discovery-file WRITER uses', () => {
    // Load-bearing: endpoint-ipc-discovery.ts publishes under
    // `Number(PAPERCUSP_HONO_PORT) || 3070`. If this diverges, a process stops
    // recognising its OWN discovery file and federates itself, double-counting
    // every one of its timers.
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: '3271' })).toBe(3271);
    expect(ownHonoPort({})).toBe(3070);
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: '' })).toBe(3070);
    expect(ownHonoPort({ PAPERCUSP_HONO_PORT: 'nonsense' })).toBe(3070);
  });
});

describe('listSiblingOperators', () => {
  it('returns live per-port siblings, excluding self, dead pids, and the legacy singleton', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sched-fed-'));
    const write = (name: string, body: unknown) =>
      writeFile(join(dir, name), JSON.stringify(body), 'utf8');

    await write('endpoint-ipc.3070.json', { socketPath: '/s/a', pid: 111, startedAt: 1, port: 3070 });
    await write('endpoint-ipc.3271.json', { socketPath: '/s/b', pid: 222, startedAt: 2, port: 3271 });
    await write('endpoint-ipc.3170.json', { socketPath: '/s/c', pid: 999, startedAt: 3, port: 3170 });
    // The legacy singleton is last-writer-wins across every operator on the box —
    // including it would duplicate a per-port sibling or point at a different process
    // than its filename implies.
    await write('endpoint-ipc.json', { socketPath: '/s/b', pid: 222, startedAt: 2, port: 3271 });
    await writeFile(join(dir, 'endpoint-ipc.4242.json'), '{ not json', 'utf8');
    await write('embedded-pg.json', { unrelated: true });

    const found = await listSiblingOperators({
      dir,
      selfPort: 3070,
      isAlive: (pid) => pid !== 999, // 3170's advertisement is stale
    });

    expect(found.map((s) => s.port)).toEqual([3271]);
    expect(found[0]).toMatchObject({ pid: 222, startedAt: 2 });
  });

  it('returns [] when the discovery dir does not exist', async () => {
    expect(await listSiblingOperators({ dir: join(tmpdir(), 'sched-fed-absent-dir-xyz') })).toEqual([]);
  });
});

describe('probeSibling', () => {
  it('returns the sibling timers and a self-identified label', async () => {
    const got = await probeSibling(sibling(), {
      fetchImpl: okFetch({
        process: 'bg-host',
        timers: [{ name: 'attention-reconcile-unanswerable', intervalMs: 3_600_000 }],
      }),
    });
    expect(got.ok).toBe(true);
    expect(got.label).toBe('bg-host:3271');
    expect(got.timers).toHaveLength(1);
  });

  it('NEVER rejects — a throwing/refusing/non-2xx probe degrades to ok:false', async () => {
    const refused = await probeSibling(sibling(), {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('ECONNREFUSED');
    // The label still identifies WHICH process is unknown, so a degraded row is
    // actionable rather than anonymous.
    expect(refused.label).toBe('operator:3271');

    const http500 = await probeSibling(sibling(), {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    expect(http500).toMatchObject({ ok: false, error: 'HTTP 500', timers: [] });

    const garbage = await probeSibling(sibling(), {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'not-an-object' }),
    });
    expect(garbage).toMatchObject({ ok: true, timers: [] });
  });
});

describe('collectSiblingManagedTimers — a wedged sibling cannot block the inventory', () => {
  /*
   * THE RECURRENCE GUARD (EI-19445595198254637 / EI-19446421329946902).
   *
   * bg-host has been measured accepting a connection and then returning ZERO BYTES
   * for 45s while staying alive. A fan-out that waits on that would convert a
   * degraded sibling into a hung operator — trading a visibility bug for an
   * availability bug. This stub is deliberately WORSE than reality: it ignores its
   * AbortSignal entirely, so only the outer budget can save the call.
   */
  const neverAnswers = async () => new Promise<never>(() => {});

  it('resolves within the budget even when the sibling ignores its abort signal', async () => {
    const startedAt = Date.now();
    const rows = await collectSiblingManagedTimers({
      siblings: [sibling()],
      timeoutMs: 10_000, // deliberately longer than the budget: the budget must win
      budgetMs: 60,
      fetchImpl: neverAnswers,
    });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(2_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, port: 3271, timers: [] });
    expect(rows[0].error).toContain('budget');
  });

  it('degrades ONLY the wedged sibling — healthy siblings still report their timers', async () => {
    // A whole-set race would discard the healthy sibling's data to punish the wedged
    // one; that would hide exactly the timers this change exists to reveal.
    const rows = await collectSiblingManagedTimers({
      siblings: [sibling({ port: 3271 }), sibling({ port: 3170, pid: 77 })],
      timeoutMs: 10_000,
      budgetMs: 60,
      fetchImpl: (async (url: string) =>
        url.includes('3271')
          ? await neverAnswers()
          : { ok: true, status: 200, json: async () => ({ process: 'operator', timers: [{ name: 'poll-suspect' }] }) }) as never,
    });

    const byPort = Object.fromEntries(rows.map((r) => [r.port, r]));
    expect(byPort[3271]).toMatchObject({ ok: false, timers: [] });
    expect(byPort[3170]).toMatchObject({ ok: true });
    expect(byPort[3170].timers).toHaveLength(1);
  });

  it('short-circuits with no siblings and never probes', async () => {
    let called = 0;
    const rows = await collectSiblingManagedTimers({
      siblings: [],
      fetchImpl: (async () => {
        called += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }) as never,
    });
    expect(rows).toEqual([]);
    expect(called).toBe(0);
  });
});
