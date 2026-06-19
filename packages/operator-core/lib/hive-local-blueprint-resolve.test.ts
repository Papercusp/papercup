/**
 * hive-local-blueprint-resolve.test.ts — P-012 (domain-generic-hive-architecture-2026-06-18).
 *
 * Unit-tests the PRODUCER orchestration that wraps the (separately-tested) materializer:
 * the not-in-hive / no-overrides short-circuits, the success path (returns the materialized
 * localRoot, passes the caller's blueprint id, defaults it to 'base'), and — the load-bearing
 * invariant — that it is STRICTLY BEST-EFFORT: any thrown/rejected dependency yields null and
 * NEVER throws, because it sits on the hot spawn path (operator-spawn.ts). The materializer's
 * own behavior is covered by hive-local-blueprint.test.ts and is mocked away here so these
 * cases isolate the producer's branching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hiveHomeSlugForHarness, listHiveInstancePromptOverrides, materializeHiveLocalBlueprint } =
  vi.hoisted(() => ({
    hiveHomeSlugForHarness: vi.fn(),
    listHiveInstancePromptOverrides: vi.fn(),
    materializeHiveLocalBlueprint: vi.fn(),
  }));

vi.mock('./hive-federation', () => ({
  hiveHomeSlugForHarness: (...a: unknown[]) => hiveHomeSlugForHarness(...a),
}));
vi.mock('./hive-settings-store', () => ({
  listHiveInstancePromptOverrides: (...a: unknown[]) => listHiveInstancePromptOverrides(...a),
}));
vi.mock('./hive-local-blueprint', () => ({
  materializeHiveLocalBlueprint: (...a: unknown[]) => materializeHiveLocalBlueprint(...a),
  readFileOrNull: () => null,
}));
// Reached eagerly on the success path (before materialize); keep it hermetic so the test
// never touches the real built-in prompt tree.
vi.mock('@papercusp/harness/paths', () => ({ harnessRoot: () => '/fake/builtin' }));
vi.mock('@papercusp/orchestrator/role-prompt', () => ({ resolvePromptFile: () => null }));

import {
  resolveHiveLocalBlueprintRoot,
  blueprintLocalRootExtra,
} from './hive-local-blueprint-resolve';

const INPUT = {
  workspaceId: 'ws-1',
  harnessSlug: 'papercup',
  harnessDir: '/proj',
  hiveBlueprintId: 'coding',
};

beforeEach(() => {
  hiveHomeSlugForHarness.mockReset();
  listHiveInstancePromptOverrides.mockReset();
  materializeHiveLocalBlueprint.mockReset();
});

describe('blueprintLocalRootExtra', () => {
  it('returns null for a null root (caller appends no extra)', () => {
    expect(blueprintLocalRootExtra(null)).toBeNull();
  });

  it('formats the BLUEPRINT_LOCAL_ROOT= extra for a root path', () => {
    expect(blueprintLocalRootExtra('/proj/.materialized/x')).toBe(
      'BLUEPRINT_LOCAL_ROOT=/proj/.materialized/x',
    );
  });
});

describe('resolveHiveLocalBlueprintRoot', () => {
  it('returns null when the harness is not in a Hive (and never reads overrides)', async () => {
    hiveHomeSlugForHarness.mockResolvedValue(null);

    expect(await resolveHiveLocalBlueprintRoot(INPUT)).toBeNull();
    expect(hiveHomeSlugForHarness).toHaveBeenCalledWith('ws-1', 'papercup');
    expect(listHiveInstancePromptOverrides).not.toHaveBeenCalled();
  });

  it('returns null when the Hive has no prompt overrides (and never materializes)', async () => {
    hiveHomeSlugForHarness.mockResolvedValue('papercup-hive');
    listHiveInstancePromptOverrides.mockResolvedValue({});

    expect(await resolveHiveLocalBlueprintRoot(INPUT)).toBeNull();
    expect(listHiveInstancePromptOverrides).toHaveBeenCalledWith('ws-1', 'papercup-hive');
    expect(materializeHiveLocalBlueprint).not.toHaveBeenCalled();
  });

  it('returns the materialized localRoot on success, passing the caller blueprint id + hiveDir', async () => {
    hiveHomeSlugForHarness.mockResolvedValue('papercup-hive');
    listHiveInstancePromptOverrides.mockResolvedValue({ queen: 'HIVE QUEEN DELTA' });
    materializeHiveLocalBlueprint.mockResolvedValue({
      localRoot: '/proj/.materialized/papercup-local',
    });

    expect(await resolveHiveLocalBlueprintRoot(INPUT)).toBe('/proj/.materialized/papercup-local');
    expect(materializeHiveLocalBlueprint).toHaveBeenCalledWith(
      { hiveBlueprintId: 'coding', hiveDir: '/proj' },
      expect.objectContaining({
        readOverrides: expect.any(Function),
        readBuiltinPersona: expect.any(Function),
      }),
    );
  });

  it("defaults the blueprint id to 'base' when the caller passes an empty id", async () => {
    hiveHomeSlugForHarness.mockResolvedValue('h');
    listHiveInstancePromptOverrides.mockResolvedValue({ bee: 'B' });
    materializeHiveLocalBlueprint.mockResolvedValue({ localRoot: '/r' });

    await resolveHiveLocalBlueprintRoot({ ...INPUT, hiveBlueprintId: '' });
    expect(materializeHiveLocalBlueprint).toHaveBeenCalledWith(
      expect.objectContaining({ hiveBlueprintId: 'base' }),
      expect.anything(),
    );
  });

  it('returns null when materialization yields nothing (no roles materialized)', async () => {
    hiveHomeSlugForHarness.mockResolvedValue('h');
    listHiveInstancePromptOverrides.mockResolvedValue({ queen: 'q' });
    materializeHiveLocalBlueprint.mockResolvedValue(null);

    expect(await resolveHiveLocalBlueprintRoot(INPUT)).toBeNull();
  });

  it('is STRICTLY best-effort: a rejected dependency yields null, never a throw', async () => {
    // PG miss on the very first dependency.
    hiveHomeSlugForHarness.mockRejectedValue(new Error('pg down'));
    await expect(resolveHiveLocalBlueprintRoot(INPUT)).resolves.toBeNull();

    // …and when the materializer itself throws mid-way (fs error on the hot spawn path).
    hiveHomeSlugForHarness.mockResolvedValue('h');
    listHiveInstancePromptOverrides.mockResolvedValue({ queen: 'q' });
    materializeHiveLocalBlueprint.mockRejectedValue(new Error('fs error'));
    await expect(resolveHiveLocalBlueprintRoot(INPUT)).resolves.toBeNull();
  });
});
