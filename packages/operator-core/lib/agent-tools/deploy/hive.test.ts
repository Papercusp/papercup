/**
 * hive.test.ts — the deploy:hive + deploy:teardown_hive HANDLERS (deployHive/
 * teardownHive, the cloud-frame orchestration, are mocked). These tools END BILLING /
 * spin cloud frames, so the handler discipline that matters is: it resolves the
 * workspace (arg overrides active), delegates, and — crucially — NEVER throws out of the
 * tool: a failure becomes { ok:false, error } with the message truncated to 400 chars.
 * A regression that lets the deploy/teardown throw, or loses the truncation, is what
 * this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/deploy/hive.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../deployment/hive-deploy', () => ({
  deployHive: vi.fn(),
  teardownHive: vi.fn(),
  defaultHiveDeployDeps: vi.fn(() => ({})),
}));

import { deployHive, teardownHive } from '../../deployment/hive-deploy';
const deployM = vi.mocked(deployHive);
const teardownM = vi.mocked(teardownHive);
const mod = await import('./hive');
const deployTool = mod.default;
const teardownTool = mod.deployTeardownHiveTool;

type Out = { content: { text: string }[] };
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const baseArgs = { hiveId: 'h1', members: ['a'], swarm: {} };
const callDeploy = (extra: Record<string, unknown> = {}) =>
  deployTool.handler({ ...baseArgs, ...extra } as never, {} as never) as Promise<Out>;
const callTeardown = (extra: Record<string, unknown> = {}) =>
  teardownTool.handler({ ...baseArgs, ...extra } as never, {} as never) as Promise<Out>;

beforeEach(() => vi.clearAllMocks());

describe('deploy:hive', () => {
  it('deploys with the active workspace and returns the result', async () => {
    deployM.mockResolvedValue({ frames: 3 } as never);
    const b = body(await callDeploy());
    expect(b).toMatchObject({ ok: true, result: { frames: 3 } });
    expect(deployM.mock.calls[0]![1]).toBe('default'); // ws arg
  });

  it('honors an explicit workspace override', async () => {
    deployM.mockResolvedValue({ frames: 1 } as never);
    await callDeploy({ workspace: 'ws-2' });
    expect(deployM.mock.calls[0]![1]).toBe('ws-2');
  });

  it('converts a thrown error into { ok:false } truncated to 400 chars (never crashes)', async () => {
    deployM.mockRejectedValue(new Error('x'.repeat(500)));
    const b = body(await callDeploy());
    expect(b.ok).toBe(false);
    expect(String(b.error).length).toBe(400);
  });
});

describe('deploy:teardown_hive', () => {
  it('tears down and spreads the destroyed/failed counts', async () => {
    teardownM.mockResolvedValue({ destroyed: 2, failed: 0 } as never);
    const b = body(await callTeardown());
    expect(b).toMatchObject({ ok: true, destroyed: 2, failed: 0 });
  });

  it('converts a thrown teardown error into { ok:false }', async () => {
    teardownM.mockRejectedValue(new Error('boom'));
    const b = body(await callTeardown());
    expect(b).toMatchObject({ ok: false });
    expect(String(b.error)).toMatch(/boom/);
  });
});
