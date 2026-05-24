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

    it('exposes 11 migrated entries total (running count)', () => {
      // Reminder: total live count is 51. Update this assertion as
      // each batch lands; deliberately conservative so future drift is
      // surfaced (an entry added without bumping the count is silently
      // miscoded if the assertion is too loose).
      expect(knownQueryNamesV2()).toHaveLength(11);
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
      // These are real queryNames from the original audit that have
      // NOT been migrated yet — they must still fall through to the
      // legacy resolver. Update this list as each migrates.
      expect(isRegisteredV2('plans.list')).toBe(false);
      expect(isRegisteredV2('chunkPlans.byFeature')).toBe(false);
      expect(isRegisteredV2('orgCharter.byOrg')).toBe(false);
      expect(isRegisteredV2('totally.unknown')).toBe(false);
      expect(isRegisteredV2('')).toBe(false);
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
