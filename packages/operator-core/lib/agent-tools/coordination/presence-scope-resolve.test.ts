/**
 * resolvePresenceScope — targetedOwner default-widen tests (EI-18653888556683414).
 *
 * Repro: a targeted `{ owner }` point-lookup (coord:presence / coord:roster)
 * used to default to the generic browse-roster scope ('hive'), so a caller
 * with a mapped harness (a real hiveFilter resolved) would silently exclude a
 * genuinely LIVE peer registered under a different Hive — the empty roster
 * was indistinguishable from "no such agent ever existed" and nearly caused a
 * live work-item claim to be force-released as orphaned.
 *
 * Fix: `targetedOwner: true` changes ONLY the *default* scope to 'workspace'
 * when the caller passed neither `scope` nor `hive` explicitly. An explicit
 * `scope` or `hive` argument is honored exactly as before, targeted or not.
 */
import { describe, it, expect } from 'vitest';
import { resolvePresenceScope } from './presence-snapshot';

describe('resolvePresenceScope — targetedOwner default widen', () => {
  it('targetedOwner:true + no explicit scope/hive → defaults to workspace scope, with a scopeNote explaining the widen', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      { targetedOwner: true },
    );
    expect(resolved.scope).toBe('workspace');
    expect(resolved.wsId).toBe('ws-1');
    expect(resolved.potId).toBeNull();
    expect(resolved.scopeNote).toMatch(/targeted owner lookup/i);
  });

  it('targetedOwner:true + explicit scope:"hive" still honors hive scope (no silent override)', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      { targetedOwner: true, scope: 'hive', hive: 'explicit-hive' },
    );
    expect(resolved.scope).toBe('hive');
    expect(resolved.potId).toBe('explicit-hive');
    // Explicit scope/hive path never sets the workspace-widen note.
    expect(resolved.scopeNote).toBeUndefined();
  });

  it('targetedOwner:true + explicit hive (no scope arg) still resolves hive scope via the hive arg', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      { targetedOwner: true, hive: 'explicit-hive' },
    );
    expect(resolved.scope).toBe('hive');
    expect(resolved.potId).toBe('explicit-hive');
    expect(resolved.scopeNote).toBeUndefined();
  });

  it('targetedOwner:true + explicit scope:"workspace" resolves workspace with no widen note (already explicit)', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      { targetedOwner: true, scope: 'workspace' },
    );
    expect(resolved.scope).toBe('workspace');
    expect(resolved.scopeNote).toBeUndefined();
  });

  it('targetedOwner:true + scope:"all" is left unchanged (no filters, no note)', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      { targetedOwner: true, scope: 'all' },
    );
    expect(resolved.scope).toBe('all');
    expect(resolved.wsId).toBeNull();
    expect(resolved.potId).toBeNull();
    expect(resolved.scopeNote).toBeUndefined();
  });

  it('default (targetedOwner absent/false) is UNCHANGED: still defaults to hive scope', async () => {
    const resolved = await resolvePresenceScope(
      { workspaceId: 'ws-1', harnessSlug: undefined },
      {},
    );
    expect(resolved.scope).toBe('hive');
    // No harness → no hiveFilter resolvable → falls back to workspace scope note (pre-existing behavior).
    expect(resolved.scopeNote).toMatch(/no Hive/i);
  });
});
