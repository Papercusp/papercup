/**
 * pot-scope.test.ts — the resolution ORDER behind every learning writer's pot
 * stamp (pot-scope-all-learnings-2026-07-26 P-002/P-006).
 *
 * The order is load-bearing tenancy logic: a wrong step here misfiles one
 * pot's learnings under another (the WI-5809 class). The fake-pot regression
 * case (a slug the registry does NOT recognize must never become its own pot)
 * is pinned explicitly — live scout_ticks data showed '@singleton' and
 * 'capacity-storm-*' minted as pots by the removed "harness is its own scope"
 * fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLearningPotSlug } from './pot-scope';

const ENV_KEY = 'PAPERCUSP_POT_HOME_SLUG';
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe('resolveLearningPotSlug — the deliberate order', () => {
  it('an explicit potSlug wins outright — the registry is never consulted', async () => {
    const resolveHive = vi.fn(async () => 'registry-pot');
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      potSlug: 'explicit-pot',
      harnessSlug: 'some-harness',
      resolveHive,
    });
    expect(pot).toBe('explicit-pot');
    expect(resolveHive).not.toHaveBeenCalled();
  });

  it('the harness resolves to its OWNING pot via the registry step', async () => {
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      harnessSlug: 'member-harness',
      resolveHive: async () => 'owner-pot',
    });
    expect(pot).toBe('owner-pot');
  });

  it('a slug the registry does NOT recognize is NOT a pot — falls to env, never itself (fake-pot regression)', async () => {
    process.env[ENV_KEY] = 'home-pot';
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      harnessSlug: '@singleton',
      resolveHive: async () => null,
    });
    expect(pot).toBe('home-pot');
  });

  it('an unrecognized slug with no env home resolves to null — a real answer (D-002)', async () => {
    delete process.env[ENV_KEY];
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      harnessSlug: 'capacity-storm-abc123',
      resolveHive: async () => null,
    });
    expect(pot).toBeNull();
  });

  it('a THROWING registry read degrades to the env home pot (a write must never be lost to a scope lookup)', async () => {
    process.env[ENV_KEY] = 'home-pot';
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      harnessSlug: 'h',
      resolveHive: async () => {
        throw new Error('no org-PG in this process');
      },
    });
    expect(pot).toBe('home-pot');
  });

  it('no harness at all: env home pot, else null', async () => {
    process.env[ENV_KEY] = 'home-pot';
    expect(await resolveLearningPotSlug({ workspaceId: 'w' })).toBe('home-pot');
    delete process.env[ENV_KEY];
    expect(await resolveLearningPotSlug({ workspaceId: 'w' })).toBeNull();
  });

  it('blank/whitespace inputs are treated as absent at every step', async () => {
    process.env[ENV_KEY] = '  ';
    const pot = await resolveLearningPotSlug({
      workspaceId: 'w',
      potSlug: '   ',
      harnessSlug: '',
      resolveHive: async () => '  ',
    });
    expect(pot).toBeNull();
  });
});
