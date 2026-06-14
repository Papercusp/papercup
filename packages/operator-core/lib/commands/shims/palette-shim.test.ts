import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../defs', () => ({})); // neutralize the side-effect command registration import
vi.mock('../registry', () => ({ list: vi.fn(), runCommand: vi.fn(() => Promise.resolve({ ok: true })) }));

import { buildRegistryPaletteItems } from './palette-shim';
import { list, runCommand } from '../registry';

const mockedList = vi.mocked(list);
const mockedRun = vi.mocked(runCommand);

describe('buildRegistryPaletteItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps only command defs that carry a paletteEntry', () => {
    mockedList.mockReturnValue([
      { id: 'cmd.a', kind: 'command', paletteEntry: { title: 'A', section: 'S', icon: 'i', keywords: 'k' } },
      { id: 'cmd.b', kind: 'command' }, // no paletteEntry → skipped
      { id: 'q.x', kind: 'query', paletteEntry: { title: 'Q' } }, // not a command → skipped
    ] as never);

    const items = buildRegistryPaletteItems({ workspace: 'ws' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'cmd.a', title: 'A', section: 'S', icon: 'i', keywords: 'k' });
    expect(typeof items[0]!.perform).toBe('function');
  });

  it('perform() dispatches the command with empty args + a palette context for the workspace', () => {
    mockedList.mockReturnValue([
      { id: 'cmd.a', kind: 'command', paletteEntry: { title: 'A' } },
    ] as never);

    const [item] = buildRegistryPaletteItems({ workspace: 'ws-42', sessionId: 'sess' });
    item!.perform();
    expect(mockedRun).toHaveBeenCalledTimes(1);
    expect(mockedRun).toHaveBeenCalledWith(
      'cmd.a',
      {},
      expect.objectContaining({ agent: 'palette', workspace: 'ws-42', sessionId: 'sess' }),
    );
  });

  it('returns an empty list when no palette commands are registered', () => {
    mockedList.mockReturnValue([] as never);
    expect(buildRegistryPaletteItems({ workspace: 'ws' })).toEqual([]);
  });
});
