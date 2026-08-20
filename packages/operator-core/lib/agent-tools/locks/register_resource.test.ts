import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('./coordination-domain', () => ({ hostGlobalLockDomain: vi.fn(() => 'papercusp-host-global') }));
vi.mock('./in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_domain: string, _owner: string, fn: (tx: unknown) => unknown) => fn({ tx: true })),
}));
vi.mock('./su-lock-store', () => ({ registerResource: vi.fn() }));

import { inWorkspaceTxn } from './in-workspace-txn';
import { registerResource } from './su-lock-store';

const registerM = vi.mocked(registerResource);
const txnM = vi.mocked(inWorkspaceTxn);
const tool = (await import('./register_resource')).default;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);

const row = {
  resource: 'deploy:example',
  description: 'one deploy at a time',
  rule_text: 'Acquire exclusive before deployment.',
  enforcement: 'enforced' as const,
  match_patterns: [],
  max_holders: null,
};

beforeEach(() => vi.clearAllMocks());

describe('locks:register_resource', () => {
  it('creates a resource through the global registration transaction', async () => {
    registerM.mockResolvedValue({ created: true, resource: row });

    const result = body(
      await (tool.handler(
        {
          resource: row.resource,
          description: row.description,
          rule_text: row.rule_text,
          enforcement: row.enforcement,
          max_holders: row.max_holders,
        } as never,
        {} as never,
      ) as Promise<Out>),
    );

    expect(txnM).toHaveBeenCalledWith('papercusp-host-global', 'me', expect.any(Function));
    expect(registerM).toHaveBeenCalledWith(expect.objectContaining({ tx: true }), {
      resource: row.resource,
      description: row.description,
      rule_text: row.rule_text,
      enforcement: row.enforcement,
      max_holders: row.max_holders,
    });
    expect(result).toMatchObject({ ok: true, created: true, resource: row });
  });

  it('reports an existing resource without overwriting its policy', async () => {
    registerM.mockResolvedValue({ created: false, resource: row });

    const result = body(await (tool.handler({ resource: row.resource } as never, {} as never) as Promise<Out>));

    expect(result).toMatchObject({ ok: true, created: false, resource: row });
  });
});
