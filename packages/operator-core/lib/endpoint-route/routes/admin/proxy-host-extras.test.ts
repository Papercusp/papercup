/**
 * WI-5364 regression — the admin in-process tool proxies MUST carry a
 * `runScoped` that hands the tool handler a real DB handle as `ctx.tx`.
 *
 * Before this module existed, all five /api/admin/* proxies copy-pasted a
 * `{ deps, log, validateSuperuser }` extras with NO runScoped and NO
 * resolvePrincipalAndTx — so the tooldef-http adapter left `ctx.tx`
 * undefined and the first proxied handler to use it (`sessions:list`,
 * owner-inbox-single-pane P-007) 500'd "ctx.tx is not a function" on every
 * conversation-popup open. This test pins the seam so the class can't come
 * back with the next allowlisted tx-using verb.
 */
import { describe, expect, it, vi } from 'vitest';

const FAKE_SQL = Object.assign(() => Promise.resolve([]), { __fake: 'org-sql' });

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: FAKE_SQL }),
}));

// PROJECTED_DEPS drags in the whole agent-tools/bootstrap world at module
// scope (generated-schema reads crash under a unit mock) — the seam under
// test only passes it through, so stub it out.
vi.mock('../../../projected-tool-deps', () => ({ PROJECTED_DEPS: {} }));

import { ADMIN_PROXY_HOST_EXTRAS } from './proxy-host-extras';

describe('ADMIN_PROXY_HOST_EXTRAS (WI-5364)', () => {
  it('declares the runScoped seam at all', () => {
    expect(typeof ADMIN_PROXY_HOST_EXTRAS.runScoped).toBe('function');
  });

  it('hands the tool dispatch the admin org-pg handle as tx', async () => {
    const seen: unknown[] = [];
    const result = await ADMIN_PROXY_HOST_EXTRAS.runScoped!(
      // Scope is irrelevant on this path — the admin mounts always dispatch
      // superuser=1, so the handle choice is unconditionally admin.
      { tool: { crossWorkspace: false }, principal: undefined, workspaceId: undefined, isSuperuser: true } as never,
      async (tx) => {
        seen.push(tx);
        return 'ran';
      },
    );
    expect(result).toBe('ran');
    expect(seen).toEqual([FAKE_SQL]);
  });
});
