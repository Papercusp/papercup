import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  search: vi.fn(),
  authorize: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../../auth', () => ({ getSessionUserOrDefault: async () => ({ id: 'user-1' }) }));
vi.mock('../../personal-vault/store', () => ({
  purgePersonalSource: mocks.purge,
  searchPersonalDocuments: mocks.search,
}));
vi.mock('../../personal-vault/authorization', () => ({ authorizePersonalAccess: mocks.authorize }));
vi.mock('../../personal-vault/embedding', () => ({
  PERSONAL_EMBEDDER_MODE: 'gemma',
  buildPersonalQueryEmbedder: async () => mocks.embed,
}));

import purgeTool from './purge';
import searchTool from './search';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.purge.mockResolvedValue({ documents: 2, cursors: 1, aliases: 1, identities: 0 });
  mocks.embed.mockResolvedValue([0.1, 0.2]);
  mocks.search.mockResolvedValue([{ id: 'doc-1' }]);
  mocks.authorize.mockResolvedValue({
    allowed: true,
    principal: { kind: 'user', id: 'user-1' },
    scopes: ['gmail'],
  });
});

describe('Personal Vault defineTool response contract', () => {
  it('personal:purge returns the required ToolResponse data envelope', async () => {
    const result = await purgeTool.handler({ source: 'gmail', confirm: true }, {
      principal: { kind: 'user', workspaceId: 'ws-1' },
      tx: {},
    } as never);
    expect(result).toEqual({
      data: {
        ok: true,
        source: 'gmail',
        deleted: { documents: 2, cursors: 1, aliases: 1, identities: 0 },
      },
    });
  });

  it('personal:search envelopes both granted and refused results', async () => {
    const ctx = { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' }, tx: {} } as never;
    const granted = await searchTool.handler({ query: 'meeting', scopes: ['gmail'] }, ctx);
    expect(granted).toMatchObject({
      data: { allowed: true, grantedScopes: ['gmail'], vectorLeg: 'gemma', results: [{ id: 'doc-1' }] },
    });

    mocks.authorize.mockResolvedValueOnce({ allowed: false, reason: 'grant_required', scopes: [] });
    const refused = await searchTool.handler({ query: 'meeting' }, ctx);
    expect(refused).toEqual({
      data: { allowed: false, refusal: 'grant_required', results: [], grantedScopes: [] },
    });
  });
});
