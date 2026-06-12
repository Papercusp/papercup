// learning-infra-health — the composite "learning system offline/degraded"
// status (self-improvement-consume-edges-2026-06-12 P-003 / D-002). Pins the
// pure composite rule (meridian is the spine; two non-spine legs down =
// offline; unknown fails toward ok), the transition detector (alert on the
// →offline edge incl. first-seen, recover on the offline→ edge only), and the
// tick's notify-exactly-once-per-transition semantics via the injected seams.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeLearningHealth,
  diffLearningHealth,
  lastLearningInfraHealth,
  meridianBaseUrl,
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

const ALL_OK: InfraLeg[] = [leg('meridian', 'ok'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

describe('composeLearningHealth', () => {
  it('all legs up → ok', () => {
    const h = composeLearningHealth(ALL_OK, 1000);
    expect(h.status).toBe('ok');
    expect(h.reason).toBe('all legs up');
    expect(h.evaluatedAt).toBe(1000);
  });

  it('meridian down alone → OFFLINE (the LLM spine)', () => {
    const h = composeLearningHealth(
      [leg('meridian', 'down', '127.0.0.1:3456 ECONNREFUSED'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')],
      0,
    );
    expect(h.status).toBe('offline');
    expect(h.reason).toContain('meridian: 127.0.0.1:3456 ECONNREFUSED');
  });

  it('one non-spine leg down → degraded', () => {
    expect(composeLearningHealth([leg('meridian', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'ok')], 0).status).toBe('degraded');
    expect(composeLearningHealth([leg('meridian', 'ok'), leg('spawn-path', 'ok'), leg('gym-circuit', 'down')], 0).status).toBe('degraded');
  });

  it('both non-spine legs down → OFFLINE (cannot dispatch workers nor run the gym)', () => {
    const h = composeLearningHealth(
      [leg('meridian', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'down')],
      0,
    );
    expect(h.status).toBe('offline');
    expect(h.reason).toContain('spawn-path');
    expect(h.reason).toContain('gym-circuit');
  });

  it("a leg whose own check failed ('unknown') counts toward ok — no fabricated outage", () => {
    const h = composeLearningHealth(
      [leg('meridian', 'unknown', 'leg check failed: pg down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')],
      0,
    );
    expect(h.status).toBe('ok');
    expect(h.reason).toContain('meridian unknown');
  });

  it('unknown legs never dilute a real outage', () => {
    const h = composeLearningHealth(
      [leg('meridian', 'down'), leg('spawn-path', 'unknown'), leg('gym-circuit', 'unknown')],
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
    const down = [leg('meridian', 'down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

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
    await tick([leg('meridian', 'ok'), leg('spawn-path', 'down'), leg('gym-circuit', 'ok')], notify, invalidate);
    expect(invalidate).toHaveBeenCalledTimes(2); // ok → degraded
    expect(notify).not.toHaveBeenCalled(); // degraded is chip-only
  });

  it('caches the snapshot for readers and survives a notify failure', async () => {
    const notify = vi.fn(async () => {
      throw new Error('toast write failed');
    });
    const invalidate = vi.fn(async () => {});
    const down = [leg('meridian', 'down'), leg('spawn-path', 'ok'), leg('gym-circuit', 'ok')];

    const { health } = await tick(down, notify, invalidate);
    expect(health.status).toBe('offline');
    expect(lastLearningInfraHealth()).toEqual(health);
    expect(lastLearningInfraHealth()?.evaluatedAt).toBe(42);
  });
});

describe('meridianBaseUrl', () => {
  const saved = { primary: process.env.PAPERCUSP_MERIDIAN_URL, fallback: process.env.MERIDIAN_BASE_URL };
  afterEach(() => {
    if (saved.primary === undefined) delete process.env.PAPERCUSP_MERIDIAN_URL;
    else process.env.PAPERCUSP_MERIDIAN_URL = saved.primary;
    if (saved.fallback === undefined) delete process.env.MERIDIAN_BASE_URL;
    else process.env.MERIDIAN_BASE_URL = saved.fallback;
  });

  it('resolves PAPERCUSP_MERIDIAN_URL → MERIDIAN_BASE_URL → the :3456 default (transport order)', () => {
    delete process.env.PAPERCUSP_MERIDIAN_URL;
    delete process.env.MERIDIAN_BASE_URL;
    expect(meridianBaseUrl()).toBe('http://127.0.0.1:3456');
    process.env.MERIDIAN_BASE_URL = 'http://127.0.0.1:3458';
    expect(meridianBaseUrl()).toBe('http://127.0.0.1:3458');
    process.env.PAPERCUSP_MERIDIAN_URL = 'http://127.0.0.1:9999';
    expect(meridianBaseUrl()).toBe('http://127.0.0.1:9999');
  });
});
