/**
 * Lifecycle isolation tests (Batch C2, Rust-port-feedback item 5).
 *
 * One bad handler in a hook chain must not abort the rest. The host
 * already wraps each handler in try/catch; these tests pin that down.
 */

import { describe, it, expect } from 'vitest';
import { HookBus } from './hookbus';

describe('HookBus.runAction — handler isolation', () => {
  it('one throwing handler does not abort the chain', async () => {
    const bus = new HookBus();
    const log: string[] = [];
    bus.registerAction('event', 'pluginA', () => { log.push('A'); });
    bus.registerAction('event', 'pluginB', () => { throw new Error('boom from B'); });
    bus.registerAction('event', 'pluginC', () => { log.push('C'); });
    let logged = '';
    await bus.runAction('event', {}, (m) => { logged = m; });
    expect(log).toEqual(['A', 'C']);
    expect(logged).toMatch(/pluginB.*threw/);
  });

  it('async handler rejection is caught per-handler', async () => {
    const bus = new HookBus();
    const log: string[] = [];
    bus.registerAction('event', 'pluginA', async () => { log.push('A'); });
    bus.registerAction('event', 'pluginB', async () => { throw new Error('async boom'); });
    bus.registerAction('event', 'pluginC', async () => { log.push('C'); });
    await bus.runAction('event', {});
    expect(log).toEqual(['A', 'C']);
  });

  it('unregisterPlugin removes handlers across all events for that plugin', () => {
    const bus = new HookBus();
    bus.registerAction('eventX', 'pluginA', () => {});
    bus.registerAction('eventY', 'pluginA', () => {});
    bus.registerAction('eventX', 'pluginB', () => {});
    bus.unregisterPlugin('pluginA');
    const events = bus.inspect();
    const aPresent = events.some((e) => e.plugins.includes('pluginA'));
    expect(aPresent).toBe(false);
    const bPresent = events.some((e) => e.plugins.includes('pluginB'));
    expect(bPresent).toBe(true);
  });
});
