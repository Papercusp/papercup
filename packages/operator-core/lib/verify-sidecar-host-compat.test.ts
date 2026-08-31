import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// eslint-disable-next-line import/no-relative-packages
import {
  boundaryCovers,
  extractExternalSpecifiers,
  packageRootOf,
  readDeclaredBoundary,
  resolvesFrom,
  verify,
} from '../../../scripts/verify-sidecar-host-compat.mjs';

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-sidecar-compat-'));
  roots.push(root);
  for (const [rel, source] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('extractExternalSpecifiers — the boundary probe', () => {
  it('recovers externals from every form esbuild can emit', () => {
    const found = extractExternalSpecifiers(`
      import { a } from "hypercore";
      export { b } from 'hyperbee';
      import "corestore";
      const c = await import("hyperswarm");
      const d = require("sodium-native");
    `);
    expect(found).toEqual([
      'corestore',
      'hyperbee',
      'hypercore',
      'hyperswarm',
      'sodium-native',
    ]);
  });

  it('ignores the bundle’s own internals (relative and absolute specifiers)', () => {
    expect(
      extractExternalSpecifiers(`
        import x from "./chunk-abc.mjs";
        import y from "../sibling.mjs";
        import z from "/opt/app/thing.mjs";
      `),
    ).toEqual([]);
  });

  it('ignores builtins in both spellings — they are never a host risk', () => {
    expect(
      extractExternalSpecifiers(`
        import fs from "node:fs";
        import path from "path";
        import { createRequire } from "node:module";
      `),
    ).toEqual([]);
  });

  it('collapses subpath imports to the package root that must exist on the host', () => {
    // The host needs the PACKAGE installed; a deep subpath is not separately installable.
    expect(
      extractExternalSpecifiers(`
        import a from "@embedded-postgres/linux-x64/dist/index.js";
        import b from "hypercore/lib/core.js";
      `),
    ).toEqual(['@embedded-postgres/linux-x64', 'hypercore']);
  });

  // CALIBRATION — this test must RED if the probe is ever degraded to return nothing.
  //
  // A probe that returns [] makes verify() report ok:true for EVERY bundle, i.e. the tool
  // silently declares an incompatible artifact safe to ship. That is the exact failure this
  // script exists to prevent, and it is invisible to every other test here (they would all
  // still pass their "ignores X" assertions against an empty result).
  it('CALIBRATION: a realistic bundle yields a NON-EMPTY requirement set', () => {
    const found = extractExternalSpecifiers(`
      import { createRequire } from "node:module";
      import Hypercore from "hypercore";
      import "./internal-chunk.mjs";
    `);
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain('hypercore');
  });
});

describe('packageRootOf', () => {
  it('resolves scoped, unscoped and subpath specifiers to their install root', () => {
    expect(packageRootOf('hypercore')).toBe('hypercore');
    expect(packageRootOf('hypercore/lib/core.js')).toBe('hypercore');
    expect(packageRootOf('@embedded-postgres/linux-x64')).toBe('@embedded-postgres/linux-x64');
    expect(packageRootOf('@embedded-postgres/linux-x64/dist/i.js')).toBe(
      '@embedded-postgres/linux-x64',
    );
  });

  it('returns null for a bare scope with no package name', () => {
    expect(packageRootOf('@scope')).toBeNull();
  });
});

describe('resolvesFrom — mirrors node walk-up resolution', () => {
  it('finds a package installed beside the bundle', () => {
    const root = fixture({ 'host/node_modules/hypercore/package.json': '{"name":"hypercore"}' });
    expect(resolvesFrom('hypercore', join(root, 'host'))).toBe(true);
  });

  it('finds a package hoisted to a PARENT node_modules, as node would', () => {
    // A check stricter than the runtime reports breakage that does not occur.
    const root = fixture({ 'node_modules/hypercore/package.json': '{"name":"hypercore"}' });
    mkdirSync(join(root, 'host', 'nested'), { recursive: true });
    expect(resolvesFrom('hypercore', join(root, 'host', 'nested'))).toBe(true);
  });

  it('reports a genuinely absent package as unresolvable', () => {
    const root = fixture({ 'host/node_modules/other/package.json': '{"name":"other"}' });
    expect(resolvesFrom('hypercore', join(root, 'host'))).toBe(false);
  });
});

describe('readDeclaredBoundary', () => {
  it('returns null when no stamp exists — the unstamped, dangerous case', () => {
    const root = fixture({ 'host/.keep': '' });
    expect(readDeclaredBoundary(join(root, 'host', 'BUILD-STAMP.txt'))).toBeNull();
  });

  it('returns null when a stamp exists but declares no boundary', () => {
    const root = fixture({ 'BUILD-STAMP.txt': 'builtAt=2026-08-31\nsha=abc123\n' });
    expect(readDeclaredBoundary(join(root, 'BUILD-STAMP.txt'))).toBeNull();
  });

  it('parses a declared boundary, and an explicitly empty one as empty (not null)', () => {
    const a = fixture({ 'BUILD-STAMP.txt': 'hostExternals=hypercore, hyperbee ,corestore\n' });
    expect(readDeclaredBoundary(join(a, 'BUILD-STAMP.txt'))).toEqual([
      'hypercore',
      'hyperbee',
      'corestore',
    ]);

    // "declared, and declared to be empty" is a different fact from "never declared".
    const b = fixture({ 'BUILD-STAMP.txt': 'hostExternals=\n' });
    expect(readDeclaredBoundary(join(b, 'BUILD-STAMP.txt'))).toEqual([]);
  });
});

describe('boundaryCovers', () => {
  it('covers exact entries and scope wildcards, but not unrelated packages', () => {
    expect(boundaryCovers(['hypercore'], 'hypercore')).toBe(true);
    expect(boundaryCovers(['@embedded-postgres/*'], '@embedded-postgres/linux-x64')).toBe(true);
    expect(boundaryCovers(['*'], 'anything')).toBe(true);
    expect(boundaryCovers(['hypercore'], 'hyperbee')).toBe(false);
    expect(boundaryCovers([], 'hypercore')).toBe(false);
  });

  it('does not let a scope wildcard leak across scope boundaries', () => {
    expect(boundaryCovers(['@embedded-postgres/*'], '@embedded-postgres-evil/x')).toBe(false);
  });
});

describe('verify — end to end', () => {
  it('REPRODUCES THE NEAR-MISS: flags a bundle whose externals the host cannot satisfy', () => {
    // The measured incident: a tree-built bundle externalized the holepunch/hypercore
    // stack while the target host had none of it. Shipping produced no loud crash —
    // federation simply stopped.
    const root = fixture({
      'bundle/serve.mjs': 'import "hypercore"; import "hyperswarm"; import "node:fs";',
      'host/node_modules/sodium-native/package.json': '{"name":"sodium-native"}',
    });

    const report = verify({
      bundlePath: join(root, 'bundle', 'serve.mjs'),
      hostDir: join(root, 'host'),
      stampPath: join(root, 'bundle', 'BUILD-STAMP.txt'),
    });

    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['hypercore', 'hyperswarm']);
    expect(report.present).toEqual([]);
    expect(report.stamped).toBe(false);
    expect(report.declaredCount).toBeNull();
  });

  it('passes a bundle whose every external the host satisfies', () => {
    const root = fixture({
      'bundle/serve.mjs': 'import "hypercore"; import "node:path";',
      'host/node_modules/hypercore/package.json': '{"name":"hypercore"}',
    });

    const report = verify({
      bundlePath: join(root, 'bundle', 'serve.mjs'),
      hostDir: join(root, 'host'),
      stampPath: join(root, 'bundle', 'BUILD-STAMP.txt'),
    });

    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.present).toEqual(['hypercore']);
  });

  it('reports drift against a declared boundary without failing a resolvable host', () => {
    // Drift is a provenance problem, not a runtime one: the host CAN satisfy the bundle,
    // but the bundle carries an external its stamp never declared. Surfacing that
    // separately from `ok` is what lets --strict be opt-in.
    const root = fixture({
      'bundle/serve.mjs': 'import "hypercore"; import "hyperbee";',
      'bundle/BUILD-STAMP.txt': 'hostExternals=hypercore\n',
      'host/node_modules/hypercore/package.json': '{"name":"hypercore"}',
      'host/node_modules/hyperbee/package.json': '{"name":"hyperbee"}',
    });

    const report = verify({
      bundlePath: join(root, 'bundle', 'serve.mjs'),
      hostDir: join(root, 'host'),
      stampPath: join(root, 'bundle', 'BUILD-STAMP.txt'),
    });

    expect(report.ok).toBe(true);
    expect(report.stamped).toBe(true);
    expect(report.drift).toEqual(['hyperbee']);
  });

  it('derives requirements from the BUNDLE, not the stamp, when the two disagree', () => {
    // Ground truth is the artifact. A stamp that under-declares must not be able to
    // talk the checker out of a real missing dependency.
    const root = fixture({
      'bundle/serve.mjs': 'import "hypercore";',
      'bundle/BUILD-STAMP.txt': 'hostExternals=\n',
      'host/.keep': '',
    });

    const report = verify({
      bundlePath: join(root, 'bundle', 'serve.mjs'),
      hostDir: join(root, 'host'),
      stampPath: join(root, 'bundle', 'BUILD-STAMP.txt'),
    });

    expect(report.required).toEqual(['hypercore']);
    expect(report.missing).toEqual(['hypercore']);
    expect(report.ok).toBe(false);
  });
});
