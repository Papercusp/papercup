/**
 * settings_get.test.ts — the backup:settings_get HANDLER (workspaceBackupFor().
 * getSettings + stats mocked). Pins that it reads the ACTIVE workspace's backup and
 * combines settings + repo stats (fetched together) into one { settings, stats } result.
 * A regression that reads the wrong workspace or drops one half is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/backup/settings_get.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getSettings: vi.fn(), stats: vi.fn() }));
vi.mock('../../backup', () => ({ workspaceBackupFor: vi.fn(() => ({ getSettings: h.getSettings, stats: h.stats })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));

import { workspaceBackupFor } from '../../backup';
const forM = vi.mocked(workspaceBackupFor);
const tool = (await import('./settings_get')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettings.mockResolvedValue({ enabled: true });
  h.stats.mockResolvedValue({ snapshots: 5 });
});

describe('backup:settings_get handler', () => {
  it('reads the ACTIVE workspace and combines settings + stats', async () => {
    const out = (await tool.handler({} as never, {} as never)) as Out;
    expect(forM).toHaveBeenCalledWith('ws-1');
    expect(body(out)).toMatchObject({ settings: { enabled: true }, stats: { snapshots: 5 } });
  });
});
