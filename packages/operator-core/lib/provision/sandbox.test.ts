/**
 * sandbox-builder smoke tests — primarily exercises the env-var escape
 * hatch and the shape of the build result. The actual sandboxer
 * invocation is OS-specific and tested at the runner-integration level.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSandbox, _resetSmokeCacheForTests } from './sandbox';

beforeEach(() => {
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  _resetSmokeCacheForTests();
});
afterEach(() => {
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  delete process.env.PAPERCUSP_ALLOW_NO_SANDBOX;
});

describe('buildSandbox', () => {
  it('returns inactive driver when explicitly disabled', () => {
    const r = buildSandbox({
      pluginDir: '/tmp/p',
      scratchDir: '/tmp/s',
      allowedHosts: [],
      env: { FOO: 'bar' },
    });
    expect(r.active).toBe(false);
    expect(r.driver).toBe('none');
    expect(r.argv).toEqual([]);
    expect(r.env.FOO).toBe('bar');
  });

  it('passes env through unchanged on the inactive path', () => {
    const r = buildSandbox({
      pluginDir: '/p',
      scratchDir: '/s',
      allowedHosts: [],
      env: { A: '1', B: '2' },
    });
    expect(r.env).toEqual({ A: '1', B: '2' });
  });

  it('does not surface smokeBypass when DISABLE_SANDBOX short-circuits', () => {
    // DISABLE takes precedence; we never reach the smoke probe so no bypass marker.
    const r = buildSandbox({
      pluginDir: '/p',
      scratchDir: '/s',
      allowedHosts: [],
      env: {},
    });
    expect(r.smokeBypass).toBeUndefined();
  });
});
