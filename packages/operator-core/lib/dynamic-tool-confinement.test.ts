/**
 * dynamic-tool-confinement.test — the ADVERSARIAL PROOF for P-003 (design D-003): a
 * confined dynamic tool provably CANNOT escape its filesystem allowlist, reach a denied
 * network host, escalate beyond its declared capabilities, or mint/grant itself new power.
 * D-003 requires this proof before any runtime tier is opened. Pure — no DB, no fs.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveDynamicToolEnvelope,
  checkConfinedCapability,
  checkConfinedPath,
  checkConfinedDomain,
  isForbiddenDynamicCapability,
  DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS,
  type DynamicToolConfinement,
} from './dynamic-tool-confinement';
import type { RoleEnvelope } from './capability-envelope/policy';

const DECL: DynamicToolConfinement = {
  capabilities: ['net:fetch', 'intel:read'],
  allowPathGlobs: ['/data/oddsmith/**'],
  allowDomains: ['api.oddsmith.com'],
};

function envOf(declared: DynamicToolConfinement, role?: RoleEnvelope) {
  const r = deriveDynamicToolEnvelope(declared, role);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.message}`);
  return r.envelope;
}

describe('P-003 adversarial — NO CAPABILITY MINTING / ESCALATION', () => {
  for (const mint of [
    'capability:grant-role',
    'capability:grant_role',
    'capability:revoke-role',
    'capability:envelope_set_role',
    'capability:set-tier',
    'meta:define-tool',
    'meta:define-datatype',
    'tools:scaffold',
    'platform:contribute',
    'secrets:read',
    'processes:kill',
    'fleet:spawn',
  ]) {
    it(`a tool declaring "${mint}" is REJECTED at derivation (mints_capability)`, () => {
      const r = deriveDynamicToolEnvelope({ capabilities: ['intel:read', mint] });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toBe('mints_capability');
      expect(r.offending).toBe(mint);
    });
    it(`the forbidden floor recognizes "${mint}"`, () => {
      expect(isForbiddenDynamicCapability(mint)).toBe(true);
    });
  }

  it('even if a forbidden cap leaked into the allow set, the runtime check DENIES it (deny wins)', () => {
    // Construct an envelope by hand with a minting cap wrongly in `allowCapabilities` —
    // the deny floor must still win at exercise time (defense in depth).
    const env = { allowCapabilities: ['capability:grant-role'], denyCapabilities: DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS, allowPathGlobs: [], allowDomains: [] };
    expect(checkConfinedCapability(env, 'capability:grant-role').allow).toBe(false);
  });

  it('an ordinary declared capability is allowed; an UNdeclared one is denied (no escalation)', () => {
    const env = envOf(DECL);
    expect(checkConfinedCapability(env, 'net:fetch').allow).toBe(true);
    expect(checkConfinedCapability(env, 'intel:read').allow).toBe(true);
    expect(checkConfinedCapability(env, 'intel:write').allow).toBe(false); // never declared → no escalation
    expect(checkConfinedCapability(env, 'capability:bash').allow).toBe(false);
  });
});

describe('P-003 adversarial — NO FILESYSTEM ESCAPE', () => {
  const env = envOf(DECL);

  it('allows a path inside the declared glob', () => {
    expect(checkConfinedPath(env, '/data/oddsmith/bets/b1.json').allow).toBe(true);
  });

  it('denies an absolute path outside the allowlist', () => {
    expect(checkConfinedPath(env, '/etc/passwd').allow).toBe(false);
  });

  it('denies a ".." traversal even though the prefix matches the glob (the naive-allowlist hole)', () => {
    const r = checkConfinedPath(env, '/data/oddsmith/../../etc/passwd');
    expect(r.allow).toBe(false);
    if (r.allow) throw new Error('unreachable');
    expect(r.reason).toMatch(/traversal/);
  });

  it('denies a sneaky middle traversal and a backslash traversal', () => {
    expect(checkConfinedPath(env, '/data/oddsmith/x/../../../root/.ssh/id_rsa').allow).toBe(false);
    expect(checkConfinedPath(env, '\\data\\oddsmith\\..\\..\\secret').allow).toBe(false);
  });

  it('a tool that declared NO fs access cannot touch any path', () => {
    const noFs = envOf({ capabilities: ['intel:read'] });
    expect(checkConfinedPath(noFs, '/data/oddsmith/x').allow).toBe(false);
  });
});

describe('P-003 adversarial — NO DENIED-HOST NETWORK', () => {
  const env = envOf(DECL);

  it('allows the declared domain', () => {
    expect(checkConfinedDomain(env, 'api.oddsmith.com').allow).toBe(true);
  });

  it('denies an unrelated host and a suffix-confusion host', () => {
    expect(checkConfinedDomain(env, 'evil.com').allow).toBe(false);
    expect(checkConfinedDomain(env, 'api.oddsmith.com.evil.com').allow).toBe(false); // not an exact match
  });

  it('a wildcard domain allow still rejects a suffix-trick host', () => {
    const wild = envOf({ capabilities: ['net:fetch'], allowDomains: ['*.oddsmith.com'] });
    expect(checkConfinedDomain(wild, 'api.oddsmith.com').allow).toBe(true);
    expect(checkConfinedDomain(wild, 'oddsmith.com.evil.com').allow).toBe(false);
  });

  it('a tool that declared NO network cannot reach any host', () => {
    const noNet = envOf({ capabilities: ['intel:read'] });
    expect(checkConfinedDomain(noNet, 'api.oddsmith.com').allow).toBe(false);
  });
});

describe('P-003 — NARROW-ONLY vs the host role (cannot widen)', () => {
  it('rejects a capability outside a constraining role allowlist', () => {
    const role: RoleEnvelope = { allowCapabilities: ['intel:read'] };
    const r = deriveDynamicToolEnvelope({ capabilities: ['intel:read', 'net:fetch'] }, role);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('widens_role');
    expect(r.offending).toBe('net:fetch');
  });

  it('rejects a capability the role denies', () => {
    const role: RoleEnvelope = { denyCapabilities: ['capability:bash'] };
    const r = deriveDynamicToolEnvelope({ capabilities: ['capability:bash'] }, role);
    expect(r.ok).toBe(false);
  });

  it('rejects a path / domain outside a constraining role', () => {
    const role: RoleEnvelope = { allowPathGlobs: ['/data/**'], allowDomains: ['*.oddsmith.com'] };
    expect(deriveDynamicToolEnvelope({ capabilities: ['intel:read'], allowPathGlobs: ['/etc/**'] }, role).ok).toBe(false);
    expect(deriveDynamicToolEnvelope({ capabilities: ['net:fetch'], allowDomains: ['evil.com'] }, role).ok).toBe(false);
  });

  it('a default-allow role (no constraints) lets the declaration stand (minus the floor)', () => {
    const r = deriveDynamicToolEnvelope(DECL, { allowCapabilities: ['*'] });
    expect(r.ok).toBe(true);
  });

  it('a declaration WITHIN the role is accepted and narrowed', () => {
    const role: RoleEnvelope = { allowCapabilities: ['intel:*', 'net:fetch'], allowPathGlobs: ['/data/**'] };
    const env = envOf({ capabilities: ['intel:read', 'net:fetch'], allowPathGlobs: ['/data/oddsmith/**'] }, role);
    expect(env.allowCapabilities).toEqual(['intel:read', 'net:fetch']);
    expect(checkConfinedCapability(env, 'intel:write').allow).toBe(false); // role allowed intel:* but the TOOL only declared intel:read
  });
});

describe('P-003 — derivation guards', () => {
  it('an empty capability declaration is rejected (not "allow all")', () => {
    const r = deriveDynamicToolEnvelope({ capabilities: [] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('empty_capabilities');
  });

  it('the derived envelope always carries the full forbidden floor in its denies', () => {
    const env = envOf(DECL);
    for (const g of DYNAMIC_TOOL_FORBIDDEN_CAPABILITY_GLOBS) {
      expect(env.denyCapabilities).toContain(g);
    }
  });
});
