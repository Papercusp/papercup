import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import {
  _resetForTests,
  configureLocks,
  ensureBootstrap,
  inWorkspaceTxn,
  preserveOutsideWorkspaceTxn,
  WorkspaceContendedError,
  type WorkspaceTxnPhaseTiming,
} from '@papercusp/locks';

describe('outside-transaction preservation attribution (EI-28956526342522195)', () => {
  let cluster: DedicatedNativePg;
  let observer: postgres.Sql;

  beforeAll(async () => {
    cluster = await startDedicatedNativePg({ settings: { max_connections: '20' } });
    configureLocks({
      getAdminBaseUrl: () => cluster.getConnectionUri(),
      getTxnTimeouts: () => ({ lockTimeoutMs: 100, statementTimeoutMs: 2_000 }),
    });
    await ensureBootstrap();
    const url = new URL(cluster.getConnectionUri());
    url.pathname = '/papercusp_su';
    observer = postgres(url.toString(), { max: 1, prepare: false });
  }, 120_000);

  afterAll(async () => {
    try {
      await _resetForTests();
    } finally {
      try { await observer?.end({ timeout: 1 }); }
      finally { await cluster?.stop(); }
    }
  });

  it.each(['success', 'failure'] as const)(
    'identifies a paused capture and restores pool attribution after %s',
    async outcome => {
      const domain = `preservation-attribution-${randomUUID()}`;
      const owner = `su-${randomUUID()}`;
      const failure = new Error('original capture failure');
      const timings: WorkspaceTxnPhaseTiming[] = [];
      const backendIds: number[] = [];
      let resume!: () => void;
      let entered!: () => void;
      const captureGate = new Promise<void>(resolve => { resume = resolve; });
      const captureEntered = new Promise<void>(resolve => { entered = resolve; });
      const siblingOwner = `su-${randomUUID()}`;
      let resumeSibling: (() => void) | undefined;
      let sibling: Promise<unknown> | undefined;
      const startedAt = Date.now();
      const holder = inWorkspaceTxn(domain, owner, async tx => {
        const [backend] = await tx<{ pid: number; name: string }[]>`
          SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name`;
        backendIds.push(backend.pid);
        expect(backend.name).toBe(`papercusp-su:${owner}`);
        return preserveOutsideWorkspaceTxn(tx, domain, ['a.ts'], ['original-lease'], async () => {
          entered();
          await captureGate;
          if (outcome === 'failure') throw failure;
          return 'original-receipt';
        });
      }, { paths: ['a.ts'], onPhase: timing => timings.push(timing) });
      // Observe failures immediately as well, so a failed setup cannot leave a
      // parked capture or an unhandled rejection behind the diagnostic assertion.
      const settled = holder.then(
        result => ({ result, error: undefined }),
        error => ({ result: undefined, error }),
      );

      try {
        await Promise.race([
          captureEntered,
          settled.then(value => { throw value.error ?? new Error('capture never entered'); }),
        ]);
        const [activity] = await observer<{
          application_name: string; state: string; xact_start: Date | null;
        }[]>`SELECT application_name, state, xact_start FROM pg_stat_activity WHERE pid = ${backendIds[0]}`;
        expect(activity.state).toBe('idle');
        expect(activity.xact_start).toBeNull();
        const identity = /^su:pres:(\d+):(.+)$/.exec(activity.application_name);
        expect(identity, activity.application_name).not.toBeNull();
        expect(identity![2]).toBe(owner);
        expect(Number(identity![1])).toBeGreaterThanOrEqual(startedAt);
        expect(Number(identity![1])).toBeLessThanOrEqual(Date.now());
        expect(timings.filter(timing => timing.phase === 'preservation')).toEqual([]);

        // The diagnostic must not broaden or release the existing path fence.
        await expect(inWorkspaceTxn(domain, 'unrelated-reader', async () => 'unrelated', {
          paths: ['b.ts'],
        })).resolves.toBe('unrelated');
        let siblingEntered!: () => void;
        const siblingReady = new Promise<void>(resolve => { siblingEntered = resolve; });
        const siblingGate = new Promise<void>(resolve => { resumeSibling = resolve; });
        sibling = inWorkspaceTxn(domain, siblingOwner, tx =>
          preserveOutsideWorkspaceTxn(tx, domain, ['b.ts'], ['sibling-lease'], async () => {
            siblingEntered();
            await siblingGate;
            return 'sibling';
          }), { paths: ['b.ts'] });
        await Promise.race([siblingReady, sibling.then(() => { throw new Error('sibling capture never entered'); })]);
        const blocked = await Promise.all([
          inWorkspaceTxn(domain, 'same-path', async () => 'must not enter', { paths: ['a.ts'] }),
          inWorkspaceTxn(domain, 'global', async () => 'must not enter'),
        ].map(operation => operation.then(() => null, error => error)));
        for (const error of blocked) expect(error).toBeInstanceOf(WorkspaceContendedError);
        const samePath = (blocked[0] as WorkspaceContendedError).preservation;
        expect(samePath?.truncated).toBe(false);
        expect(samePath?.holders, JSON.stringify(samePath)).toEqual([{ owner, backendPid: backendIds[0],
          startedAtMs: Number(identity![1]), phase: 'preservation', ownerComplete: true }]);
        expect(samePath!.observedAtMs).toBeGreaterThanOrEqual(Number(identity![1]));
        const global = (blocked[1] as WorkspaceContendedError).preservation;
        expect(global?.holders.map(holder => holder.owner).sort()).toEqual([owner, siblingOwner].sort());
      } finally {
        try {
          resumeSibling?.();
          await sibling;
        } finally {
          resume();
          await settled;
        }
      }

      const actual = await settled;
      if (outcome === 'failure') expect(actual.error).toBe(failure);
      else expect(actual).toEqual({ result: 'original-receipt', error: undefined });
      expect(new Set(backendIds).size).toBe(1);
      const preservation = timings.filter(timing => timing.phase === 'preservation');
      expect(preservation).toHaveLength(1);
      expect(preservation[0].durationMs).toBeGreaterThanOrEqual(0);
      const [released] = await observer<{ application_name: string; held: number }[]>`
        SELECT application_name, (SELECT count(*)::int FROM pg_locks
          WHERE pid = ${backendIds[0]} AND locktype = 'advisory' AND classid = 101) AS held
        FROM pg_stat_activity WHERE pid = ${backendIds[0]}`;
      expect(released).toEqual({ application_name: `pcusp:su-lock-tx:p${process.pid}`, held: 0 });
    }, 30_000,
  );

  it('keeps ordinary transactions attributable without a preservation phase', async () => {
    const timings: WorkspaceTxnPhaseTiming[] = [];
    const owner = `su-${randomUUID()}`;
    const backendId = await inWorkspaceTxn(`ordinary-${randomUUID()}`, owner, async tx => {
      const [row] = await tx<{ pid: number; name: string }[]>`
        SELECT pg_backend_pid() AS pid, current_setting('application_name') AS name`;
      expect(row.name).toBe(`papercusp-su:${owner}`);
      return row.pid;
    }, { onPhase: timing => timings.push(timing) });
    expect(timings.some(timing => timing.phase === 'preservation')).toBe(false);
    const [row] = await observer<{ application_name: string }[]>`
      SELECT application_name FROM pg_stat_activity WHERE pid = ${backendId}`;
    expect(row.application_name).toBe(`pcusp:su-lock-tx:p${process.pid}`);
  });
});
