import { describe, it, expect, beforeEach, vi } from 'vitest';
import listTool from './list';
import { getFlag } from '@papercusp/flags/server';
import { listLearningPacks } from '../../learning-packs/load-packs';
import { readHiveLearnings } from '../../sync-resolver/learning-hive-read';
import { disabledPacksFor } from '../../learning-packs/manage';

// PG-free unit: the pack loaders + hive snapshot have their own suites; this pins
// the TOOL — the flag gate, the catalog-only vs hive branch, and the installed
// projection (enabled from the disabled set, updateAvailable/availableVersion vs
// the catalog) — learning-packs-2026-06-11 P-009.
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/load-packs', () => ({ listLearningPacks: vi.fn(), loadLearningPack: vi.fn() }));
vi.mock('../../sync-resolver/learning-hive-read', () => ({ readHiveLearnings: vi.fn() }));
vi.mock('../../memory/backend', () => ({ getMemoryBackend: vi.fn() }));
vi.mock('../../learning-packs/manage', () => ({ disabledPacksFor: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockListPacks = vi.mocked(listLearningPacks);
const mockReadHive = vi.mocked(readHiveLearnings);
const mockDisabled = vi.mocked(disabledPacksFor);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    listTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:list tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockListPacks.mockResolvedValue([{ id: 'papercusp-default', version: '2.0.0' }] as unknown as Awaited<
      ReturnType<typeof listLearningPacks>
    >);
  });

  it('refuses with the FLAG_OFF envelope when the feature flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    const res = body(await callTool({}));
    expect(res).toMatchObject({ ok: false, reason: 'feature-disabled', flag: 'papercusp-learning-packs' });
    expect(mockListPacks).not.toHaveBeenCalled();
  });

  it('returns just the catalog when no hive is given', async () => {
    const res = body(await callTool({}));
    expect(res).toEqual({ ok: true, packs: [{ id: 'papercusp-default', version: '2.0.0' }] });
    expect(mockReadHive).not.toHaveBeenCalled();
  });

  it('projects installed state for a hive: enabled (from disabled set) + updateAvailable vs the catalog', async () => {
    mockReadHive.mockResolvedValue({
      packs: [{ packId: 'papercusp-default', packVersion: '1.0.0' }],
      organicCount: 4,
    } as unknown as Awaited<ReturnType<typeof readHiveLearnings>>);
    mockDisabled.mockResolvedValue(['papercusp-default']);
    const res = body(await callTool({ hive: 'my-hive' }));
    expect(res.hive).toBe('my-hive');
    expect(res.organicCount).toBe(4);
    expect(res.installed[0]).toMatchObject({
      packId: 'papercusp-default',
      enabled: false, // it's in the disabled set
      updateAvailable: true, // installed 1.0.0 vs catalog 2.0.0
      availableVersion: '2.0.0',
    });
  });

  it('LP-1: a catalog version OLDER than installed is NOT an update (semver, not string !==)', async () => {
    // Catalog ships 1.0.0; the hive already carries 2.0.0. The old string
    // inequality (`avail.version !== p.packVersion`) flagged this downgrade as
    // updateAvailable:true. semverGt(1.0.0, 2.0.0) === false fixes it.
    mockListPacks.mockResolvedValue([{ id: 'papercusp-default', version: '1.0.0' }] as never);
    mockReadHive.mockResolvedValue({
      packs: [{ packId: 'papercusp-default', packVersion: '2.0.0' }],
      organicCount: 0,
    } as unknown as Awaited<ReturnType<typeof readHiveLearnings>>);
    mockDisabled.mockResolvedValue([]);
    const res = body(await callTool({ hive: 'my-hive' }));
    expect(res.installed[0]).toMatchObject({
      packId: 'papercusp-default',
      updateAvailable: false, // 1.0.0 is NOT newer than installed 2.0.0
      availableVersion: '1.0.0',
    });
  });

  it('LP-1: 1.10.0 IS recognized as newer than installed 1.9.0', async () => {
    mockListPacks.mockResolvedValue([{ id: 'papercusp-default', version: '1.10.0' }] as never);
    mockReadHive.mockResolvedValue({
      packs: [{ packId: 'papercusp-default', packVersion: '1.9.0' }],
      organicCount: 0,
    } as unknown as Awaited<ReturnType<typeof readHiveLearnings>>);
    mockDisabled.mockResolvedValue([]);
    const res = body(await callTool({ hive: 'my-hive' }));
    expect(res.installed[0].updateAvailable).toBe(true);
  });

  it('LP-1: equal versions are NOT an update', async () => {
    mockListPacks.mockResolvedValue([{ id: 'papercusp-default', version: '2.0.0' }] as never);
    mockReadHive.mockResolvedValue({
      packs: [{ packId: 'papercusp-default', packVersion: '2.0.0' }],
      organicCount: 0,
    } as unknown as Awaited<ReturnType<typeof readHiveLearnings>>);
    mockDisabled.mockResolvedValue([]);
    const res = body(await callTool({ hive: 'my-hive' }));
    expect(res.installed[0].updateAvailable).toBe(false);
  });
});
