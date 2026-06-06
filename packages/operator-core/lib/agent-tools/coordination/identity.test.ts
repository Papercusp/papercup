/**
 * Unit tests for resolveAgentIdentity — the coordination identity primitive (L1).
 *
 * THE UMBILICAL (voice-gap fix): the `fleet-spawn` branch is the load-bearing case
 * here. A fleet:spawn bee connects over a SIGNED MCP URL — NOT superuser, NOT
 * power-user, NO bearer principal — carrying its operator-assigned `s-…` spawnId as
 * the `client=` param (→ ctx.uiClientId). Before that branch existed the resolver
 * threw "cannot be attributed" and every coord:send / plans:set-status /
 * improvements:capture from a bee failed (the "MUTE bee"): file edits landed, but
 * the child could not speak on coord. These tests pin that the bee now resolves a
 * stable coord owner, AND that a truly unattributable ctx still hard-errors.
 */
import { describe, expect, it } from 'vitest';
import { resolveAgentIdentity } from './identity';

describe('resolveAgentIdentity — fleet:spawn child (THE UMBILICAL)', () => {
  it('attributes a role-gated signed spawn ctx to its `s-…` client id (was: threw → MUTE bee)', () => {
    // The shape the MCP handler builds for a fleet:spawn bee: a verified signed
    // spawn ctx, no superuser/power-user/principal, `client=s-…` → uiClientId.
    const id = resolveAgentIdentity({
      uiClientId: 's-1780000000000-deadbeef',
      isSuperuser: false,
      isPowerUser: false,
      workspaceId: 'ws-1',
    });
    expect(id.ownerId).toBe('s-1780000000000-deadbeef');
    expect(id.source).toBe('fleet-spawn');
    expect(id.workspaceId).toBe('ws-1');
    expect(id.ownerLabel).toMatch(/^bee · /);
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
