/**
 * restart-preflight.test.ts — EI-18661647550414959.
 *
 * The whole value of this guard is that it must not FAIL OPEN SILENTLY. Every case
 * below exists because the naive wiring passes a plausible-looking check while
 * inspecting nothing, and the two shapes are indistinguishable from `ok:true` alone:
 *
 *   - a WorkingDirectory that is a subdirectory of the tree (4 of 5 real targets),
 *   - a unit systemd does not know (`systemctl show` exits 0 with an empty value),
 *   - a target running from a DIFFERENT checkout than the one this code loaded from.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/restart-preflight.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

import { preflightRestartTarget } from './restart-preflight';
import { RESTART_TARGET_UNITS } from './restart-target-units';
import { preflightTreeAt, type LockTreeDriftCheck } from '../../boot-integrity-preflight';

const cleanDrift = (): LockTreeDriftCheck => ({ ok: true, missing: [], extraneous: [], skipped: false });
const okResolver = () => '/resolved';

describe('preflightRestartTarget — resolving the target tree', () => {
  it('preflights the tree at the unit WorkingDirectory', async () => {
    const preflight = vi.fn(() => ({
      checked: true,
      ok: true,
      requestedRoot: '/tree/apps/operator',
      lockRoot: '/tree',
      missing: [],
      extraneous: [],
      note: 'clean',
    }));
    const r = await preflightRestartTarget('bg-host', {
      readUnitProperty: async () => '/tree/apps/operator',
      preflight: preflight as unknown as typeof preflightTreeAt,
    });
    expect(preflight).toHaveBeenCalledWith({ rootDir: '/tree/apps/operator' });
    expect(r.unit).toBe(RESTART_TARGET_UNITS['bg-host']);
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('maps mcp-proxy to its supervised unit before preflighting the integration tree', async () => {
    const readUnitProperty = vi.fn(async () => '/integration/apps/operator');
    const preflight = vi.fn(() => ({
      checked: true,
      ok: true,
      requestedRoot: '/integration/apps/operator',
      lockRoot: '/integration',
      missing: [],
      extraneous: [],
      note: 'clean',
    }));

    const r = await preflightRestartTarget('mcp-proxy', {
      readUnitProperty,
      preflight: preflight as unknown as typeof preflightTreeAt,
    });

    expect(readUnitProperty).toHaveBeenCalledWith('papercup-mcp-proxy.service', 'WorkingDirectory');
    expect(preflight).toHaveBeenCalledWith({ rootDir: '/integration/apps/operator' });
    expect(r.unit).toBe(RESTART_TARGET_UNITS['mcp-proxy']);
  });

  // `systemctl --user show <unknown-unit>` exits 0 and prints nothing. Reading that as
  // a clean bill would silently disable this guard for a renamed/typo'd unit.
  it.each([
    ['an empty value (unknown unit)', ''],
    ['the literal [not set]', '[not set]'],
  ])('reports NOT CHECKED — never clean — when WorkingDirectory is %s', async (_label, value) => {
    const preflight = vi.fn();
    const r = await preflightRestartTarget('dev', {
      readUnitProperty: async () => value,
      preflight: preflight as unknown as typeof preflightTreeAt,
    });
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true); // fails OPEN — a guard that cannot run never blocks
    expect(preflight).not.toHaveBeenCalled();
    expect(r.note).toContain('NOT CHECKED');
    expect(r.note).toContain('not a clean bill');
  });

  it('fails OPEN and reports NOT CHECKED when the systemctl probe throws', async () => {
    const r = await preflightRestartTarget('gateway', {
      readUnitProperty: async () => {
        throw new Error('systemctl: connection refused\nsecond line');
      },
      preflight: (() => {
        throw new Error('must not be called');
      }) as unknown as typeof preflightTreeAt,
    });
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('connection refused');
    expect(r.reason).not.toContain('second line'); // first line only
  });

  it('surfaces a real inconsistency as a blocking verdict', async () => {
    const r = await preflightRestartTarget('dev', {
      readUnitProperty: async () => '/release/apps/operator',
      preflight: (() => ({
        checked: true,
        ok: false,
        requestedRoot: '/release/apps/operator',
        lockRoot: '/release',
        missing: ['hono', 'postgres'],
        extraneous: [],
        note: 'INCONSISTENT',
      })) as unknown as typeof preflightTreeAt,
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['hono', 'postgres']);
  });
});

describe('preflightTreeAt — the subdirectory trap', () => {
  // THE central regression. package-lock.json sits at the tree ROOT, but a unit's
  // WorkingDirectory is <root>/apps/operator for 4 of the 5 real restart targets.
  // checkLockTreeDrift does NOT walk up from an explicit rootDir, so wiring the
  // WorkingDirectory straight through returns {skipped:true, ok:true} — a guard that
  // inspects nothing and reports clean.
  it('walks UP from a subdirectory to the tree that carries package-lock.json', () => {
    const driftCheck = vi.fn(() => cleanDrift());
    const r = preflightTreeAt({
      rootDir: '/tree/apps/operator',
      lockRootFor: (start) => (start === '/tree/apps/operator' ? '/tree' : null),
      driftCheck,
      resolve: okResolver,
    });
    expect(driftCheck).toHaveBeenCalledWith('/tree'); // the ROOT, not the subdir
    expect(r.lockRoot).toBe('/tree');
    expect(r.checked).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('reports NOT CHECKED — not clean — when no ancestor carries a lockfile', () => {
    const r = preflightTreeAt({ rootDir: '/nowhere', lockRootFor: () => null, resolve: okResolver });
    expect(r.checked).toBe(false);
    expect(r.ok).toBe(true); // fails open
    expect(r.lockRoot).toBeNull();
    expect(r.note).toContain('NOT CHECKED');
    expect(r.note).toContain('not a clean bill');
  });

  it('unions lock-drift and sentinel misses into one verdict', () => {
    const r = preflightTreeAt({
      rootDir: '/tree',
      lockRootFor: () => '/tree',
      driftCheck: () => ({ ok: false, missing: ['left-pad'], extraneous: ['stale-pkg'], skipped: false }),
      resolve: (id) => {
        if (id === 'hono') throw new Error("Cannot find module 'hono'");
        return '/resolved';
      },
      modules: ['hono', 'postgres'],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['left-pad', 'hono']));
    expect(r.extraneous).toEqual(['stale-pkg']);
    expect(r.note).toContain('INCONSISTENT');
  });

  // The asymmetry: a POSITIVE detection survives a partial inspection, a CLEAN BILL
  // does not. A skipped drift leg must never upgrade "nothing found" to "verified".
  it('still reports a sentinel miss when the drift leg was skipped', () => {
    const r = preflightTreeAt({
      rootDir: '/tree',
      lockRootFor: () => '/tree',
      driftCheck: () => ({ ok: true, missing: [], extraneous: [], skipped: true, error: 'lockfile unreadable' }),
      resolve: (id) => {
        if (id === 'hono') throw new Error("Cannot find module 'hono'");
        return '/resolved';
      },
      modules: ['hono'],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['hono']);
  });

  it('does NOT claim a clean bill when the drift leg was skipped and nothing was found', () => {
    const r = preflightTreeAt({
      rootDir: '/tree',
      lockRootFor: () => '/tree',
      driftCheck: () => ({ ok: true, missing: [], extraneous: [], skipped: true, error: 'lockfile unreadable' }),
      resolve: okResolver,
      modules: ['hono'],
    });
    expect(r.ok).toBe(true); // nothing blocking
    expect(r.checked).toBe(false); // ...but NOT verified
    expect(r.reason).toContain('lockfile unreadable');
    expect(r.note).toContain('PARTIALLY CHECKED');
  });

  it('extraneous packages never block — they are a future prune, not a breakage', () => {
    const r = preflightTreeAt({
      rootDir: '/tree',
      lockRootFor: () => '/tree',
      driftCheck: () => ({ ok: true, missing: [], extraneous: ['a', 'b'], skipped: false }),
      resolve: okResolver,
    });
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(true);
    expect(r.extraneous).toEqual(['a', 'b']);
  });
});

describe('preflightTreeAt — anchors resolution to the tree under test', () => {
  // The `dev` target runs from papercup-release while this code is normally loaded from
  // the staging checkout. A resolver anchored at the WRONG tree would audit the wrong
  // node_modules and pass a broken release, which is the exact failure this guards.
  it('resolves against lockRoot, not against this module location', () => {
    const seen: string[] = [];
    preflightTreeAt({
      rootDir: '/release/apps/operator',
      lockRootFor: () => '/release',
      driftCheck: () => cleanDrift(),
      resolve: (id) => {
        seen.push(id);
        return '/release/node_modules/' + id;
      },
      modules: ['hono'],
    });
    expect(seen).toEqual(['hono']);
  });
});
