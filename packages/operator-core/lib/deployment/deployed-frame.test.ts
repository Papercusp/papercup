/**
 * Tests for loadDeployedFrame — the registry-backed deployed-frame lookup
 * (resolves a slug → its frame + deployment config, with the frame.target
 * fallback). Run with:
 *   cd packages/operator-core && npx vitest run lib/deployment/deployed-frame.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({ projects: [] as Array<Record<string, unknown>> }));
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: async () => ({ projects: reg.projects }),
}));

import { loadDeployedFrame } from './deployed-frame';

afterEach(() => {
  reg.projects = [];
});

describe('loadDeployedFrame', () => {
  it('returns the frame + its explicit deployment config', async () => {
    reg.projects = [{ slug: 'h', deploymentFrame: { target: 'vnc' }, deployment: { target: 'vnc', display: 99 } }];
    expect(await loadDeployedFrame('h', 'ws')).toEqual({
      frame: { target: 'vnc' },
      config: { target: 'vnc', display: 99 },
    });
  });

  it('falls back to a { target } config derived from the frame when deployment is absent', async () => {
    reg.projects = [{ slug: 'h', deploymentFrame: { target: 'vnc' } }];
    expect(await loadDeployedFrame('h', 'ws')).toEqual({
      frame: { target: 'vnc' },
      config: { target: 'vnc' },
    });
  });

  it('returns undefined when the project has no deployment frame', async () => {
    reg.projects = [{ slug: 'h' }];
    expect(await loadDeployedFrame('h', 'ws')).toBeUndefined();
  });

  it('returns undefined for an unknown slug', async () => {
    reg.projects = [{ slug: 'other', deploymentFrame: { target: 'vnc' } }];
    expect(await loadDeployedFrame('h', 'ws')).toBeUndefined();
  });
});
