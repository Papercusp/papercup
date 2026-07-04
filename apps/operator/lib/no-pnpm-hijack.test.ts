// @vitest-environment node
/**
 * no-pnpm-hijack — repo is npm-ONLY; a pnpm/bun install on the shared tree
 * silently corrupts node_modules and the failure that surfaces is cryptic.
 *
 * This turns that cryptic failure into a loud, actionable one. A `pnpm install`
 * builds a `node_modules/.pnpm` virtual store and replaces top-level packages
 * with symlinks into it; the resolved versions then diverge from the npm
 * lockfile. On 2026-07-04 that pinned @assistant-ui/store to 0.2.19 (which
 * DROPPED the `tapClientResource`/`tapClientLookup` exports @assistant-ui/react
 * imports) and blanked the whole SPA / red-pinned the green gate for ~2h — the
 * SECOND time the class bit the fleet (the 2026-07-03 incident added the
 * .gitignore guard, but a still-TRACKED pnpm-lock.yaml overrode it).
 *
 * `.pnpm` never legitimately exists here — npm never creates it — so its
 * presence is unambiguous. The `preinstall: only-allow npm` guard blocks a
 * plain `pnpm install`, but `--ignore-scripts` slips past it; this is the
 * backstop. If it fires, run the repair recipe in the failure message.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this file to the monorepo root (the package.json with "workspaces"). */
function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('no-pnpm-hijack: could not locate the monorepo root');
}

const REPO = findRepoRoot();
const NM = path.join(REPO, 'node_modules');

const REPAIR =
  'This repo is npm-ONLY. A pnpm/bun install hijacked node_modules. Repair:\n' +
  '  1. remove every top-level symlink into .pnpm, then `rm -rf node_modules/.pnpm`\n' +
  '  2. `npm install` (reconciles to the npm lockfile)\n' +
  '  3. NEVER `npm ... overrides` @assistant-ui/store to 0.2.19 — it lacks the tap* exports;\n' +
  '     the working pair is @assistant-ui/react@0.12.26 + @assistant-ui/store@0.2.8.\n' +
  'See harness fact `npm-only-pnpm-hijack-repair` / EI-7279 context.';

describe('node_modules is npm-managed (no pnpm/bun hijack)', () => {
  it('has no node_modules/.pnpm virtual store', () => {
    expect(existsSync(path.join(NM, '.pnpm')), `${NM}/.pnpm exists.\n${REPAIR}`).toBe(false);
  });

  it('has no top-level package symlinked into a .pnpm store', () => {
    if (!existsSync(NM)) return; // fresh clone before install — nothing to check
    const hijacked: string[] = [];
    for (const name of readdirSync(NM)) {
      if (name.startsWith('.')) continue;
      const entry = path.join(NM, name);
      let stat;
      try {
        stat = lstatSync(entry);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      let target = '';
      try {
        target = readlinkSync(entry);
      } catch {
        continue;
      }
      if (target.includes('.pnpm')) hijacked.push(name);
    }
    expect(hijacked, `top-level packages symlinked into .pnpm: ${hijacked.join(', ')}\n${REPAIR}`).toEqual(
      [],
    );
  });
});
