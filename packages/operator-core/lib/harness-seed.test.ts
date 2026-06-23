/**
 * harness-seed.test.ts — the hermetic throwaway-harness seed primitive.
 *
 * Pins the validation-before-side-effects guard (a frozen or unknown role override throws BEFORE
 * any harness is registered or file written) and the deterministic effect order (register →
 * pre-seed files → apply role overrides in SORTED order → file the feature). All effects injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_ROLES, FROZEN_OVERLAY_ROLES } from '@papercusp/agent-mcp';
import { seedThrowawayHarness, type SeedHarnessInput, type SeedHarnessDeps, type SeedFeature } from './harness-seed';

const FROZEN = FROZEN_OVERLAY_ROLES[0]; // a frozen role (e.g. the external judge)
const KNOWN = (AGENT_ROLES as readonly string[]).filter((r) => !(FROZEN_OVERLAY_ROLES as readonly string[]).includes(r));
const ROLE_A = KNOWN[0];
const ROLE_B = KNOWN[1];

const FEATURE: SeedFeature = { id: 'F1', title: 'T', spec: 'do the thing' };
const baseInput = (over: Partial<SeedHarnessInput> = {}): SeedHarnessInput => ({
  slug: 'tw-1', repoOrClonePath: '/clone', workspaceId: 'ws', feature: FEATURE, ...over,
});

function makeDeps() {
  const order: string[] = [];
  const deps: SeedHarnessDeps = {
    registerHarness: vi.fn(async () => { order.push('register'); }),
    writeFile: vi.fn(async () => { order.push('write'); }),
    setOverride: vi.fn(async (i: { role: string }) => { order.push(`override:${i.role}`); }),
    fileFeature: vi.fn(async () => { order.push('feature'); }),
  };
  return { deps, order };
}

describe('seedThrowawayHarness — validation before any side effect', () => {
  it('rejects an override of a FROZEN role and performs NO effects', async () => {
    const { deps } = makeDeps();
    await expect(
      seedThrowawayHarness(baseInput({ promptOverrides: { [FROZEN]: 'x' } }), deps),
    ).rejects.toThrow(/frozen role/);
    expect(deps.registerHarness).not.toHaveBeenCalled();
    expect(deps.fileFeature).not.toHaveBeenCalled();
  });

  it('rejects an UNKNOWN override role and performs NO effects', async () => {
    const { deps } = makeDeps();
    await expect(
      seedThrowawayHarness(baseInput({ promptOverrides: { 'not-a-real-role': 'x' } }), deps),
    ).rejects.toThrow(/unknown override role/);
    expect(deps.registerHarness).not.toHaveBeenCalled();
  });
});

describe('seedThrowawayHarness — effect orchestration', () => {
  it('registers, pre-seeds files, applies overrides (sorted), then files the feature', async () => {
    const { deps, order } = makeDeps();
    const overrides = { [ROLE_B]: 'B-prompt', [ROLE_A]: 'A-prompt' };
    const sortedRoles = [ROLE_A, ROLE_B].sort();

    const res = await seedThrowawayHarness(
      baseInput({ files: [{ path: 'a.ts', content: 'AA' }], promptOverrides: overrides }),
      deps,
    );

    expect(order).toEqual(['register', 'write', `override:${sortedRoles[0]}`, `override:${sortedRoles[1]}`, 'feature']);
    expect(deps.registerHarness).toHaveBeenCalledWith({ slug: 'tw-1', path: '/clone', workspaceId: 'ws' });
    expect(deps.writeFile).toHaveBeenCalledWith({ basePath: '/clone', relPath: 'a.ts', content: 'AA' });
    expect(deps.setOverride).toHaveBeenCalledWith({ workspaceId: 'ws', slug: 'tw-1', role: ROLE_A, promptMd: 'A-prompt' });
    expect(deps.fileFeature).toHaveBeenCalledWith({ slug: 'tw-1', workspaceId: 'ws', feature: FEATURE });
    expect(res).toEqual({ harnessSlug: 'tw-1' });
  });

  it('skips the file + override loops cleanly when neither is provided', async () => {
    const { deps, order } = makeDeps();
    await seedThrowawayHarness(baseInput(), deps);
    expect(order).toEqual(['register', 'feature']);
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.setOverride).not.toHaveBeenCalled();
  });

  it('accepts a known non-frozen role override', async () => {
    const { deps } = makeDeps();
    await expect(
      seedThrowawayHarness(baseInput({ promptOverrides: { [ROLE_A]: 'ok' } }), deps),
    ).resolves.toEqual({ harnessSlug: 'tw-1' });
    expect(deps.setOverride).toHaveBeenCalledTimes(1);
  });
});
