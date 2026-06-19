/**
 * A1 (infra-fail-fast-build-integrity-2026-06-19) — native-addon deploy-gate
 * preflight.
 *
 * The 2026-06-19 :3070 outage: papercup-release's `better-sqlite3` native addon
 * was built for Node 22 (ABI 127) while the service runs Node 25 (ABI 141). It
 * loaded fine at install but FAILED at load ("Module did not self-register"),
 * mem0 never came up, and every memory-touching handler hung behind a green
 * health check. Nothing rebuilt/verified the addon against the runtime Node, so
 * the broken binary shipped to green undetected.
 *
 * This module test-LOADS the critical native packages under the CURRENT Node so
 * a deploy gate can fail a promotion on any load failure.
 *
 * KEY DESIGN — load PACKAGES, not raw `.node` files. The first instinct (scan
 * every `*.node` under node_modules and try to load each) produces ~60 benign
 * FALSE alarms: packages ship prebuilt binaries for many platforms/ABIs
 * (musl/darwin/win/arm/…) and the loader only ever selects ONE. Loading the
 * package via its real entry runs that package's own platform/ABI selection
 * (prebuild-install / node-gyp-build), so a throw means the binary the loader
 * ACTUALLY picks is broken on this runtime — the real signal, no false alarms.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Native addons whose load failure must FAIL a promotion. `better-sqlite3` is
 * the 2026-06-19 outage cause (mem0's store) and is loaded on every full host.
 * Kept deliberately small — a deploy gate that false-blocks every promotion is
 * worse than none. Extend via PAPERCUSP_PREFLIGHT_ADDONS (comma-separated).
 */
export const DEFAULT_REQUIRED_ADDONS = ['better-sqlite3'] as const;

/** Resolve the required-addon set: env override (comma list) or the default. */
export function requiredAddonsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PAPERCUSP_PREFLIGHT_ADDONS;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_REQUIRED_ADDONS];
}

export interface AddonLoadResult {
  name: string;
  /** true = loaded; false = threw; null = indeterminate (e.g. ESM-only, can't
   *  be require()-tested) — never counted as a gate failure. */
  ok: boolean | null;
  required: boolean;
  error?: string;
}

export interface PreflightReport {
  node: string;
  /** N-API/V8 module ABI (process.versions.modules) — the dimension that drifted. */
  abi: string;
  results: AddonLoadResult[];
  /** true iff every REQUIRED addon loaded (indeterminate required → fail-closed). */
  ok: boolean;
}

/** A package ships a native addon if it carries a `prebuilds/` dir or a built
 *  `build/Release` output. */
export function packageShipsAddon(pkgDir: string): boolean {
  return existsSync(join(pkgDir, 'prebuilds')) || existsSync(join(pkgDir, 'build', 'Release'));
}

/**
 * Discover packages under `nodeModulesDir` that ship a native addon, returning
 * their require specifiers (handles `@scope/name`). Used to populate the
 * ADVISORY set — addons we report on but don't gate on.
 */
export function discoverAddonPackages(nodeModulesDir: string): string[] {
  if (!existsSync(nodeModulesDir)) return [];
  const out: string[] = [];
  for (const entry of safeReaddir(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry);
      for (const sub of safeReaddir(scopeDir)) {
        if (packageShipsAddon(join(scopeDir, sub))) out.push(`${entry}/${sub}`);
      }
      continue;
    }
    if (packageShipsAddon(join(nodeModulesDir, entry))) out.push(entry);
  }
  return out.sort();
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Node's code for "this is an ESM package, require() can't load it" — an
 *  indeterminate result for a require-based load test, NOT a broken addon. */
function isEsmRequireError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_REQUIRE_ESM';
}

/** Attempt to load one package via the injected require. */
export function loadAddon(
  spec: string,
  requireFn: (s: string) => unknown,
): { ok: boolean | null; error?: string } {
  try {
    requireFn(spec);
    return { ok: true };
  } catch (err) {
    if (isEsmRequireError(err)) {
      return { ok: null, error: 'ERR_REQUIRE_ESM (not require-loadable; skipped)' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Test-load the required + advisory addon sets. `requireFn` is injected so the
 * deploy CLI can root it at the target install (createRequire) and tests can
 * stub it. The gate result (`ok`) is fail-CLOSED: a required addon that loads
 * is the only pass; a throw OR an indeterminate (ESM) required addon fails.
 */
export function checkNativeAddons(opts: {
  requireFn: (s: string) => unknown;
  required: string[];
  advisory?: string[];
}): PreflightReport {
  const required = new Set(opts.required);
  // Advisory minus anything already required (required wins).
  const advisory = (opts.advisory ?? []).filter((s) => !required.has(s));

  const results: AddonLoadResult[] = [];
  for (const name of opts.required) {
    const { ok, error } = loadAddon(name, opts.requireFn);
    results.push({ name, ok, required: true, error });
  }
  for (const name of advisory) {
    const { ok, error } = loadAddon(name, opts.requireFn);
    results.push({ name, ok, required: false, error });
  }

  const ok = results.filter((r) => r.required).every((r) => r.ok === true);
  return { node: process.versions.node, abi: process.versions.modules, results, ok };
}

/** Human-readable report for the deploy log. */
export function formatReport(r: PreflightReport): string {
  const lines: string[] = [
    `native-addon preflight — node=${r.node} abi(modules)=${r.abi}`,
  ];
  for (const res of r.results) {
    const mark = res.ok === true ? 'OK  ' : res.ok === null ? 'SKIP' : 'FAIL';
    const tag = res.required ? 'required' : 'advisory';
    lines.push(`  [${mark}] ${res.name} (${tag})${res.error ? ` — ${res.error}` : ''}`);
  }
  const failed = r.results.filter((x) => x.required && x.ok !== true).map((x) => x.name);
  lines.push(r.ok ? 'PASS — all required addons load under the runtime Node.' : `FAIL — required addon(s) did not load: ${failed.join(', ')}`);
  return lines.join('\n');
}
