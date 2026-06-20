// learning-infra-health — the composite "learning system offline/degraded"
// status (self-improvement-consume-edges-2026-06-12 P-003 / D-002). Pins the
// pure composite rule (the llm-spine is the spine; two non-spine legs down =
// offline; unknown fails toward ok), the transition detector (alert on the
// →offline edge incl. first-seen, recover on the offline→ edge only), the
// tick's notify-exactly-once-per-transition semantics via the injected seams,
// and the llm-spine leg's transport-probe mapping (credential presence, NOT a
// :3456 TCP probe — the retired meridian router not running is the healthy state on this box).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatelessTransportProbe } from '@papercusp/papercup-shared/agent';
import {
  checkLlmSpineLeg,
  composeLearningHealth,
  diffLearningHealth,
  lastLearningInfraHealth,
  probeGatewayHealthz,
  runLearningInfraHealthTick,
  _resetLearningInfraHealthState,
  type InfraLeg,
  type LearningInfraHealth,
} from './learning-infra-health';

const leg = (name: InfraLeg['name'], status: InfraLeg['status'], detail = `${name} ${status}`): InfraLeg => ({
  name,
  status,
  detail,
});

const ALL_OK: InfraLeg[] = [leg('llm-spine', 'ok'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

describe('composeLearningHealth', () => {
  it('all legs up → ok', () => {
    const h = composeLearningHealth(ALL_OK, 1000);
    expect(h.status).toBe('ok');
    expect(h.reason).toBe('all legs up');
    expect(h.evaluatedAt).toBe(1000);
  });

  it('llm-spine down alone → OFFLINE (the LLM spine)', () => {
    const h = composeLearningHealth(
      [leg('llm-spine', 'down', 'no live Claude session or omp token'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')],
      0,
    );
    expect(h.status).toBe('offline');
    expect(h.reason).toContain('llm-spine: no live Claude session or omp token');
  });

  it('one non-spine leg down → degraded', () => {
    expect(composeLearningHealth([leg('llm-spine', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'ok')], 0).status).toBe('degraded');
    expect(composeLearningHealth([leg('llm-spine', 'ok'), leg('spawn-path', 'ok'), leg('gym-circuit', 'down')], 0).status).toBe('degraded');
  });

  it('both non-spine legs down → OFFLINE (cannot dispatch workers nor run the gym)', () => {
    const h = composeLearningHealth(
      [leg('llm-spine', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'down')],
      0,
    );
    expect(h.status).toBe('offline');
    expect(h.reason).toContain('spawn-path');
    expect(h.reason).toContain('gym-circuit');
  });

  it("a leg whose own check failed ('unknown') counts toward ok — no fabricated outage", () => {
    const h = composeLearningHealth(
      [leg('llm-spine', 'unknown', 'leg check failed: pg down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')],
      0,
    );
    expect(h.status).toBe('ok');
    expect(h.reason).toContain('llm-spine unknown');
  });

  it('unknown legs never dilute a real outage', () => {
    const h = composeLearningHealth(
      [leg('llm-spine', 'down'), leg('spawn-path', 'unknown'), leg('gym-circuit', 'unknown')],
      0,
    );
    expect(h.status).toBe('offline');
  });
});

describe('diffLearningHealth', () => {
  it('alerts on every →offline edge, including first-seen', () => {
    expect(diffLearningHealth(null, 'offline')).toBe('offline');
    expect(diffLearningHealth('ok', 'offline')).toBe('offline');
    expect(diffLearningHealth('degraded', 'offline')).toBe('offline');
  });

  it('a persisting offline does not re-alert', () => {
    expect(diffLearningHealth('offline', 'offline')).toBeNull();
  });

  it('recovers only on the offline→ edge', () => {
    expect(diffLearningHealth('offline', 'ok')).toBe('recovered');
    expect(diffLearningHealth('offline', 'degraded')).toBe('recovered');
    expect(diffLearningHealth('degraded', 'ok')).toBeNull();
    expect(diffLearningHealth('ok', 'degraded')).toBeNull();
    expect(diffLearningHealth(null, 'ok')).toBeNull();
    expect(diffLearningHealth(null, 'degraded')).toBeNull();
  });
});

describe('runLearningInfraHealthTick', () => {
  beforeEach(() => _resetLearningInfraHealthState());
  afterEach(() => _resetLearningInfraHealthState());

  const tick = (legs: InfraLeg[], notify: ReturnType<typeof vi.fn>, invalidate: ReturnType<typeof vi.fn>) =>
    runLearningInfraHealthTick({
      legs: async () => legs,
      notify: notify as unknown as (t: 'offline' | 'recovered', h: LearningInfraHealth) => Promise<void>,
      invalidate: invalidate as unknown as () => Promise<void>,
      now: () => 42,
    });

  it('notifies exactly once per offline transition, then once on recovery', async () => {
    const notify = vi.fn(async () => {});
    const invalidate = vi.fn(async () => {});
    const down = [leg('llm-spine', 'down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

    const first = await tick(down, notify, invalidate);
    expect(first.transition).toBe('offline');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('offline', expect.objectContaining({ status: 'offline' }));

    const second = await tick(down, notify, invalidate);
    expect(second.transition).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1); // persisting offline: no re-alert

    const third = await tick(ALL_OK, notify, invalidate);
    expect(third.transition).toBe('recovered');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('recovered', expect.objectContaining({ status: 'ok' }));
  });

  it('invalidates the sync query on every status change (incl. the first evaluation), not on steady state', async () => {
    const notify = vi.fn(async () => {});
    const invalidate = vi.fn(async () => {});

    await tick(ALL_OK, notify, invalidate); // null → ok: a change
    expect(invalidate).toHaveBeenCalledTimes(1);
    await tick(ALL_OK, notify, invalidate); // ok → ok: steady
    expect(invalidate).toHaveBeenCalledTimes(1);
    await tick([leg('llm-spine', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'ok')], notify, invalidate);
    expect(invalidate).toHaveBeenCalledTimes(2); // ok → degraded
    expect(notify).not.toHaveBeenCalled(); // degraded is chip-only
  });

  it('caches the snapshot for readers and survives a notify failure', async () => {
    const notify = vi.fn(async () => {
      throw new Error('toast write failed');
    });
    const invalidate = vi.fn(async () => {});
    const down = [leg('llm-spine', 'down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

    const { health } = await tick(down, notify, invalidate);
    expect(health.status).toBe('offline');
    expect(lastLearningInfraHealth()).toEqual(health);
    expect(lastLearningInfraHealth()?.evaluatedAt).toBe(42);
  });
});

describe('checkLlmSpineLeg', () => {
  const okProbe = (): StatelessTransportProbe => ({ ok: true, label: 'anthropic-direct' });
  const downProbe = (): StatelessTransportProbe => ({ ok: false, error: 'stateless LLM path needs a live Claude session …' });
  const gwOff = async () => false;
  const gwOn = async () => true;

  it('credential present + gateway OFF → ok with the transport label (direct egress, unchanged)', async () => {
    const probed = await checkLlmSpineLeg({ probe: okProbe, gatewayEnabled: gwOff });
    expect(probed).toEqual({ name: 'llm-spine', status: 'ok', detail: 'stateless transport: anthropic-direct' });
  });

  it('no usable credential → down, carrying the resolver error; the gateway is never consulted', async () => {
    const gatewayReachable = vi.fn(async () => ({ reachable: true, detail: 'HTTP 200' }));
    const probed = await checkLlmSpineLeg({ probe: downProbe, gatewayEnabled: gwOn, gatewayReachable });
    expect(probed.status).toBe('down');
    expect(probed.detail).toContain('live Claude session');
    expect(gatewayReachable).not.toHaveBeenCalled(); // the credential gate short-circuits first
  });

  it('credential present + gateway ON + /healthz answers → ok, evidence names the gateway', async () => {
    const probed = await checkLlmSpineLeg({
      probe: okProbe,
      gatewayEnabled: gwOn,
      gatewayPort: () => 8788,
      gatewayReachable: async () => ({ reachable: true, detail: 'HTTP 200' }),
    });
    expect(probed.status).toBe('ok');
    expect(probed.detail).toContain('via inference-gateway :8788');
    expect(probed.detail).toContain('HTTP 200');
  });

  it('a 503 rate-limit PAUSE is still reachable (gateway alive, pacing) → ok, not a fabricated outage', async () => {
    const probed = await checkLlmSpineLeg({
      probe: okProbe,
      gatewayEnabled: gwOn,
      gatewayPort: () => 8788,
      gatewayReachable: async () => ({ reachable: true, detail: 'HTTP 503' }),
    });
    expect(probed.status).toBe('ok');
    expect(probed.detail).toContain('HTTP 503');
  });

  it('credential present + gateway ON but /healthz unreachable → DOWN (the false-"ok" gap closed)', async () => {
    const probed = await checkLlmSpineLeg({
      probe: okProbe,
      gatewayEnabled: gwOn,
      gatewayPort: () => 8788,
      gatewayReachable: async () => ({ reachable: false, detail: 'ECONNREFUSED' }),
    });
    expect(probed.status).toBe('down');
    expect(probed.detail).toContain('inference-gateway :8788 unreachable');
    expect(probed.detail).toContain('ECONNREFUSED');
    expect(probed.detail).toContain('despite a present anthropic-direct credential');
  });

  it('the real credential probe returns a well-formed leg whatever this box holds (never a :3456 read; gateway pinned off for hermeticity)', async () => {
    // Real credential resolution via papercup-shared; the gateway dimension is
    // pinned OFF so this stays box-independent and does no network IO.
    const probed = await checkLlmSpineLeg({ gatewayEnabled: async () => false });
    expect(probed.name).toBe('llm-spine');
    expect(['ok', 'down']).toContain(probed.status);
    expect(probed.detail.length).toBeGreaterThan(0);
    expect(probed.detail).not.toContain('3456');
  });
});

describe('probeGatewayHealthz retry (EI-1693 — one transient timeout is not "down")', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const timeoutErr = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

  it('returns reachable on the first answer, no retry', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeGatewayHealthz(8788, { timeouts: [5, 5], gapMs: 0 });
    expect(r.reachable).toBe(true);
    expect(r.detail).toBe('HTTP 200');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a transient timeout THEN a success → reachable (the verified false-OFFLINE under load)', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      if (n++ === 0) throw timeoutErr();
      return { status: 503 } as Response; // 503 = alive+pacing, still reachable
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeGatewayHealthz(8788, { timeouts: [5, 50], gapMs: 0 });
    expect(r.reachable).toBe(true);
    expect(r.detail).toContain('after 1 retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('all escalating attempts fail → unreachable (a real outage still surfaces)', async () => {
    const fetchMock = vi.fn(async () => {
      throw timeoutErr();
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await probeGatewayHealthz(8788, { timeouts: [5, 5], gapMs: 0 });
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/attempts, escalating/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
