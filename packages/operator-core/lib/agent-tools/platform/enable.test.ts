/**
 * enable.test.ts — the platform:enable HANDLER guards + delegation (the composition
 * enablePlatformMode is seam-injected + unit-tested separately). platform:enable is a
 * high-tier, app-wide opt-in ("Papercusp inside Papercusp") that clones a repo and arms
 * self-improvement loops, so its TWO guards are load-bearing:
 *   • ROOT-ONLY — a bee (source 'fleet-spawn') must be refused;
 *   • CONFIRM-REQUIRED — no confirm:true ⇒ refuse, with NO side effects.
 * Plus: on success it resolves the workspace and delegates to enablePlatformMode, and
 * records a best-effort audit. A regression that lets a spawned agent enable platform
 * mode, or fires the clone without confirmation, is exactly what this catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/platform/enable.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../flag-audit', () => ({ recordFlagAudit: vi.fn() }));
vi.mock('../../pot/enable-platform-mode', () => ({
  enablePlatformMode: vi.fn(),
  PAPERCUSP_CANONICAL_REPO_URL: 'https://github.com/example/papercusp',
  PLATFORM_SELF_HIVE_SLUG: 'papercusp-self',
}));

import { resolveAgentIdentity } from '../coordination/identity';
import { enablePlatformMode } from '../../pot/enable-platform-mode';
import { recordFlagAudit } from '../../flag-audit';
const ident = vi.mocked(resolveAgentIdentity);
const enableM = vi.mocked(enablePlatformMode);
const auditM = vi.mocked(recordFlagAudit);
const tool = (await import('./enable')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ reason: 'opting in for tests', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  enableM.mockResolvedValue({ ok: true, flagEnabled: true, selfHive: 'papercusp-self-hive' } as never);
  auditM.mockResolvedValue(undefined as never);
});

describe('platform:enable guards', () => {
  it('refuses a bee (fleet-spawn) — root-only — with no side effects', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: false, error: 'platform_enable_root_only' });
    expect(enableM).not.toHaveBeenCalled();
  });

  it('requires confirm:true — refuses without it and does NOT clone/arm', async () => {
    const b = body(await call({}));
    expect(b).toMatchObject({ ok: false, error: 'confirm_required' });
    expect(enableM).not.toHaveBeenCalled();
  });
});

describe('platform:enable success path', () => {
  it('delegates to enablePlatformMode with the resolved workspace and returns its result', async () => {
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, flagEnabled: true, selfHive: 'papercusp-self-hive' });
    expect(enableM).toHaveBeenCalledTimes(1);
    expect(enableM.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-1' }); // ctx.workspaceId wins
  });

  it('records a best-effort audit on enable', async () => {
    await call({ confirm: true });
    expect(auditM).toHaveBeenCalledTimes(1);
    expect(String(auditM.mock.calls[0]![3]?.reason)).toMatch(/platform:enable/);
  });

  it('passes an explicit repoUrl/slug through to the composition', async () => {
    await call({ confirm: true, repoUrl: 'https://example/fork', slug: 'myself' });
    expect(enableM.mock.calls[0]![0]).toMatchObject({ repoUrl: 'https://example/fork', slug: 'myself' });
  });
});
