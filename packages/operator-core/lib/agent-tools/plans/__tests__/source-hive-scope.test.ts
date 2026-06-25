import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hiveHomeSlugForHarness: vi.fn<(_workspaceId: string, harnessSlug: string) => Promise<string | null>>(
    async (_workspaceId, harnessSlug) => harnessSlug,
  ),
}));

vi.mock('../../../hive-federation', () => ({
  hiveHomeSlugForHarness: h.hiveHomeSlugForHarness,
}));

import { resolvePlanScope } from '../source';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';

describe('resolvePlanScope — Hive-scoped plan key guard', () => {
  beforeEach(() => {
    h.hiveHomeSlugForHarness.mockReset();
    h.hiveHomeSlugForHarness.mockImplementation(async (_workspaceId, harnessSlug) => harnessSlug);
  });

  it('canonicalizes retired Papercup slugs to the Papercusp Hive home', async () => {
    await expect(resolvePlanScope({ harnessSlug: 'papercup' })).resolves.toEqual({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      harnessSlug: operatorHomeHarnessSlug(),
    });
    await expect(resolvePlanScope({ harnessSlug: 'papercup-hive' })).resolves.toEqual({
      workspaceId: PAPERCUSP_WORKSPACE_ID,
      harnessSlug: operatorHomeHarnessSlug(),
    });
  });

  it('collapses a member harness to its Hive home before using the plan key', async () => {
    h.hiveHomeSlugForHarness.mockResolvedValue('oddsmith-hive');

    await expect(
      resolvePlanScope({
        harnessSlug: 'oddsmith',
        workspaceId: 'papercusp-workspace',
      }),
    ).resolves.toEqual({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'oddsmith-hive',
    });
  });

  it('rejects a concrete harness that is not in a Hive', async () => {
    h.hiveHomeSlugForHarness.mockResolvedValue(null);

    await expect(
      resolvePlanScope({
        harnessSlug: 'standalone',
        workspaceId: 'ws',
      }),
    ).rejects.toThrow(/plans are Hive-scoped/);
  });
});
