/**
 * Unit tests for resolveAgentIdentity (L1 identity primitive).
 *
 * Pure logic — no PG, no operator. Run:
 *   npx vitest run lib/agent-tools/coordination/__tests__/identity.test.ts
 */

import { describe, expect, it } from 'vitest';
import { resolveAgentIdentity } from '../identity';

const POWER_USER_ID = 'pus-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const BARE_UUID = '28dbf719-9a3c-4f1e-8b2d-7c6a5e4d3b2a';

describe('resolveAgentIdentity — power-user tier', () => {
  it('takes ownerId from uiClientId (the auth_session_id)', () => {
    const id = resolveAgentIdentity({
      isPowerUser: true,
      uiClientId: POWER_USER_ID,
      workspaceId: 'ws-42',
      userId: 'user-7',
    });
    expect(id.ownerId).toBe(POWER_USER_ID);
    expect(id.source).toBe('power-user-token');
    expect(id.workspaceId).toBe('ws-42');
    expect(id.userId).toBe('user-7');
    expect(id.ownerLabel).toBe('omp · pus-1a2b3c4d');
  });

  it('throws when a power-user ctx has no uiClientId', () => {
    expect(() =>
      resolveAgentIdentity({ isPowerUser: true, uiClientId: null }),
    ).toThrow(/missing uiClientId/);
  });

  it('does not fall through to superuser logic when isPowerUser', () => {
    // Both flags set (isSuperuser is true for power-user ctx in the
    // route) — power-user must win, and the source proves it.
    const id = resolveAgentIdentity({
      isPowerUser: true,
      isSuperuser: true,
      uiClientId: POWER_USER_ID,
    });
    expect(id.source).toBe('power-user-token');
  });
});

describe('resolveAgentIdentity — superuser tier', () => {
  it('treats a per-session id as omp-hook-session', () => {
    const id = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: 'sess-abcd1234',
    });
    expect(id.ownerId).toBe('sess-abcd1234');
    expect(id.source).toBe('omp-hook-session');
    expect(id.ownerLabel).toBe('su · sess-abc');
  });

  it('treats a bare ?client= machine UUID as static-client', () => {
    const id = resolveAgentIdentity({
      isSuperuser: true,
      uiClientId: BARE_UUID,
    });
    expect(id.ownerId).toBe(BARE_UUID);
    expect(id.source).toBe('static-client');
  });

  it('resolves to the su-loopback fallback (not a throw) when uiClientId is absent (EI-2127)', () => {
    // EI-2127 / EI-334: a superuser that carries no per-session id (no
    // Mcp-Session-Id, no ?client=) is still attributable — admission already
    // proved the machine admin — so the resolver returns the stable
    // SUPERUSER_FALLBACK_CLIENT_ID ('su-loopback') instead of throwing.
    // Throwing here broke every identity-resolving tool (coord:whoami, locks:*,
    // db:next-migration, …) from a client-less superuser context. See the source
    // comment on SUPERUSER_FALLBACK_CLIENT_ID for the full rationale.
    const id = resolveAgentIdentity({ isSuperuser: true });
    expect(id.ownerId).toBe('su-loopback');
    expect(id.source).toBe('omp-hook-session');
  });
});

describe('resolveAgentIdentity — principal (in-process) caller', () => {
  it('falls back to principal.slug when there is no uiClientId', () => {
    const id = resolveAgentIdentity({
      principal: { kind: 'service', slug: 'operator', workspaceId: 'ws-1' },
    });
    expect(id.ownerId).toBe('operator');
    expect(id.source).toBe('principal');
    expect(id.workspaceId).toBe('ws-1');
  });

  it('prefers uiClientId over principal.slug when both are present', () => {
    const id = resolveAgentIdentity({
      uiClientId: 'sess-xyz',
      principal: { kind: 'user', slug: 'alice', workspaceId: 'ws-1' },
    });
    expect(id.ownerId).toBe('sess-xyz');
  });
});

describe('resolveAgentIdentity — unattributable ctx', () => {
  it('throws when there is no power-user / superuser / principal', () => {
    expect(() => resolveAgentIdentity({})).toThrow(/cannot be attributed/);
  });
});
