/**
 * Unit tests for resolveAgentIdentity — the coordination identity primitive (L1).
 *
 * THE UMBILICAL (voice-gap fix): the `fleet-spawn` branch is the load-bearing case
 * here. A bee:spawn bee connects over a SIGNED MCP URL — NOT superuser, NOT
 * power-user, NO bearer principal — carrying its operator-assigned `s-…` spawnId as
 * the `client=` param (→ ctx.uiClientId). Before that branch existed the resolver
 * threw "cannot be attributed" and every coord:send / plans:set-status /
 * improvements:capture from a bee failed (the "MUTE bee"): file edits landed, but
 * the child could not speak on coord. These tests pin that the bee now resolves a
 * stable coord owner, AND that a truly unattributable ctx still hard-errors.
 */
import { describe, expect, it } from 'vitest';
import { resolveAgentIdentity, SUPERUSER_FALLBACK_CLIENT_ID } from './identity';

describe('resolveAgentIdentity — bee:spawn child (THE UMBILICAL)', () => {
  it('attributes a role-gated signed spawn ctx to its `s-…` client id (was: threw → MUTE bee)', () => {
    // The shape the MCP handler builds for a bee:spawn bee: a VERIFIED signed
    // spawn ctx (sigVerifiedSpawn = the HMAC checked, covering the client=
    // param), no superuser/power-user/principal, `client=s-…` → uiClientId.
    const id = resolveAgentIdentity({
      uiClientId: 's-1780000000000-deadbeef',
      sigVerifiedSpawn: true,
      isSuperuser: false,
      isPowerUser: false,
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('s-1780000000000-deadbeef');
    expect(id.source).toBe('fleet-spawn');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.ownerLabel).toMatch(/^bee · /);
  });

  it('EI-318: a bare UNVERIFIED client= (the public HTTP catch-all) is NOT an identity — it hard-errors', () => {
    // The exact forge vector: a loopback `curl /api/agent-tools/...?client=<id>`
    // reaches the resolver with uiClientId set but sigVerifiedSpawn unset (the
    // HTTP catch-all never verifies the spawn HMAC). Trusting it let a degraded
    // bee attribute claims to its run-id (EI-311). Now it is rejected, so the
    // write fails loud instead of impersonating an agent.
    expect(() =>
      resolveAgentIdentity({ uiClientId: 'opspawn-1781159617676-c9a28a', workspaceId: 'ws-1' }),
    ).toThrow(/cannot be attributed/);
    // Explicit false is rejected the same as absent.
    expect(() =>
      resolveAgentIdentity({ uiClientId: 's-forged', sigVerifiedSpawn: false }),
    ).toThrow(/cannot be attributed/);
  });

  it('a superuser ctx still wins over the fleet-spawn fallback', () => {
    const id = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: 'su-abc123',
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.source).toBe('omp-hook-session');
  });

  it('a principal-gated caller still wins over the fleet-spawn fallback', () => {
    const id = resolveAgentIdentity({
      principal: { kind: 'system', slug: 'autoloop', workspaceId: 'ws-2' },
    });
    expect(id.ownerId).toBe('autoloop');
    expect(id.source).toBe('principal');
  });

  it('still hard-errors when the ctx carries NO attributable identity at all', () => {
    expect(() => resolveAgentIdentity({})).toThrow(/cannot be attributed/);
    // An empty-string client is not an identity either.
    expect(() => resolveAgentIdentity({ uiClientId: '' })).toThrow(/cannot be attributed/);
  });
});

describe('resolveAgentIdentity — verified signed spawn without client= (invoke-route agents, D-002 option c)', () => {
  it('attributes a VERIFIED signed spawn with no client= to the stable harness slug', () => {
    // The shape the MCP handler builds for an invoke-route agent (promote/
    // scoper/expert): sig verified, harness present, NO client= → no uiClientId.
    const id = resolveAgentIdentity({
      sigVerifiedSpawn: true,
      harnessSlug: 'restart',
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('harness:restart');
    expect(id.ownerLabel).toBe('harness · restart');
    expect(id.source).toBe('signed-spawn');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.userId).toBeNull();
  });

  it('grants NOTHING to an unverified spawn ctx — unsigned soft-allow still hard-errors', () => {
    expect(() =>
      resolveAgentIdentity({ harnessSlug: 'restart', workspaceId: 'ws-1' }),
    ).toThrow(/cannot be attributed/);
    expect(() =>
      resolveAgentIdentity({ sigVerifiedSpawn: false, harnessSlug: 'restart' }),
    ).toThrow(/cannot be attributed/);
  });

  it('never mints an identity for the unscoped `*` harness session', () => {
    expect(() =>
      resolveAgentIdentity({ sigVerifiedSpawn: true, harnessSlug: '*' }),
    ).toThrow(/cannot be attributed/);
  });

  it('a client=-carrying bee:spawn child still wins over the harness attribution', () => {
    const id = resolveAgentIdentity({
      uiClientId: 's-1780000000000-deadbeef',
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(id.ownerId).toBe('s-1780000000000-deadbeef');
    expect(id.source).toBe('fleet-spawn');
  });

  it('EI-2127: an admitted superuser with NO uiClientId resolves the stable fallback id (was: threw → db:next-migration / coord:whoami / coord:send all failed)', () => {
    // The client-less superuser ctx the loopback HTTP bridge / in-process
    // superuser MCP call builds: isSuperuser true (admission already cleared the
    // loopback + bearer gate), but no Mcp-Session-Id and no ?client= → no
    // uiClientId. This used to throw "superuser context is missing uiClientId",
    // which deterministically broke every identity-resolving tool.
    const id = resolveAgentIdentity({ isSuperuser: true, workspaceId: 'ws-1' });
    expect(id.ownerId).toBe(SUPERUSER_FALLBACK_CLIENT_ID);
    expect(id.source).toBe('omp-hook-session');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.ownerLabel).toMatch(/^su · /);
  });

  it('EI-2127: an explicit superuser uiClientId still wins over the fallback', () => {
    // The fallback is the no-client case ONLY — a real per-session id always wins.
    const id = resolveAgentIdentity({ isSuperuser: true, uiClientId: 'su-abc123' });
    expect(id.ownerId).toBe('su-abc123');
    expect(id.ownerId).not.toBe(SUPERUSER_FALLBACK_CLIENT_ID);
    expect(id.source).toBe('omp-hook-session');
  });

  it('su / power / principal branches are unchanged by the new fields (no escalation)', () => {
    const su = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: 'su-x',
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(su.source).toBe('omp-hook-session');
    expect(su.ownerId).toBe('su-x');
    const pr = resolveAgentIdentity({
      principal: { kind: 'system', slug: 'autoloop', workspaceId: 'w' },
      sigVerifiedSpawn: true,
      harnessSlug: 'papercup',
    });
    expect(pr.source).toBe('principal');
    expect(pr.ownerId).toBe('autoloop');
  });
});
