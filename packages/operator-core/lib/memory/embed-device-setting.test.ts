/**
 * embed-device-setting — how a process applies the Settings choice of
 * embedding device (plan memory-reduction-2026-09-24 D-008, WI-10002872).
 *
 * The row read and the worker recycle are injected, so these run without PG
 * or a model: what is pinned is the POLICY — a change recycles, a no-op does
 * not, a read failure keeps the current choice, and the first-embed load
 * happens once per process.
 */
import { _resetEmbedDeviceState, embedDeviceSetting, type EmbedDevicePreference } from '@papercusp/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetEmbedDeviceSettingLoadForTests,
  ensureEmbedDeviceSettingLoaded,
  loadEmbedDeviceSetting,
} from './embed-device-setting';

const ENV = 'PAPERCUSP_EMBED_DEVICE';

function deps(read: () => Promise<EmbedDevicePreference | null>) {
  return { read: vi.fn(read), recycle: vi.fn(async () => {}) };
}

describe('loadEmbedDeviceSetting', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[ENV];
    delete process.env[ENV];
    _resetEmbedDeviceState();
    _resetEmbedDeviceSettingLoadForTests();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    _resetEmbedDeviceState();
    _resetEmbedDeviceSettingLoadForTests();
  });

  it('applies a stored choice and recycles the worker when the effective device moves', async () => {
    const d = deps(async () => 'cpu');
    await expect(loadEmbedDeviceSetting(d)).resolves.toEqual({ setting: 'cpu', changed: true, readError: null });
    expect(embedDeviceSetting()).toBe('cpu');
    expect(d.recycle).toHaveBeenCalledTimes(1);
  });

  it('does not recycle when nothing effective changed', async () => {
    await loadEmbedDeviceSetting(deps(async () => 'cpu'));
    const again = deps(async () => 'cpu');
    await expect(loadEmbedDeviceSetting(again)).resolves.toMatchObject({ changed: false });
    expect(again.recycle).not.toHaveBeenCalled();
  });

  it('a concrete host override makes a setting change a no-op for this process (no recycle)', async () => {
    process.env[ENV] = 'cpu';
    const d = deps(async () => 'cuda');
    await expect(loadEmbedDeviceSetting(d)).resolves.toMatchObject({ setting: 'cuda', changed: false });
    expect(d.recycle).not.toHaveBeenCalled();
  });

  it('a read failure keeps the choice already held and says why — never throws into the embed path', async () => {
    await loadEmbedDeviceSetting(deps(async () => 'cpu'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const broken = deps(async () => {
      throw new Error('relation "harness_shared.operator_embed_device" does not exist');
    });
    const r = await loadEmbedDeviceSetting(broken);
    expect(r).toMatchObject({ setting: 'cpu', changed: false });
    expect(r.readError).toContain('does not exist');
    expect(embedDeviceSetting()).toBe('cpu');
    expect(broken.recycle).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('a hung read is bounded, not awaited forever', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await loadEmbedDeviceSetting(deps(() => new Promise(() => {})), 20);
    expect(r.readError).toMatch(/timed out after 20ms/);
    log.mockRestore();
  });

  it('ensureEmbedDeviceSettingLoaded reads once per process', async () => {
    const d = deps(async () => 'cpu');
    await ensureEmbedDeviceSettingLoaded(d);
    await ensureEmbedDeviceSettingLoaded(d);
    expect(d.read).toHaveBeenCalledTimes(1);
  });
});
