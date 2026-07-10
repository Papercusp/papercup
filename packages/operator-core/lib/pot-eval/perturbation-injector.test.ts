import { describe, it, expect, vi } from 'vitest';
import {
  parsePerturbationAction,
  injectPerturbation,
  noopPerturbationInjector,
  type PerturbationInjectors,
} from './perturbation-injector';
import { DISCRIMINATOR_SCENARIOS, getDiscriminator } from './discriminator-scenarios';

describe('parsePerturbationAction', () => {
  it('parses bare + arg actions', () => {
    expect(parsePerturbationAction('kill-queen')).toEqual({ kind: 'kill-queen' });
    expect(parsePerturbationAction('rewrite-spec')).toEqual({ kind: 'rewrite-spec' });
    expect(parsePerturbationAction('spread-swarms:3')).toEqual({ kind: 'spread-swarms', arg: '3' });
  });

  it('marks an unknown action', () => {
    expect(parsePerturbationAction('frobnicate')).toEqual({ kind: 'unknown' });
  });
});

describe('noopPerturbationInjector', () => {
  it('does nothing (applied:false)', async () => {
    const out = await noopPerturbationInjector({ scenario: {} as never, action: 'kill-queen', kind: 'kill-queen' });
    expect(out.applied).toBe(false);
  });
});

describe('injectPerturbation', () => {
  it('routes each discriminator scenario to its kind injector', async () => {
    const calls: string[] = [];
    const injectors: PerturbationInjectors = {
      'kill-queen': async (ctx) => {
        calls.push(`kq:${ctx.action}`);
        return { applied: true, action: ctx.action, note: 'killed' };
      },
      'rewrite-spec': async (ctx) => {
        calls.push(`rw:${ctx.action}`);
        return { applied: true, action: ctx.action, note: 'rewrote' };
      },
      'spread-swarms': async (ctx) => {
        calls.push(`ss:${ctx.action}:${ctx.arg}`);
        return { applied: true, action: ctx.action, note: 'spread' };
      },
    };
    for (const d of DISCRIMINATOR_SCENARIOS) {
      const out = await injectPerturbation(d, injectors);
      expect(out.applied).toBe(true);
    }
    expect(calls.sort()).toEqual(['kq:kill-queen', 'rw:rewrite-spec', 'ss:spread-swarms:3:3']);
  });

  it('safe no-op when the kind is unbound', async () => {
    const out = await injectPerturbation(getDiscriminator('crash-recovery')!, {});
    expect(out.applied).toBe(false);
    expect(out.note).toContain('no injector bound');
  });

  it('safe no-op on an unknown action (never throws)', async () => {
    const bogus = { perturbation: { action: 'frobnicate', atProgress: 0, description: '' } } as never;
    const spy = vi.fn();
    const out = await injectPerturbation(bogus, { 'kill-queen': spy });
    expect(spy).not.toHaveBeenCalled();
    expect(out.applied).toBe(false);
    expect(out.note).toContain('unknown');
  });
});
