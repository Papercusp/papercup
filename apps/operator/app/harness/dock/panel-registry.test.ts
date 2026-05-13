import { describe, expect, it, beforeEach, vi } from 'vitest';
import { panelRegistry } from './panel-registry';

const Stub = () => null;

describe('panelRegistry', () => {
  beforeEach(() => panelRegistry._reset());

  it('register/get round-trip', () => {
    panelRegistry.register('data:features', Stub);
    expect(panelRegistry.has('data:features')).toBe(true);
    expect(panelRegistry.get('data:features')?.component).toBe(Stub);
  });

  it('register replaces existing entry and notifies', () => {
    const listener = vi.fn();
    panelRegistry.subscribe(listener);
    panelRegistry.register('x', Stub);
    panelRegistry.register('x', Stub, { title: 'replaced' });
    expect(panelRegistry.get('x')?.meta.title).toBe('replaced');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unregister returns true when removed, false when absent', () => {
    panelRegistry.register('a', Stub);
    expect(panelRegistry.unregister('a')).toBe(true);
    expect(panelRegistry.unregister('a')).toBe(false);
    expect(panelRegistry.has('a')).toBe(false);
  });

  it('unregister notifies subscribers', () => {
    const listener = vi.fn();
    panelRegistry.register('a', Stub);
    panelRegistry.subscribe(listener);
    panelRegistry.unregister('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const unsub = panelRegistry.subscribe(listener);
    unsub();
    panelRegistry.register('a', Stub);
    expect(listener).not.toHaveBeenCalled();
  });

  it('list returns sorted snapshot', () => {
    panelRegistry.register('b', Stub);
    panelRegistry.register('a', Stub);
    panelRegistry.register('c', Stub);
    expect(panelRegistry.list()).toEqual(['a', 'b', 'c']);
  });

  it('throwing listener does not break others', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    panelRegistry.subscribe(bad);
    panelRegistry.subscribe(good);
    panelRegistry.register('a', Stub);
    expect(good).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('metadata persists with the entry', () => {
    panelRegistry.register('x', Stub, {
      title: 'X',
      keepAlive: true,
      defaultGroup: 'main',
    });
    const e = panelRegistry.get('x');
    expect(e?.meta).toEqual({ title: 'X', keepAlive: true, defaultGroup: 'main' });
  });
});
