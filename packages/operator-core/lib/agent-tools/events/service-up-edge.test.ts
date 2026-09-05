import { describe, expect, it, vi } from 'vitest';

import { DOWN_CONFIRM_TICKS, type ProbeResult } from '../../service-health';
import {
  buildServiceUpEdgeAdvice,
  isFlapDamped,
  parseServiceUpKey,
  probeServiceUpLatch,
  SERVICE_UP_KEY_PREFIX,
} from './service-up-edge';

/** A healthy probe result, the shape `probeNamedService` returns. */
function healthy(name: string, over: Partial<ProbeResult> = {}): ProbeResult {
  return { name, up: true, status: 200, latencyMs: 5, ...over };
}

describe('parseServiceUpKey', () => {
  it('extracts the service name from a literal service-up key', () => {
    expect(parseServiceUpKey('service:up:inference-gateway')).toBe('inference-gateway');
    expect(parseServiceUpKey('service:up:staging-api')).toBe('staging-api');
  });

  it('rejects a glob — a pattern await is a wake-on-ANY subscription, so "is THIS service healthy" is not askable', () => {
    expect(parseServiceUpKey('service:up:*')).toBeNull();
    expect(parseServiceUpKey('service:up:infer*')).toBeNull();
  });

  it('rejects the bare family prefix and non-service-up keys', () => {
    expect(parseServiceUpKey(SERVICE_UP_KEY_PREFIX)).toBeNull();
    expect(parseServiceUpKey('service:down:inference-gateway')).toBeNull();
    expect(parseServiceUpKey('work-item:done:WI-1')).toBeNull();
    expect(parseServiceUpKey('')).toBeNull();
  });
});

describe('isFlapDamped', () => {
  // Pins the REAL map rather than a fixture: damping is what makes a short
  // restart structurally unable to produce the edge, so the advisory's sharper
  // wording must track the actual DOWN_CONFIRM_TICKS membership.
  it('reports the real damping membership', () => {
    expect(isFlapDamped('staging-api')).toBe(true);
    expect(isFlapDamped('desktop')).toBe(true);
    // The service from the incident is NOT damped — its restart was missed by
    // plain tick sampling, which is why the undamped wording must still warn.
    expect(isFlapDamped('inference-gateway')).toBe(false);
    expect(isFlapDamped('no-such-service')).toBe(false);
  });

  it('agrees with the exported map for every damped name', () => {
    for (const name of Object.keys(DOWN_CONFIRM_TICKS)) {
      expect(isFlapDamped(name)).toBe(true);
    }
  });
});

describe('probeServiceUpLatch', () => {
  it('returns the result when the service is affirmatively healthy', async () => {
    const probe = vi.fn(async (name: string) => healthy(name));
    await expect(probeServiceUpLatch('inference-gateway', { probe })).resolves.toMatchObject({
      name: 'inference-gateway',
      up: true,
    });
  });

  it('returns null when the service is down', async () => {
    const probe = vi.fn(async (name: string) => healthy(name, { up: false }));
    await expect(probeServiceUpLatch('inference-gateway', { probe })).resolves.toBeNull();
  });

  it('returns null for a legitimately ABSENT service (present:false)', async () => {
    const probe = vi.fn(async (name: string) => healthy(name, { present: false }));
    await expect(probeServiceUpLatch('desktop', { probe })).resolves.toBeNull();
  });

  it('returns null when the probe reports nothing', async () => {
    const probe = vi.fn(async () => null);
    await expect(probeServiceUpLatch('inference-gateway', { probe })).resolves.toBeNull();
  });

  // THE load-bearing case. Every caller treats a non-null return as something
  // STRONGER than a wait ("you are already there"), so an unreadable probe must
  // land on the side that PRESERVES the wait. A throwing probe that leaked would
  // break await registration outright.
  it('FAILS OPEN when the probe throws — never manufactures an all-clear, never propagates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const probe = vi.fn(async () => {
        throw new Error('health read unavailable');
      });
      await expect(probeServiceUpLatch('inference-gateway', { probe })).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('buildServiceUpEdgeAdvice', () => {
  it('names the service, states the edge semantics, and refuses the restart reading', () => {
    const advice = buildServiceUpEdgeAdvice('inference-gateway', { damped: false });
    expect(advice).toContain('inference-gateway');
    expect(advice).toContain('TRANSITION');
    expect(advice).toContain('CANNOT confirm a restart');
    // Must route to the surface that handles already-healthy correctly.
    expect(advice).toContain('service:await-up');
    // Must say it did not refuse — this is an advisory, and an agent that reads
    // it as a refusal would cancel a legitimate standing wait.
    expect(advice).toContain('Registered anyway');
  });

  it('adds the structural damping clause only for a damped service', () => {
    const damped = buildServiceUpEdgeAdvice('staging-api', { damped: true });
    const plain = buildServiceUpEdgeAdvice('inference-gateway', { damped: false });
    expect(damped).toContain('flap-damped');
    expect(plain).not.toContain('flap-damped');
  });
});

describe('the two surfaces cannot drift apart (permanent control)', () => {
  // EI-20268841604319803 was NOT a wrong predicate — `service:await-up` had the
  // right one all along. It was the same rule living privately in one caller
  // while the raw events:await path had none, so the surfaces disagreed and the
  // unprotected one's silence looked like safety. Copying the condition into the
  // second caller would make them agree today and drift tomorrow; sharing this
  // predicate is what makes a future divergence a test failure instead of
  // another six-hour dead await.
  //
  // The control below is a deliberately-wrong reimplementation — the exact
  // plausible mistake, forgetting `present` — kept permanently so this file
  // proves it CAN fail rather than merely passing.
  function wrongLatch(result: ProbeResult | null): ProbeResult | null {
    return result && result.up ? result : null; // ignores present:false
  }

  it('the real predicate rejects an absent-but-"up" service where the naive one accepts it', async () => {
    const absent = healthy('desktop', { present: false });
    // Calibration: the control is not vacuous — it accepts this input.
    expect(wrongLatch(absent)).not.toBeNull();
    // The real predicate must disagree.
    await expect(
      probeServiceUpLatch('desktop', { probe: async () => absent }),
    ).resolves.toBeNull();
  });

  it('both agree on the ordinary healthy case (calibration)', async () => {
    const up = healthy('inference-gateway');
    expect(wrongLatch(up)).not.toBeNull();
    await expect(
      probeServiceUpLatch('inference-gateway', { probe: async () => up }),
    ).resolves.not.toBeNull();
  });
});
