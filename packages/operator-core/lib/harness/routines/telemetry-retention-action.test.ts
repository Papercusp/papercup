/**
 * Unit tests for `system:telemetry-retention` (infra-audit R2 / plan P-006).
 * The prune is mocked — we assert config resolution, the per-target retention
 * windows, the drain loop (re-call while `partial`), and dry-run propagation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pruneMock = vi.fn();
vi.mock('../../storage/prune', () => ({
  pruneStorageCategory: (...args: unknown[]) => pruneMock(...args),
}));

// Import AFTER the mock so the module's registerSystemAction side-effect binds the
// mocked prune.
import { getSystemAction } from './system-actions';
import { resolveTargets, DEFAULT_RETENTION_TARGETS } from './telemetry-retention-action';

const okResult = (over: Record<string, unknown> = {}) => ({
  ok: true,
  categoryId: 'x',
  dryRun: false,
  removed: 100,
  reclaimedBytes: 0,
  reclaimEstimated: true,
  vacuumed: true,
  partial: false,
  ...over,
});

const ctx = (triggerConfig: Record<string, unknown>) => ({
  installSlug: 'papercup',
  workspaceId: 'ws-1',
  triggerConfig,
  payloadTemplate: null,
});

describe('resolveTargets', () => {
  it('defaults to route-invocations@7d + tool-invocations@14d + harness-run-output@14d', () => {
    expect(resolveTargets({})).toEqual([...DEFAULT_RETENTION_TARGETS]);
    expect(resolveTargets({ targets: [] })).toEqual([...DEFAULT_RETENTION_TARGETS]);
  });

  // EI-7491: harness_run_output was a fully-registered prunable storage category
  // (packages/operator-core/lib/storage/categories.ts) that was never added to
  // DEFAULT_RETENTION_TARGETS, so the janitor never pruned it and it grew
  // unbounded (1.5GB/6,726 rows, oldest 56d, ~334 rows/day). Assert it's wired in
  // with the exact category id string categories.ts registers ('harness-run-output')
  // — a typo here silently no-ops (resolveTargets/pruneStorageCategory filter to
  // known categories).
  it('includes harness-run-output@14d in the default targets (EI-7491)', () => {
    expect(DEFAULT_RETENTION_TARGETS).toContainEqual({
      category: 'harness-run-output',
      retention_days: 14,
    });
  });

  it('honors a configured targets list + drops malformed entries', () => {
    const out = resolveTargets({
      targets: [
        { category: 'decision-ledger', retention_days: 30 },
        { retention_days: 5 }, // no category → dropped
      ],
    });
    expect(out).toEqual([{ category: 'decision-ledger', retention_days: 30 }]);
  });
});

describe('system:telemetry-retention action', () => {
  beforeEach(() => {
    pruneMock.mockReset();
    // The action logs warn() on the invalid/failed-prune branches exercised below;
    // the repo's vitest-fail-on-console treats an un-mocked warn as a failure, so
    // capture it (the real assertions are on pruneMock / non-throwing).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('prunes each default target with its retention window + workspace', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    expect(action).toBeTypeOf('function');
    await action!(ctx({}));

    expect(pruneMock).toHaveBeenCalledTimes(3);
    expect(pruneMock).toHaveBeenNthCalledWith(1, {
      categoryId: 'route-invocations',
      olderThanDays: 7,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    expect(pruneMock).toHaveBeenNthCalledWith(2, {
      categoryId: 'tool-invocations',
      olderThanDays: 14,
      dryRun: false,
      workspaceId: 'ws-1',
    });
    expect(pruneMock).toHaveBeenNthCalledWith(3, {
      categoryId: 'harness-run-output',
      olderThanDays: 14,
      dryRun: false,
      workspaceId: 'ws-1',
    });
  });

  it('drains a category: re-calls while the prune reports partial', async () => {
    pruneMock
      .mockResolvedValueOnce(okResult({ partial: true }))
      .mockResolvedValueOnce(okResult({ partial: true }))
      .mockResolvedValueOnce(okResult({ partial: false }));
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [{ category: 'route-invocations', retention_days: 7 }] }));
    expect(pruneMock).toHaveBeenCalledTimes(3); // looped until partial cleared
  });

  it('dry_run propagates and never loops past one call', async () => {
    pruneMock.mockResolvedValue(okResult({ dryRun: true, partial: true }));
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ dry_run: true, targets: [{ category: 'route-invocations', retention_days: 7 }] }));
    expect(pruneMock).toHaveBeenCalledTimes(1); // dry-run stops after one call despite partial
    expect(pruneMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('skips a target with invalid retention_days without throwing', async () => {
    pruneMock.mockResolvedValue(okResult());
    const action = getSystemAction('telemetry-retention');
    await action!(ctx({ targets: [{ category: 'route-invocations', retention_days: -1 }] }));
    expect(pruneMock).not.toHaveBeenCalled();
  });

  it('stops a target on prune failure (ok:false) without throwing', async () => {
    pruneMock.mockResolvedValue({ ok: false, reason: 'invalid_category', removed: 0 });
    const action = getSystemAction('telemetry-retention');
    await expect(
      action!(ctx({ targets: [{ category: 'bogus', retention_days: 7 }] })),
    ).resolves.toBeUndefined();
    expect(pruneMock).toHaveBeenCalledTimes(1);
  });
});
