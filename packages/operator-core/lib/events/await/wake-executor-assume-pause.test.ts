import { describe, expect, it, vi } from 'vitest';
import { makeDelivery } from '../../../test/_multi-session-testbed';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';

describe('managed takeover caller wake fence', () => {
  it.each(['loop:caller', 'owner-gui:resume', 'coord:inbox-wake:caller'])(
    'retains %s before any manual-mode bypass or execution effect', async eventKey => {
      const effects = vi.fn();
      const deps: ExecuteWakeDeps = {
        getSessionLifecycle: async () => ({ assumeCaller: { transitionKey: 'fixture' } }),
        resolveWakeModeFn: effects, findPsuHost: effects, spawnManagedPty: effects, injectPsuHost: effects,
      };
      expect(await executeWake(makeDelivery({ subscriberId: 'caller', eventKey }), deps))
        .toMatchObject({ kind: 'park', reason: expect.stringContaining('paused') });
      expect(effects).not.toHaveBeenCalled();
    },
  );

  it.each([null, false, 'corrupt'])( 'fails closed on malformed pause marker %s', async assumeCaller => {
    expect(await executeWake(makeDelivery({ subscriberId: 'caller' }), {
      getSessionLifecycle: async () => ({ assumeCaller }),
    })).toMatchObject({ kind: 'park' });
  });

  it('retains the delivery when lifecycle custody cannot be read', async () => {
    const effect = vi.fn();
    expect(await executeWake(makeDelivery({ subscriberId: 'caller' }), {
      getSessionLifecycle: async () => { throw new Error('storage unavailable'); }, findPsuHost: effect,
    })).toMatchObject({ kind: 'park', reason: expect.stringContaining('unknown') });
    expect(effect).not.toHaveBeenCalled();
  });
});
