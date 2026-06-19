/**
 * admit.test.ts — the fleet:admit HANDLER (admitSpawn mocked; getOrgPg returns a
 * throwaway sql passed straight through). Pins the workspace resolution (arg overrides
 * actor/active) and the delegation — notably the circuit_key → circuitKey rename and the
 * cost/harness/user/role passthrough — to the backpressure governor, returning its
 * verdict verbatim. A regression that drops the circuitKey mapping (so the wrong circuit
 * is debited) is what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/fleet/admit.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: {} })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ workspaceId: 'ws-actor' })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../fleet/governor', () => ({ admitSpawn: vi.fn() }));

import { admitSpawn } from '../../fleet/governor';
const admitM = vi.mocked(admitSpawn);
const tool = (await import('./admit')).default;

type Out = { content: { text: string }[] };
const call = (args: Record<string, unknown> = {}) => tool.handler(args as never, {} as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  admitM.mockResolvedValue({ admitted: true, debited: 1 } as never);
});

describe('fleet:admit handler', () => {
  it('delegates to the governor and returns its verdict, mapping circuit_key→circuitKey', async () => {
    const b = body(await call({ cost: 5, harness: 'web', role: 'worker', circuit_key: 'cb-1' }));
    expect(b).toMatchObject({ admitted: true, debited: 1 });
    const params = admitM.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject({ workspaceId: 'ws-actor', cost: 5, harness: 'web', role: 'worker', circuitKey: 'cb-1' });
  });

  it('an explicit workspace arg overrides the actor workspace', async () => {
    await call({ workspace: 'ws-override' });
    expect((admitM.mock.calls[0]![1] as Record<string, unknown>).workspaceId).toBe('ws-override');
  });
});
