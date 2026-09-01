// Derived route contract — dark-flag closed-gate coverage.
//
// EI-22053933419316862 ("No authoritative operator-vite route contract covers
// legacy pages, redirect targets, and parked flags") bundles evidence that this
// SPA's user-facing route surface is not derived-and-verified against its own
// registries. This test covers the "parked flags" leg (EI-21619134289133807):
// every operator-vite route whose `beforeLoad` gates on `requireFlag(FLAGS.X)`
// for an X that `DARK_FLAGS` currently calls dark must actually REFUSE
// (throw notFound) while that flag reads off — otherwise the DARK_FLAGS entry's
// "this surface is parked/not shipping" reason is a comment the routing layer
// doesn't keep, the exact EI-7230-class comment/reality mismatch DARK_FLAGS'
// own header in libs/flags/src/types.ts documents hitting five separate times
// (WATCHDOG_AUTO_CLOSE, AUTHORITY_EVICTION_PROBE, SUBSTRATE_SIDECAR, and two
// more) — always as a stale/missing DARK_FLAGS *registration*, never previously
// caught as a *routing* gap because nothing exercised the gate end to end.
//
// Derived (derived-truth-ladder rung 1 — generate from the single source, don't
// hand-maintain a parallel list) from two live sources, at test-collection time:
//   - route gate call sites: every `requireFlag(FLAGS.<KEY>)` found by walking
//     apps/operator-vite/src/routes/** — a new gated route is picked up
//     automatically, a removed one drops out on its own.
//   - the dark-flag registry: `DARK_FLAGS` from `@papercusp/flags`.
// A route's gate key that is NOT in DARK_FLAGS is a live (default-ON) flag with
// no closed-gate obligation and is intentionally skipped.
//
// The (redirect-targets / legacy-pages) other two legs of EI-22053933419316862
// are tracked separately: /wiki/missing already resolved (WI-96172, done); the
// FleetStatusPanel/WeatherWidget orphan question is a router-vs-delete PRODUCT
// decision (EI-21610745208896793) with no live redirect/gate pointing at either
// path today, not a contract-derivation gap this test can meaningfully assert.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DARK_FLAGS, FLAGS, type FlagKey } from '@papercusp/flags';

const NOT_FOUND = new Error('NOT_FOUND');
const notFound = vi.fn(() => {
  throw NOT_FOUND;
});
vi.mock('@tanstack/react-router', () => ({ notFound: () => notFound() }));

const loadFlags = vi.fn();
const getFlagSnapshot = vi.fn();
vi.mock('@papercusp/flags/client', () => ({
  loadFlags: () => loadFlags(),
  getFlagSnapshot: () => getFlagSnapshot(),
}));

// Import the real gate under test (same module the routes themselves call).
import { requireFlag } from '../lib/require-flag';

afterEach(() => vi.clearAllMocks());

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');
const GATE_CALL_RE = /requireFlag\(\s*FLAGS\.([A-Z0-9_]+)\s*\)/g;
const FLAGS_BY_NAME = FLAGS as Record<string, FlagKey | undefined>;

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
      continue;
    }
    // Route source only — never a test file (which may itself reference
    // requireFlag/FLAGS in mocks or comments) and never generated output.
    if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments before matching gate calls — several route files quote
 * `requireFlag(FLAGS.X)` verbatim in a JSDoc/line comment explaining the
 * port from the Next Server-Component gate, which would otherwise double-
 * count as a second "call site" for the same real gate.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Every `requireFlag(FLAGS.<KEY>)` gate found in route source, file-relative for readable test titles. */
const gatedRoutes: Array<{ file: string; keyName: string }> = listSourceFiles(ROUTES_DIR).flatMap(
  (file) => {
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(ROUTES_DIR.length + 1);
    return [...src.matchAll(GATE_CALL_RE)].map((m) => ({ file: rel, keyName: m[1] }));
  },
);

// Restrict to gates whose flag is CURRENTLY dark — the closed-gate obligation
// this test exists to enforce. A route gated on a live (default-ON) flag has
// nothing to check here.
const darkGatedRoutes = gatedRoutes.filter(({ keyName }) => {
  const value = FLAGS_BY_NAME[keyName];
  return value !== undefined && DARK_FLAGS.has(value);
});

describe('operator-vite route contract — dark-flag closed gate (derived)', () => {
  it('derivation sanity: found requireFlag() gates to check', () => {
    // A silent 0-match here (e.g. the gate call shape changed) would make
    // every assertion below vacuously pass — the exact false-green class this
    // repo's own routing table warns about (bounded search whose empty result
    // is read as a real negative). Fail loudly instead of quietly checking nothing.
    expect(gatedRoutes.length).toBeGreaterThan(0);
    expect(darkGatedRoutes.length).toBeGreaterThan(0);
  });

  it('every requireFlag() gate call site references a real FlagKey', () => {
    for (const { file, keyName } of gatedRoutes) {
      expect(FLAGS_BY_NAME[keyName], `${file}: requireFlag(FLAGS.${keyName})`).toBeDefined();
    }
  });

  it.each(darkGatedRoutes.map(({ file, keyName }) => [file, keyName] as const))(
    '%s: requireFlag(FLAGS.%s) refuses (notFound) while the dark flag is off',
    async (_file, keyName) => {
      const value = FLAGS_BY_NAME[keyName] as FlagKey;
      loadFlags.mockResolvedValue(undefined);
      // No override for `value` in the snapshot -> requireFlag falls back to
      // FLAG_DEFAULTS[value], which is `false` because DARK_FLAGS.has(value)
      // (FLAG_DEFAULTS is derived from DARK_FLAGS in libs/flags/src/types.ts).
      getFlagSnapshot.mockReturnValue({ flags: {} });
      await expect(requireFlag(value)).rejects.toBe(NOT_FOUND);
      expect(notFound).toHaveBeenCalledOnce();
    },
  );
});
