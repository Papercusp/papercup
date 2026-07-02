/**
 * P-001 (p2p-work-distribution-2026-07-02) unit tests: capability vocabulary /
 * presets, the C3 workspace resolver (WI-1564 class — write/capture/drain must
 * agree on the partition, and a grant write under the un-federating 'default'
 * partition is REFUSED loudly, never fail-soft), and the store's refusal paths
 * (all of which must return BEFORE any SQL touch — asserted with a throwing
 * sql stub).
 */
import { describe, expect, it } from 'vitest';
import {
  P2P_CAPABILITIES,
  P2P_PRESETS,
  SPAWN_CLASS_CAPABILITIES,
  expandPreset,
  isP2pCapability,
  isP2pGranteeKind,
  normalizeCapabilities,
} from './capabilities';
import { resolveP2pGrantWorkspace, setPeerGrant, revokePeerGrant, checkP2pCapability } from './grant-store';
import type { OrgSql } from '../work-items';

/** A sql stub that FAILS the test if any query executes. */
const throwingSql = (() => {
  const fn = () => {
    throw new Error('refusal paths must not touch SQL');
  };
  (fn as unknown as { begin: unknown }).begin = fn;
  return fn as unknown as OrgSql;
})();

describe('p2p capabilities + presets (the plan item is the spec)', () => {
  it('vocabulary is exactly the item set', () => {
    expect([...P2P_CAPABILITIES]).toEqual([
      'chat',
      'steer',
      'work-offer',
      'wake',
      'spawn',
      'read-artifacts',
    ]);
  });

  it('presets are cumulative per the item text; read-artifacts is in NO preset', () => {
    expect(P2P_PRESETS.observer).toEqual(['chat']);
    expect(P2P_PRESETS.collaborator).toEqual(['chat', 'steer']);
    expect(P2P_PRESETS.delegate).toEqual(['chat', 'steer', 'work-offer', 'wake']);
    expect(P2P_PRESETS.operator).toEqual(['chat', 'steer', 'work-offer', 'wake', 'spawn']);
    for (const caps of Object.values(P2P_PRESETS)) {
      expect(caps).not.toContain('read-artifacts');
    }
    expect(expandPreset('delegate')).toEqual(['chat', 'steer', 'work-offer', 'wake']);
  });

  it('normalizeCapabilities REFUSES unknown entries loudly (D-004) and dedups', () => {
    const bad = normalizeCapabilities(['chat', 'sudo', 'spawn ']);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.invalid).toEqual(['sudo', 'spawn ']);
    const good = normalizeCapabilities(['spawn', 'chat', 'chat']);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.capabilities).toEqual(['chat', 'spawn']); // canonical order
  });

  it('spawn-class = the foreign-execution capabilities (X6 epoch-gated)', () => {
    expect(SPAWN_CLASS_CAPABILITIES.has('spawn')).toBe(true);
    expect(SPAWN_CLASS_CAPABILITIES.has('work-offer')).toBe(true);
    expect(SPAWN_CLASS_CAPABILITIES.has('chat')).toBe(false);
    expect(SPAWN_CLASS_CAPABILITIES.has('wake')).toBe(false); // M9 rate-cap, not epoch
  });

  it('grantee kinds are the D-010 polymorphic pair', () => {
    expect(isP2pGranteeKind('fleet')).toBe(true);
    expect(isP2pGranteeKind('pool')).toBe(true);
    expect(isP2pGranteeKind('user')).toBe(false);
    expect(isP2pCapability('chat')).toBe(true);
  });
});

describe('resolveP2pGrantWorkspace (C3 / WI-1564: one resolver for writer+reader+enforcer)', () => {
  it('passes a concrete workspace through', () => {
    expect(resolveP2pGrantWorkspace('ws-papercusp')).toBe('ws-papercusp');
  });
  it("null / '*' / empty / whitespace are unresolvable", () => {
    expect(resolveP2pGrantWorkspace(null)).toBeUndefined();
    expect(resolveP2pGrantWorkspace(undefined)).toBeUndefined();
    expect(resolveP2pGrantWorkspace('*')).toBeUndefined();
    expect(resolveP2pGrantWorkspace('')).toBeUndefined();
    expect(resolveP2pGrantWorkspace('  ')).toBeUndefined();
  });
  it("the legacy 'default' partition is unresolvable — the WI-1564 strand combo (no booted drain handle serves it)", () => {
    expect(resolveP2pGrantWorkspace('default')).toBeUndefined();
  });
});

describe('grant-store refusal paths (loud, structured, SQL-free)', () => {
  const base = {
    hiveSlug: 'papercup-hive',
    grantorGithubUserId: 12345,
    granteeKind: 'fleet' as const,
    granteeRef: 'p2p-dist',
    capabilities: ['chat'],
  };

  it("setPeerGrant REFUSES an unresolvable workspace (incl. 'default') — a stranded grant/revocation is a security hole, not a warning", async () => {
    for (const ws of [null, 'default', '*']) {
      const r = await setPeerGrant({ ...base, workspaceId: ws }, throwingSql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('workspace_unresolved');
    }
  });

  it('setPeerGrant refuses invalid grantee kind / missing ref / non-numeric grantor / unknown capability', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ granteeKind: 'user' }, 'invalid_grantee_kind'],
      [{ granteeRef: '  ' }, 'grantee_required'],
      [{ grantorGithubUserId: 0 }, 'invalid_grantor'],
      [{ grantorGithubUserId: 1.5 }, 'invalid_grantor'],
      [{ capabilities: ['chat', 'root'] }, 'invalid_capabilities'],
      [{ hiveSlug: '' }, 'hive_required'],
    ];
    for (const [override, code] of cases) {
      const r = await setPeerGrant(
        { ...base, workspaceId: 'ws-1', ...override } as Parameters<typeof setPeerGrant>[0],
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe(code);
    }
  });

  it('revokePeerGrant refuses an unresolvable workspace (a revocation MUST federate)', async () => {
    const r = await revokePeerGrant(
      { workspaceId: 'default', hiveSlug: 'h', grantorGithubUserId: 1, granteeKind: 'fleet', granteeRef: 'f' },
      throwingSql,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('workspace_unresolved');
  });

  it('checkP2pCapability fails CLOSED on an unresolvable workspace, naming the missing capability (P-004 receipt content)', async () => {
    const r = await checkP2pCapability(
      {
        workspaceId: undefined,
        hiveSlug: 'h',
        grantorGithubUserId: 1,
        granteeKind: 'fleet',
        granteeRef: 'f',
        capability: 'spawn',
      },
      throwingSql,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.code).toBe('workspace_unresolved');
      expect(r.refusal.missing).toBe('spawn');
    }
  });
});
