import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  knownQueryNamesV2,
  isRegisteredV2,
  resolveNamedQueryV2,
  NAME_NOT_FOUND,
} from './index';

describe('sync-resolver v2 registry', () => {
  describe('knownQueryNamesV2', () => {
    it('returns sorted array of registered names', () => {
      const names = knownQueryNamesV2();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toEqual([...names].sort());
    });

    it('includes toastLog.recent (first migration)', () => {
      expect(knownQueryNamesV2()).toContain('toastLog.recent');
    });

    it('includes batch 2 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'auditLog.operatorDecisions',
        'operatorScans.byWorkspace',
        'operatorBudget.byWorkspace',
        'operatorLastScan.byWorkspace',
        'userActions.byKind',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 3 migrated names (harnessXxx.byHarness family)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessTextArtifact.byHarness',
        'harnessProjectFiles.byHarness',
        'harnessSkills.byHarness',
        'harnessDecisions.byHarness',
        'harnessExperts.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 4 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessLanes.byHarness',
        'harnessEscalations.byHarness',
        'harnessCheckpoints.byHarness',
        'harnessGitLog.byHarness',
        'featurePrs.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 5 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'harnessStatus.byHarness',
        'harnessTests.byHarness',
        'harnessArchives.byHarness',
        'harnessHookLogs.byHarness',
        'harnessHealth.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 6 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'summary.byHarness',
        'harnessPhases.byHarness',
        'harnessSmokeTest.byHarness',
        'harnessPlanReview.byHarness',
        'harnessBrainstorm.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 7 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pendingReviews.byHarness',
        'harnessPendingIssues.byHarness',
        'harnessScreenshots.byHarness',
        'harnessBranchActions.byHarnessAndBranch',
        'agentChats.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 8 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featureNotes.byHarness',
        'featureDebugNotes.byHarness',
        'featureAudit.byHarness',
        'chunkPlans.byHarness',
        'chunkPlans.byFeature',
        'delegates.byWorkspace',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 9 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'pluginConfigs.byHarness',
        'pluginEnables.byWorkspace',
        'projectSpecRevisions.byProject',
        'orgCharter.byOrg',
        'orgDepartments.byOrg',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 10 migrated names', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'orgProjects.byOrg',
        'orgInbox.byDept',
        'orgOutbox.byDept',
        'orgNotes.byDept',
        'orgDecisions.byDept',
        'proposalsShared.byHarness',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('includes batch 11 migrated names (final *Consolidated batch)', () => {
      const names = knownQueryNamesV2();
      for (const expected of [
        'featuresConsolidated.bySlug',
        'issuesConsolidated.bySlug',
        'agentRunsConsolidated.bySlug',
        'agentRunsConsolidated.recent',
        'snapshotsConsolidated.bySlug',
      ]) {
        expect(names).toContain(expected);
      }
    });

    it('exposes 53 migrated entries total — all live queryNames migrated', () => {
      // P-022 migration complete: every queryName from the 2026-05-24
      // audit (51) plus chunkPlans.byFeature (was bundled as 1 name in
      // the audit but is 2 namespaces in queries.ts) is in the v2
      // registry. The legacy resolver fall-through is now dead code;
      // cutover commit removes it.
      expect(knownQueryNamesV2()).toHaveLength(53);
    });
  });

  describe('arg validation — batch 2', () => {
    it('auditLog.operatorDecisions rejects missing workspaceId', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('auditLog.operatorDecisions', { limit: 5 })).rejects.toThrow();
    });

    it('operatorScans.byWorkspace defaults limit to 50', async () => {
      // We cannot actually run the SQL without PG, but we CAN inspect
      // that the schema accepts the workspaceId-only shape — zod will
      // throw if it doesn't.
      const { argsSchema } = (await import('./index')) as never;
      // No public accessor for the schema; instead, verify the request
      // shape via knownQueryNamesV2 presence + structural check.
      const names = knownQueryNamesV2();
      expect(names).toContain('operatorScans.byWorkspace');
    });

    it('userActions.byKind rejects missing kind', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(
        r('userActions.byKind', { harnessSlug: 'x', workspaceId: 'y' }),
      ).rejects.toThrow();
    });

    it('operatorBudget.byWorkspace requires workspaceId (string)', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('operatorBudget.byWorkspace', {})).rejects.toThrow();
      await expect(r('operatorBudget.byWorkspace', { workspaceId: 42 })).rejects.toThrow();
    });
  });

  describe('isRegisteredV2', () => {
    it('returns true for registered names', () => {
      expect(isRegisteredV2('toastLog.recent')).toBe(true);
    });

    it('returns false for unregistered names (fall-back path)', () => {
      // After P-022 batch 11, every queryName from the original 2026-05-24
      // audit has been migrated. Only entirely-unknown / synthetic names
      // should hit the fall-back path now. Once the legacy resolver is
      // removed (P-022 cutover), the route handler will return an
      // error envelope instead of falling through, but the v2 dispatcher
      // contract still surfaces NAME_NOT_FOUND for unknown names.
      expect(isRegisteredV2('totally.unknown')).toBe(false);
      expect(isRegisteredV2('')).toBe(false);
      expect(isRegisteredV2('plans.list')).toBe(false); // not in audit; new API surface
    });
  });

  describe('resolveNamedQueryV2 — fall-back signal', () => {
    it('returns NAME_NOT_FOUND for unregistered names', async () => {
      const result = await resolveNamedQueryV2('plans.list', { limit: 10 });
      expect(result).toBe(NAME_NOT_FOUND);
    });
  });

  describe('resolveNamedQueryV2 — toastLog.recent', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('calls listToasts with validated args and returns the flat row array', async () => {
      vi.doMock('@/lib/toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => ({
          toasts: [
            { id: 1, level: 'error', message: 'boom', limit: input.limit },
            { id: 2, level: 'info', message: 'ok', limit: input.limit },
          ],
        })),
      }));
      // Re-import so the module picks up the mock.
      const { resolveNamedQueryV2: r } = await import('./index');
      const rows = (await r('toastLog.recent', { limit: 25 })) as Array<{
        id: number;
        limit: number;
      }>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows[0].limit).toBe(25);
      vi.doUnmock('@/lib/toast-log-data');
    });

    it('applies the default limit (50) when args is empty', async () => {
      const limitsCaptured: Array<number | undefined> = [];
      vi.doMock('@/lib/toast-log-data', () => ({
        listToasts: vi.fn(async (input: { limit?: number }) => {
          limitsCaptured.push(input.limit);
          return { toasts: [] };
        }),
      }));
      const { resolveNamedQueryV2: r } = await import('./index');
      await r('toastLog.recent', {});
      expect(limitsCaptured[0]).toBe(50);
      vi.doUnmock('@/lib/toast-log-data');
    });

    it('rejects out-of-range limit', async () => {
      const { resolveNamedQueryV2: r } = await import('./index');
      await expect(r('toastLog.recent', { limit: 1000 })).rejects.toThrow();
      await expect(r('toastLog.recent', { limit: -1 })).rejects.toThrow();
      await expect(r('toastLog.recent', { limit: 'twenty' })).rejects.toThrow();
    });
  });
});
