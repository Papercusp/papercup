/**
 * WI-37700 — the embed-sidecar breaker watch.
 *
 * The assertions worth having here are NOT "a tripped breaker announces" (any
 * implementation does that). They are the three ways this watcher could go quietly
 * wrong and look healthy while doing it:
 *   1. announcing every tick on a PERMANENT latch (spam ⇒ the signal is ignored);
 *   2. reading a stale sidecar bundle's MISSING readings as an all-clear;
 *   3. never announcing again after a sidecar restart re-trips the same worker.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerBreakerWatchState,
  workerBreakerWatchTick,
  type WorkerBreakerWatchDeps,
} from './worker-breaker-watch';

function breaker(disabled: boolean) {
  return { alive: !disabled, disabled, pendingCount: 0, keepAlive: false };
}

function healthz(opts: {
  pid?: number;
  embedder?: boolean;
  reranker?: boolean;
  omitWorkers?: boolean;
}): unknown {
  const body: Record<string, unknown> = { ok: true, pid: opts.pid ?? 4242 };
  if (!opts.omitWorkers) {
    body.workers = {
      embedder: breaker(opts.embedder ?? false),
      reranker: breaker(opts.reranker ?? false),
    };
  }
  return body;
}

/** Typed so `notify.mock.calls[n][0].summary` is checkable — an untyped `vi.fn` infers a
 *  zero-arg signature, which silently makes every assertion on the message unreachable. */
function makeNotify() {
  return vi.fn<(a: { summary: string }) => Promise<void>>(async () => {});
}

function deps(
  body: unknown | null,
  notify: WorkerBreakerWatchDeps['notify'] = makeNotify(),
): WorkerBreakerWatchDeps {
  return {
    sidecarUrl: 'http://127.0.0.1:3384',
    fetchSidecarHealth: async () => body,
    notify,
  };
}

