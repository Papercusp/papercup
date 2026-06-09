/**
 * EI-4 — role-path SID binding — NOW FIXED (unify-launch-mechanics-2026-06-09
 * P-002). Was a documenting `it.todo` placeholder; the launch-spec primitive now
 * mints the sid and signs it as the MCP url's `client=`, so the contract is
 * runnable.
 *
 * The bug (resolved): bootstrap-role minted `sid = role-<uuid>` for the lock-hook
 * + coord owner, but buildRoleLaunchSpec signed the MCP url with NO `client=`, and
 * writeRoleCodexHome baked neither client nor sid — so a role session's lock-hook
 * owner (role-<uuid>) and its MCP-call owner (signed-spawn-derived) DIVERGED.
 *
 * The fix: buildRoleLaunchSpec mints the sid and signs `client=<sid>` (asserted
 * here); bootstrap-role uses `spec.sid` for PAPERCUSP_SID + passes it to
 * writeRoleCodexHome (asserted in bootstrap-role.test.ts + role-codex-home).
 * Contract: role MCP url `client=` === envelopeEnv.PAPERCUSP_SID === codex-home
 * baked client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: vi.fn(() => ({
    text: 'PROMPT',
    meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: '/proj/p', stateDir: '', harnessDir: '/h', runId: 'worker-1' },
  })),
}));
vi.mock('./spawn-signing', () => ({
  // Real-ish signer: keep ALL params (incl. client) and append exp+sig, so the
  // test can assert the client= survives into the signed url.
  signSpawnParams: vi.fn(async (params: URLSearchParams) => {
    params.set('exp', '9999999999');
    params.set('sig', 'TESTSIG');
    return { exp: 9999999999, sig: 'TESTSIG' };
  }),
}));
vi.mock('./spawn-config', () => ({
  resolveProjectDir: vi.fn(async (slug: string) => `/registry/${slug}`),
}));

import { buildRoleLaunchSpec } from './role-launch-spec';

beforeEach(() => vi.clearAllMocks());

describe('role launch: PAPERCUSP_SID is bound across hook/MCP/codex-home (EI-4 — FIXED)', () => {
  it('the signed role MCP url carries client === the minted sid', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });
    expect(spec.sid).toMatch(/^role-/);
    expect(new URL(spec.mcpUrl).searchParams.get('client')).toBe(spec.sid);
  });

  it('the sid is the same value bootstrap-role exports as PAPERCUSP_SID + passes to writeRoleCodexHome', async () => {
    // The primitive is the single source: bootstrap-role reads spec.sid for both
    // envelopeEnv.PAPERCUSP_SID and the writeRoleCodexHome `sid` arg (the codex
    // home bakes the already-signed url, which carries the same client=<sid>).
    // The end-to-end wiring is asserted in bootstrap-role.test.ts; here we pin
    // that the URL client and the spec.sid are one value.
    const spec = await buildRoleLaunchSpec({
      role: 'scoper',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://x',
    });
    const client = new URL(spec.mcpUrl).searchParams.get('client');
    expect(client).toBe(spec.sid);
  });
});
