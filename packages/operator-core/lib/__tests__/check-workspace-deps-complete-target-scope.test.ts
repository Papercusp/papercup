/**
 * Recurrence guard for EI-20028225708881148 — the TARGET-SIDE scope of
 * scripts/check-workspace-deps-complete.mjs.
 *
 * THE BUG THIS PINS. That guard answers "does a workspace import a local @papercusp/*
 * package without declaring it", which matters because affected-tests.mjs builds its
 * reverse-dependency walk from package.json. Its target-side test used to be
 *
 *     if (!byName.has(importedName)) continue;  // byName = ROOT WORKSPACES only
 *
 * with the comment "not a local workspace (published-only or typo) — out of scope". That
 * assumption is false for a package that exists on disk but was never added to
 * root.workspaces, and such edges were dropped SILENTLY — so the guard's own headline count
 * understated by construction. Measured 2026-08-10: 3 real edges hidden
 * (operator-core->sse, operator-vite->sse, operator-core->file-claim), and BOTH of those
 * targets were genuinely unrouted in affected-tests.mjs at the time — i.e. the exact class
 * the guard exists to detect was happening in the packages the guard could not see.
 *
 * WHY THE TESTS BELOW ARE SHAPED THIS WAY. They assert the DISCOVERY MECHANISM, never the
 * current offender population. Asserting "there are 3 non-workspace offenders" would be a
 * test that fails when someone FIXES one — i.e. a test asserting the continued existence of
 * a defect. The mechanism is the invariant; the backlog is not.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-workspace-deps-complete.mjs');

/** The set of root-workspace dirs, i.e. what the OLD narrow rule could see. */
function rootWorkspaceDirs(): string[] {
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const out: string[] = [];
  for (const p of rootPkg.workspaces as string[]) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      const baseDir = join(REPO_ROOT, base);
      if (!existsSync(baseDir)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      for (const entry of readdirSync(baseDir)) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(REPO_ROOT, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(REPO_ROOT, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

function rootWorkspaceNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of rootWorkspaceDirs()) {
    try {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8'));
      if (pkg.name) names.add(pkg.name);
    } catch {
      /* ignore */
    }
  }
  return names;
}

describe('check-workspace-deps-complete: target-side scope (EI-20028225708881148)', () => {
  it('discovers local packages that are NOT root workspaces', async () => {
    const { loadLocalPackagesOnDisk } = await import(SCRIPT);
    const onDisk: Map<string, { dir: string }> = loadLocalPackagesOnDisk();
    const wsNames = rootWorkspaceNames();

    const nonWorkspaceLocals = [...onDisk.keys()].filter(
      (n) => (n.startsWith('@papercusp/') || n.startsWith('@papercup/')) && !wsNames.has(n),
    );

    // CALIBRATION — without this, the assertion below could pass vacuously if the walk
    // returned everything or nothing. The walk must find the root workspaces too.
    expect(onDisk.size).toBeGreaterThan(wsNames.size);

    // THE INVARIANT: the lookup must reach beyond root.workspaces. Narrowing it back to
    // `byName` (root workspaces only) makes this list empty and fails here — which is the
    // whole point, since that narrowing is silent in production.
    expect(nonWorkspaceLocals.length).toBeGreaterThan(0);
  });

  it('the narrow (root-workspace-only) rule genuinely MISSES packages the wide rule finds', async () => {
    // The explicit control: this is what makes the test above meaningful rather than
    // tautological. If these two ever agree, the wide rule has stopped being wider.
    const { loadLocalPackagesOnDisk } = await import(SCRIPT);
    const onDisk: Map<string, unknown> = loadLocalPackagesOnDisk();
    const wsNames = rootWorkspaceNames();

    const missedByNarrowRule = [...onDisk.keys()].filter((n) => !wsNames.has(n));
    expect(missedByNarrowRule.length).toBeGreaterThan(0);
  });

  it('does NOT treat a name that is absent from disk as local (no over-widening)', async () => {
    const { findOffenders } = await import(SCRIPT);
    const offenders: Array<{ imported: string }> = findOffenders();

    // `@papercusp/charts` is referenced in operator-core, but only as TEXT inside a code
    // EMITTER (design-adapter-react-tailwind/code-emit.ts pushes the literal
    // "import { PlotlyChart } from '@papercusp/charts';" into generated output). No such
    // package exists on disk or in node_modules. It must stay out of scope — widening the
    // target side must not degenerate into "anything that looks like an import".
    expect(offenders.some((o) => o.imported === '@papercusp/charts')).toBe(false);
  });

  it('every offender it can see is baselined, so the guard exits 0', async () => {
    // Guards the specific trap that makes this class expensive: this script is registered
    // in REPO_WIDE_INVARIANT_GUARDS, so it runs on every .ts/.tsx/package.json change.
    // Widening its vision WITHOUT extending BASELINE in the same change makes it exit 1 and
    // red-pin the fleet gate on arrival. Failing here is a local, cheap version of that.
    const { findOffenders, BASELINE } = await import(SCRIPT);
    const offenders: Array<{ edge: string }> = findOffenders();
    const unbaselined = offenders.map((o) => o.edge).filter((e) => !BASELINE.has(e));
    expect(unbaselined).toEqual([]);
  });

  it('reports the target kind, because the remedy differs by kind', async () => {
    // A non-workspace target must NOT be "fixed" with `"<name>": "*"`: package-lock.json
    // carries its own workspaces array and CI runs `npm ci` strict, so npm would resolve the
    // name from the registry for a private package and break the install. The failure
    // message branches on this flag, so the flag has to exist and be populated.
    const { findOffenders } = await import(SCRIPT);
    const offenders: Array<{ edge: string; targetIsWorkspace: boolean; targetDir: string | null }> =
      findOffenders();
    expect(offenders.length).toBeGreaterThan(0);
    for (const o of offenders) {
      expect(typeof o.targetIsWorkspace).toBe('boolean');
      expect(o.targetDir === null || typeof o.targetDir === 'string').toBe(true);
    }
  });
});