describe('workerBreakerWatchTick', () => {
  it('announces a tripped breaker once and names the worker + consequence', async () => {
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(
      deps(healthz({ reranker: true }), notify),
      createWorkerBreakerWatchState(),
    );

    expect(res.reachable).toBe(true);
    expect(res.announced).toEqual(['reranker']);
    expect(res.verdicts).toEqual({ embedder: 'ok', reranker: 'disabled' });
    expect(notify).toHaveBeenCalledTimes(1);
    const summary = notify.mock.calls[0]![0].summary;
    expect(summary).toContain('reranker');
    expect(summary).toContain('http://127.0.0.1:3384');
    expect(summary).toContain('pid 4242');
    // The consequence, not the field value — a reader who has not read WI-37688
    // cannot act on `disabled:true`.
    expect(summary).toContain('INLINE');
  });

  it('does NOT re-announce a latch that is still tripped on later ticks', async () => {
    // The regression that makes this feature useless rather than broken: the latch is
    // permanent, so a tick-triggered announcement without edge detection emits forever
    // and is filtered out by every recipient within a day.
    const notify = makeNotify();
    const state = createWorkerBreakerWatchState();
    const d = deps(healthz({ embedder: true }), notify);

    await workerBreakerWatchTick(d, state);
    const second = await workerBreakerWatchTick(d, state);
    const third = await workerBreakerWatchTick(d, state);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(second.announced).toEqual([]);
    expect(third.announced).toEqual([]);
    // Still REPORTED as disabled every tick — suppression is of the announcement only.
    expect(third.verdicts.embedder).toBe('disabled');
  });

  it('announces a breaker that was ALREADY tripped when the watcher first started', async () => {
    // Empty state must not be read as "previously false". A breaker that trips during
    // boot — the likeliest moment, since spawn failure is one of the two latch causes —
    // would otherwise never be announced at all.
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(
      deps(healthz({ embedder: true, reranker: true }), notify),
      createWorkerBreakerWatchState(),
    );
    expect(res.announced).toEqual(['embedder', 'reranker']);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('re-announces after the sidecar RESTARTS and trips again (pid change resets memory)', async () => {
    const notify = makeNotify();
    const state = createWorkerBreakerWatchState();

    await workerBreakerWatchTick(deps(healthz({ pid: 1, embedder: true }), notify), state);
    expect(notify).toHaveBeenCalledTimes(1);

    // Same worker, tripped again, but a DIFFERENT process — a fresh module state that
    // has genuinely tripped anew. Suppressing this would hide every trip after the
    // first for the life of the watcher. Note there is no intermediate `disabled:false`
    // observation here: a fast restart-then-trip never shows one, which is exactly why
    // the reset keys on pid rather than on seeing the latch clear.
    await workerBreakerWatchTick(deps(healthz({ pid: 2, embedder: true }), notify), state);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('re-announces when a breaker clears and trips again within the same process', async () => {
    const notify = makeNotify();
    const state = createWorkerBreakerWatchState();

    await workerBreakerWatchTick(deps(healthz({ embedder: true }), notify), state);
    await workerBreakerWatchTick(deps(healthz({ embedder: false }), notify), state);
    await workerBreakerWatchTick(deps(healthz({ embedder: true }), notify), state);

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('reports a stale bundle with NO workers block as absent — never as an all-clear', async () => {
    // The sidecar is a frozen build (see describeUnfitSidecar): one predating WI-37696
    // answers 200 with no `workers` key. Coercing that to disabled:false would
    // manufacture a false all-clear from a process that cannot report — the exact
    // failure class this item exists to close.
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(
      deps(healthz({ omitWorkers: true }), notify),
      createWorkerBreakerWatchState(),
    );

    expect(res.reachable).toBe(true);
    expect(res.readingsAbsent).toBe(true);
    expect(res.verdicts).toEqual({});
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not let a stale-bundle tick poison a later readable tick into silence', async () => {
    // If the absent tick wrote `false` into the dedupe memory, the first REAL reading of
    // a tripped breaker would be seen as "already false→still false" and stay silent.
    const notify = makeNotify();
    const state = createWorkerBreakerWatchState();

    await workerBreakerWatchTick(deps(healthz({ omitWorkers: true }), notify), state);
    const res = await workerBreakerWatchTick(deps(healthz({ embedder: true }), notify), state);

    expect(res.announced).toEqual(['embedder']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('treats a non-boolean `disabled` as unreadable rather than coercing it', async () => {
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(
      deps(
        { ok: true, pid: 7, workers: { embedder: { disabled: 'yes' }, reranker: breaker(false) } },
        notify,
      ),
      createWorkerBreakerWatchState(),
    );
    // 'yes' is truthy — coercing would announce a trip that never happened.
    expect(res.verdicts.embedder).toBe('absent');
    expect(res.verdicts.reranker).toBe('ok');
    expect(notify).not.toHaveBeenCalled();
  });

  it('stays silent and non-throwing when the sidecar does not answer', async () => {
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(deps(null, notify), createWorkerBreakerWatchState());
    expect(res.reachable).toBe(false);
    expect(res.announced).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not throw when the fetch itself rejects', async () => {
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(
      {
        sidecarUrl: 'http://127.0.0.1:3384',
        fetchSidecarHealth: async () => {
          throw new Error('ECONNREFUSED');
        },
        notify,
      },
      createWorkerBreakerWatchState(),
    );
    expect(res.reachable).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('retries on the next tick when notify fails, instead of marking it announced', async () => {
    // A dropped announcement must not be recorded as delivered — that would convert a
    // transient coord failure into permanent silence about a permanent degradation.
    const notify = vi
      .fn<(a: { summary: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('coord down'))
      .mockResolvedValue(undefined);
    const state = createWorkerBreakerWatchState();
    const d = deps(healthz({ reranker: true }), notify);

    await workerBreakerWatchTick(d, state);
    await workerBreakerWatchTick(d, state);

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('checks the second worker even when the first one`s notify throws', async () => {
    const notify = vi
      .fn<(a: { summary: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('coord down'))
      .mockResolvedValue(undefined);
    const res = await workerBreakerWatchTick(
      deps(healthz({ embedder: true, reranker: true }), notify),
      createWorkerBreakerWatchState(),
    );
    expect(res.announced).toEqual(['embedder', 'reranker']);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('reports a body that is not an object as unreachable-shaped rather than throwing', async () => {
    const notify = makeNotify();
    const res = await workerBreakerWatchTick(deps('nonsense', notify), createWorkerBreakerWatchState());
    expect(res.reachable).toBe(true);
    expect(res.readingsAbsent).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
