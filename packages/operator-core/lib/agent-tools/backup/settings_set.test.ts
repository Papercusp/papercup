/**
 * settings_set.test.ts — the backup:settings_set HANDLER (workspaceBackupFor().
 * updateSettings mocked). The handler patches the active workspace's backup settings:
 * it forwards the (partial) args to updateSettings and returns the resulting settings.
 * Pins that the patch is applied to the ACTIVE workspace and the returned settings are
 * surfaced. A regression that drops the patch or targets the wrong workspace is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/backup/settings_set.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('../../backup', () => ({ workspaceBackupFor: vi.fn(() => ({ updateSettings: h.update })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-1') }));

import { workspaceBackupFor } from '../../backup';
const forM = vi.mocked(workspaceBackupFor);
const tool = (await import('./settings_set')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  h.update.mockResolvedValue({ enabled: true, cadenceMode: 'event' } as never);
});

describe('backup:settings_set handler', () => {
  it('patches the ACTIVE workspace and returns the merged settings', async () => {
    const b = body(await call({ enabled: true, cadenceMinutes: 30 }));
    expect(forM).toHaveBeenCalledWith('ws-1'); // active workspace
    expect(h.update).toHaveBeenCalledWith({ enabled: true, cadenceMinutes: 30 });
    expect(b).toMatchObject({ settings: { enabled: true, cadenceMode: 'event' } });
  });
});
