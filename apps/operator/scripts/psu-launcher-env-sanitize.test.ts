/**
 * psu-launcher-env-sanitize.test.ts (EI-8868/EI-8877) — the fleet-wide recurrence
 * guard for the npm-run-lifecycle env leak that poisons every psu-launched agent's
 * vitest/npx resolution (and, via harness_shared.test_runs, the fleet's "red-test"
 * watchdog signal — see EI-8828/EI-8840). Proves `sanitizeInheritedEnv` strips the
 * dangerous npm_* lifecycle vars + release-tree PATH segments, and ONLY those.
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-env-sanitize.test.ts
 */
import { describe, it, expect } from 'vitest';
import { sanitizeInheritedEnv } from './psu-launcher.mjs';

const delimiter = process.platform === 'win32' ? ';' : ':';

describe('sanitizeInheritedEnv (EI-8868/EI-8877)', () => {
  it('strips npm_config_local_prefix, npm_package_*, npm_lifecycle_*, and INIT_CWD', () => {
    const dirty = {
      npm_config_local_prefix: '/home/marsh-office/papercupai-workspace/papercup-release',
      npm_package_json: '/home/marsh-office/papercupai-workspace/papercup-release/apps/operator/package.json',
      npm_package_name: '@papercupai/papercusp-monorepo',
      npm_lifecycle_event: 'dev',
      npm_lifecycle_script: 'next dev',
      INIT_CWD: '/home/marsh-office/papercupai-workspace/papercup-release/apps/operator',
      HOME: '/home/marsh-office',
      PAPERCUSP_HARNESS_SLUG: 'papercusp',
    };
    const clean = sanitizeInheritedEnv(dirty);
    expect(clean.npm_config_local_prefix).toBeUndefined();
    expect(clean.npm_package_json).toBeUndefined();
    expect(clean.npm_package_name).toBeUndefined();
    expect(clean.npm_lifecycle_event).toBeUndefined();
    expect(clean.npm_lifecycle_script).toBeUndefined();
    expect(clean.INIT_CWD).toBeUndefined();
    // untouched
    expect(clean.HOME).toBe('/home/marsh-office');
    expect(clean.PAPERCUSP_HARNESS_SLUG).toBe('papercusp');
  });

  it('filters ONLY papercup-release PATH segments, preserving order + everything else', () => {
    const dirty = {
      PATH: [
        '/home/marsh-office/.local/bin',
        '/home/marsh-office/papercupai-workspace/papercup-release/node_modules/.bin',
        '/home/marsh-office/papercupai-workspace/papercup-release/apps/operator/node_modules/.bin',
        '/home/marsh-office/papercupai-workspace/papercusp/node_modules/.bin',
        '/usr/bin',
      ].join(delimiter),
    };
    const clean = sanitizeInheritedEnv(dirty);
    const segs = clean.PATH.split(delimiter);
    expect(segs).toEqual([
      '/home/marsh-office/.local/bin',
      '/home/marsh-office/papercupai-workspace/papercusp/node_modules/.bin',
      '/usr/bin',
    ]);
  });

  it('is a no-op on an already-clean env (no PATH mutation, nothing dropped)', () => {
    const clean = {
      PATH: ['/usr/bin', '/bin'].join(delimiter),
      HOME: '/home/marsh-office',
    };
    const out = sanitizeInheritedEnv(clean);
    expect(out).toEqual(clean);
  });

  it('never mutates the input object (pure)', () => {
    const dirty = { npm_config_local_prefix: '/x', PATH: `/a${delimiter}/papercup-release/node_modules/.bin` };
    const before = { ...dirty };
    sanitizeInheritedEnv(dirty);
    expect(dirty).toEqual(before);
  });

  it('handles a missing/undefined PATH without throwing', () => {
    const out = sanitizeInheritedEnv({ npm_config_local_prefix: '/x' });
    expect(out.PATH).toBeUndefined();
    expect(out.npm_config_local_prefix).toBeUndefined();
  });
});
