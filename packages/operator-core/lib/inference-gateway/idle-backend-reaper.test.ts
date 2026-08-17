import { describe, expect, it, vi } from 'vitest';
import {
  runIdleBackendReap,
  probeLlamaServerSlots,
  type BusyObservation,
  type IdleBackendReaperDeps,
} from './idle-backend-reaper';
import type { LocalBackendRecord } from './local-backend-store';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const secondsAgo = (n: number) => new Date(NOW.getTime() - n * 1000).toISOString();

/** The real ornith shape: baseUrl is the always-on proxy, unitName the GPU-resident unit. */
function backend(over: Partial<LocalBackendRecord> = {}): LocalBackendRecord {
  return {
    id: 'ornith-llamaserver',
    kind: 'llama-server',
    baseUrl: 'http://127.0.0.1:11435',
    models: ['ornith'],
    maxConcurrent: 3,
    enabled: true,
    lifecycle: 'on-demand',
    idleTtlSec: 1800,
    unitName: 'llama-ornith.service',
    lastBusyAt: secondsAgo(60),
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function harness(opts: { backends?: LocalBackendRecord[]; observe?: BusyObservation | (() => Promise<BusyObservation>) } = {}) {
  const stopBackend = vi.fn(async () => ({ ok: true }));
  const markBusy = vi.fn(async () => true);
  const observe = opts.observe ?? ({ state: 'idle' } as BusyObservation);
  const deps: IdleBackendReaperDeps = {
    listOnDemand: async () => opts.backends ?? [backend()],
    probeBusy: typeof observe === 'function' ? observe : async () => observe,
    stopBackend,
    markBusy,
    now: () => NOW,
  };
  return { deps, stopBackend, markBusy };
}

describe('runIdleBackendReap', () => {
  it('stops a backend idle past its TTL', async () => {
    const { deps, stopBackend } = harness({ backends: [backend({ lastBusyAt: secondsAgo(1801) })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.stopped).toEqual(['ornith-llamaserver']);
    expect(stopBackend).toHaveBeenCalledTimes(1);
    // It stops the RECORD, so the unit/baseUrl distinction survives the hop to the provisioner.
    expect(stopBackend.mock.calls[0][0]).toMatchObject({ unitName: 'llama-ornith.service' });
  });

  it('does NOT stop a backend that is idle but still inside its TTL', async () => {
    const { deps, stopBackend } = harness({ backends: [backend({ lastBusyAt: secondsAgo(1799) })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.stopped).toEqual([]);
    expect(r.waiting).toEqual([{ id: 'ornith-llamaserver', idleSec: 1799, ttlSec: 1800 }]);
    expect(stopBackend).not.toHaveBeenCalled();
  });

  /** The single most important property: one idle sample is not a reason to stop anything. A
   *  backend can be between two requests — the watermark, not this poll, decides. */
  it('never stops on a single idle observation when the watermark is fresh', async () => {
    const { deps, stopBackend } = harness({ backends: [backend({ lastBusyAt: secondsAgo(1) })] });
    await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });
    expect(stopBackend).not.toHaveBeenCalled();
  });

  /** …and its converse: a busy poll short-circuits even when the watermark is ancient, so a
   *  backend that has been working since before the last successful stamp is never reaped. */
  it('never stops a BUSY backend, however stale its watermark', async () => {
    const { deps, stopBackend, markBusy } = harness({
      backends: [backend({ lastBusyAt: secondsAgo(999_999) })],
      observe: { state: 'busy' },
    });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(stopBackend).not.toHaveBeenCalled();
    expect(r.busy).toEqual(['ornith-llamaserver']);
    expect(markBusy).toHaveBeenCalledWith('ornith-llamaserver');
  });

  it('treats a down backend as the normal steady state — no stop, no watermark write', async () => {
    const { deps, stopBackend, markBusy } = harness({
      backends: [backend({ lastBusyAt: secondsAgo(999_999) })],
      observe: { state: 'down' },
    });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.down).toEqual(['ornith-llamaserver']);
    expect(r.stopped).toEqual([]);
    expect(stopBackend).not.toHaveBeenCalled();
    expect(markBusy).not.toHaveBeenCalled();
  });

  it('refuses to reap what it cannot observe, and says so', async () => {
    const { deps, stopBackend } = harness({
      backends: [backend({ lastBusyAt: secondsAgo(999_999) })],
      observe: { state: 'unreadable', detail: 'GET /slots → HTTP 501' },
    });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(stopBackend).not.toHaveBeenCalled();
    expect(r.unreadable).toEqual([{ id: 'ornith-llamaserver', detail: 'GET /slots → HTTP 501' }]);
  });

  it('treats a THROWN probe as unreadable, not as idle', async () => {
    const { deps, stopBackend } = harness({
      backends: [backend({ lastBusyAt: secondsAgo(999_999) })],
      observe: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(stopBackend).not.toHaveBeenCalled();
    expect(r.unreadable[0].detail).toMatch(/probe threw: ECONNRESET/);
  });

  it('honours a per-backend idleTtlSec over the reaper default', async () => {
    const { deps, stopBackend } = harness({
      backends: [backend({ idleTtlSec: 60, lastBusyAt: secondsAgo(120) })],
    });
    await runIdleBackendReap(deps, { defaultIdleTtlSec: 999_999 });
    expect(stopBackend).toHaveBeenCalledTimes(1);
  });

  it('falls back to the reaper default when the backend sets no TTL', async () => {
    const { deps, stopBackend } = harness({
      backends: [backend({ idleTtlSec: null, lastBusyAt: secondsAgo(120) })],
    });
    await runIdleBackendReap(deps, { defaultIdleTtlSec: 60 });
    expect(stopBackend).toHaveBeenCalledTimes(1);
  });

  it('reports without stopping under dryRun', async () => {
    const { deps, stopBackend } = harness({ backends: [backend({ lastBusyAt: secondsAgo(1801) })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900, dryRun: true });

    expect(r.stopped).toEqual(['ornith-llamaserver']);
    expect(r.dryRun).toBe(true);
    expect(stopBackend).not.toHaveBeenCalled();
  });

  it('records a failed stop instead of reporting it stopped', async () => {
    const { deps } = harness({ backends: [backend({ lastBusyAt: secondsAgo(1801) })] });
    deps.stopBackend = async () => ({ ok: false, error: 'Unit llama-ornith.service not loaded.' });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.stopped).toEqual([]);
    expect(r.failures).toEqual([{ id: 'ornith-llamaserver', error: 'Unit llama-ornith.service not loaded.' }]);
  });

  /** A lost watermark write is not cosmetic — it is how a working backend later looks idle. */
  it('surfaces a failed watermark write on a BUSY backend as a failure', async () => {
    const { deps } = harness({ observe: { state: 'busy' } });
    deps.markBusy = async () => {
      throw new Error('pool exhausted');
    };
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.failures[0].id).toBe('ornith-llamaserver');
    expect(r.failures[0].error).toMatch(/watermark write FAILED.*wrongly reaped/i);
  });

  it('warns when the poll interval is too coarse to judge the TTL', async () => {
    const { deps } = harness({ backends: [backend({ idleTtlSec: 120 })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900, pollIntervalSec: 60 });
    expect(r.warnings[0]).toMatch(/fewer than 4 polls/);
  });

  it('does not warn when the interval samples the TTL often enough', async () => {
    const { deps } = harness({ backends: [backend({ idleTtlSec: 1800 })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900, pollIntervalSec: 60 });
    expect(r.warnings).toEqual([]);
  });

  it('refuses to compute an idle age from an unparseable watermark', async () => {
    const { deps, stopBackend } = harness({ backends: [backend({ lastBusyAt: 'not-a-date' })] });
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(stopBackend).not.toHaveBeenCalled();
    expect(r.unreadable[0].detail).toMatch(/unparseable lastBusyAt/);
  });

  it('processes each backend independently — one failure does not abort the sweep', async () => {
    const good = backend({ id: 'good', lastBusyAt: secondsAgo(1801) });
    const bad = backend({ id: 'bad', lastBusyAt: secondsAgo(1801) });
    const { deps } = harness({ backends: [bad, good] });
    deps.stopBackend = async (b) => {
      if (b.id === 'bad') throw new Error('boom');
      return { ok: true };
    };
    const r = await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });

    expect(r.scanned).toBe(2);
    expect(r.stopped).toEqual(['good']);
    expect(r.failures).toEqual([{ id: 'bad', error: 'boom' }]);
  });

  /** CONTROL — the naive reaper this module's whole shape exists to forbid, kept permanently so
   *  the "inside its TTL" assertions above are known to have teeth. It stops on any idle
   *  observation, which is the obvious implementation and is wrong; it must reap a backend that
   *  went idle one second ago. If this ever stops reaping, those assertions test nothing. */
  it('control: a single-sample reaper stops a backend the real one leaves alone', async () => {
    const naiveStop = vi.fn(async () => ({ ok: true }));
    const fresh = backend({ lastBusyAt: secondsAgo(1) });
    for (const b of [fresh]) {
      const observation: BusyObservation = { state: 'idle' };
      if (observation.state === 'idle') await naiveStop();
    }
    expect(naiveStop).toHaveBeenCalledTimes(1);

    // The real implementation, same input, same observation:
    const { deps, stopBackend } = harness({ backends: [fresh] });
    await runIdleBackendReap(deps, { defaultIdleTtlSec: 900 });
    expect(stopBackend).not.toHaveBeenCalled();
  });
});

describe('probeLlamaServerSlots', () => {
  const ok = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('reads a processing slot as busy', async () => {
    const o = await probeLlamaServerSlots('http://x', { fetchImpl: ok([{ is_processing: false }, { is_processing: true }]) });
    expect(o).toEqual({ state: 'busy' });
  });

  it('reads all-quiet slots as idle', async () => {
    const o = await probeLlamaServerSlots('http://x', {
      fetchImpl: ok([{ is_processing: false }, { is_processing: false }, { is_processing: false }]),
    });
    expect(o).toEqual({ state: 'idle' });
  });

  it('reads a refused connection as down, not as idle', async () => {
    const o = await probeLlamaServerSlots('http://x', {
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(o).toEqual({ state: 'down' });
  });

  it('reads a 501 (slots endpoint disabled) as unreadable, not as idle', async () => {
    const o = await probeLlamaServerSlots('http://x', {
      fetchImpl: (async () => new Response('', { status: 501 })) as unknown as typeof fetch,
    });
    expect(o).toMatchObject({ state: 'unreadable' });
    expect((o as { detail: string }).detail).toMatch(/501/);
  });

  it('reads a non-array body as unreadable, not as idle', async () => {
    const o = await probeLlamaServerSlots('http://x', { fetchImpl: ok({ error: 'nope' }) });
    expect(o).toMatchObject({ state: 'unreadable' });
  });

  it('probes the registry baseUrl (the routed path), not a guessed unit port', async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(String(url));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await probeLlamaServerSlots('http://127.0.0.1:11435', { fetchImpl: spy });
    expect(seen).toEqual(['http://127.0.0.1:11435/slots']);
  });
});
