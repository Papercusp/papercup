/**
 * contribute.test.ts — the platform:contribute HANDLER guards, delegation, and the
 * audit-only-when-sent rule (the composition contributeUpstream is seam-injected +
 * unit-tested separately). platform:contribute is the OUTWARD-FACING leg of platform
 * mode (git push / PR / Comb publish), so its handler discipline matters:
 *   • ROOT-ONLY — a bee (source 'fleet-spawn') is refused;
 *   • it passes the kind + resolved workspace + the per-kind args through;
 *   • it records an audit ONLY for a genuinely SENT contribution — a prepared/dry-run
 *     (the default "prepared, not sent" result) must NOT leave an outward audit trail.
 * A regression that audits a dry-run, or lets a bee contribute upstream, is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/platform/contribute.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'default') }));
vi.mock('../../flag-audit', () => ({ recordFlagAudit: vi.fn() }));
vi.mock('../../pot/contribute-upstream', () => ({ contributeUpstream: vi.fn() }));
vi.mock('../../pot/enable-platform-mode', () => ({ PLATFORM_SELF_HIVE_SLUG: 'papercusp-self' }));

import { resolveAgentIdentity } from '../coordination/identity';
import { contributeUpstream } from '../../pot/contribute-upstream';
import { recordFlagAudit } from '../../flag-audit';
const ident = vi.mocked(resolveAgentIdentity);
const contribM = vi.mocked(contributeUpstream);
const auditM = vi.mocked(recordFlagAudit);
const tool = (await import('./contribute')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ reason: 'contributing for tests', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  contribM.mockResolvedValue({ ok: true, prepared: true, needs: ['fork_remote'] } as never);
  auditM.mockResolvedValue(undefined as never);
});

describe('platform:contribute guards + delegation', () => {
  it('refuses a bee (fleet-spawn) — root-only — with no outward action', async () => {
    ident.mockReturnValue({ source: 'fleet-spawn' } as never);
    const b = body(await call({ kind: 'learning-pack' }));
    expect(b).toMatchObject({ ok: false, error: 'platform_contribute_root_only' });
    expect(contribM).not.toHaveBeenCalled();
  });

  it('delegates with the kind + resolved workspace and returns the composition result', async () => {
    const b = body(await call({ kind: 'learning-pack' }));
    expect(b).toMatchObject({ ok: true, prepared: true, needs: ['fork_remote'] });
    expect(contribM).toHaveBeenCalledTimes(1);
    expect(contribM.mock.calls[0]![0]).toMatchObject({ kind: 'learning-pack', workspaceId: 'ws-1' });
  });

  it('passes per-kind pr args through to the composition', async () => {
    await call({ kind: 'pr', confirm: true, featureBranch: 'fix/x', prTitle: 'Fix x' });
    expect(contribM.mock.calls[0]![0]).toMatchObject({
      kind: 'pr', confirm: true, featureBranch: 'fix/x', prTitle: 'Fix x',
    });
  });
});

describe('platform:contribute audit-only-when-sent', () => {
  it('does NOT audit a prepared (not-sent) contribution', async () => {
    contribM.mockResolvedValue({ ok: true, prepared: true } as never);
    await call({ kind: 'learning-pack', confirm: true });
    expect(auditM).not.toHaveBeenCalled();
  });

  it('audits a genuinely sent contribution', async () => {
    contribM.mockResolvedValue({ ok: true, sent: true, kind: 'learning-pack' } as never);
    await call({ kind: 'learning-pack', confirm: true });
    expect(auditM).toHaveBeenCalledTimes(1);
    expect(String(auditM.mock.calls[0]![3]?.reason)).toMatch(/platform:contribute \(learning-pack\)/);
  });
});
