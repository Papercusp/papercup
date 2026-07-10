/**
 * create_from_repo.test.ts — the pot:create_from_repo HANDLER guard + delegation (the
 * composition createPotFromRepo is seam-injected + unit-tested separately). This flow
 * clones a repo + stands up a pot, so the ROOT-ONLY guard (a cup cannot create a pot —
 * hives are peers, never nested) is load-bearing. Also pins the workspace resolution and
 * the arg passthrough. A regression that lets a spawned agent create a pot is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pot/create_from_repo.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
  resolveConcreteWorkspaceId: (...c: Array<string | null | undefined>) =>
    c.find((x): x is string => typeof x === 'string' && x.trim() !== '' && x.trim() !== '*') ?? 'default',
}));
vi.mock('./_create_from_repo', () => ({ createPotFromRepo: vi.fn() }));

import { resolveAgentIdentity } from '../coordination/identity';
import { createPotFromRepo } from './_create_from_repo';
const ident = vi.mocked(resolveAgentIdentity);
const createM = vi.mocked(createPotFromRepo);
const tool = (await import('./create_from_repo')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown> = {}) =>
  tool.handler({ githubUrl: 'https://github.com/x/y', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  createM.mockResolvedValue({ ok: true, created: { potSlug: 'y-pot', memberSlug: 'y' } } as never);
});

describe('pot:create_from_repo handler', () => {
  it('refuses a cup (fleet-spawn) — root-only — with no clone/create', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call());
    expect(b).toMatchObject({ ok: false, error: 'hive_create_root_only' });
    expect(createM).not.toHaveBeenCalled();
  });

  it('delegates with the resolved workspace and returns the composition result', async () => {
    const b = body(await call());
    expect(b).toMatchObject({ ok: true, created: { potSlug: 'y-pot' } });
    expect(createM.mock.calls[0]![0]).toMatchObject({ githubUrl: 'https://github.com/x/y', workspaceId: 'ws-1' });
  });

  it('passes optional args (slug/force/intoPot) through', async () => {
    await call({ slug: 'mypot', force: true, intoPot: 'parent-pot' });
    expect(createM.mock.calls[0]![0]).toMatchObject({ slug: 'mypot', force: true, intoPot: 'parent-pot' });
  });
});
