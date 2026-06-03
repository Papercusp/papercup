import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerCloseGuard,
  canClosePanel,
  hasCloseGuard,
  configureCloseGuard,
  _resetCloseGuardsForTests,
} from './close-guard';

beforeEach(() => _resetCloseGuardsForTests());

describe('close-guard', () => {
  it('allows close when no guard is registered', async () => {
    expect(await canClosePanel('p1')).toBe(true);
    expect(hasCloseGuard('p1')).toBe(false);
  });

  it('allows close immediately when the guard reports safe (not dirty)', async () => {
    const confirm = vi.fn();
    configureCloseGuard({ confirm });
    registerCloseGuard('p1', () => true);
    expect(await canClosePanel('p1')).toBe(true);
    expect(confirm).not.toHaveBeenCalled(); // never prompted
  });

  it('prompts when the guard reports not-safe (dirty); honors the answer', async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    configureCloseGuard({ confirm });
    registerCloseGuard('p1', () => false);
    expect(await canClosePanel('p1')).toBe(false);
    expect(confirm).toHaveBeenCalledWith('p1');

    confirm.mockResolvedValue(true);
    expect(await canClosePanel('p1')).toBe(true);
  });

  it('supports async guards', async () => {
    configureCloseGuard({ confirm: () => false });
    registerCloseGuard('p1', async () => false);
    expect(await canClosePanel('p1')).toBe(false);
  });

  it('treats a throwing guard as safe (never traps the user)', async () => {
    registerCloseGuard('p1', () => {
      throw new Error('boom');
    });
    expect(await canClosePanel('p1')).toBe(true);
  });

  it('unregister removes only its own registration', async () => {
    configureCloseGuard({ confirm: () => false });
    const off = registerCloseGuard('p1', () => false);
    expect(await canClosePanel('p1')).toBe(false);
    off();
    expect(hasCloseGuard('p1')).toBe(false);
    expect(await canClosePanel('p1')).toBe(true);

    // a stale unsubscribe must not delete a newer registration
    const off1 = registerCloseGuard('p2', () => false);
    registerCloseGuard('p2', () => true);
    off1();
    expect(hasCloseGuard('p2')).toBe(true);
    expect(await canClosePanel('p2')).toBe(true);
  });
});
