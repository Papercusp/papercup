/**
 * configure-search-defaults-import-purity.test.ts
 *
 * `configure-search-defaults.ts` SELF-INSTALLS on import (that is the whole
 * point of P-017: a surface inherits the ranking policy by existing). So every
 * `runHybridSearch` caller imports it, and whatever IT statically reaches, they
 * all reach — at import time, before any handler runs.
 *
 * ─── THE BUG THIS GUARDS (measured 2026-08-04, P-016 third surface) ─────────
 * It imported `embedderModeOf` from `../agent-tools/search/embedder`. That
 * module only RE-EXPORTS the symbol from the leaf `./embedder-mode-registry` —
 * the leaf exists precisely so the policy can read the registry without
 * dragging the resolution stack in — but importing the re-export still pulls
 * `embedder.ts`, and `embedder.ts` statically reaches `memory/configure.ts`,
 * which opens a Postgres connection AT MODULE SCOPE.
 *
 * Consequence: importing `agent-tools/plans/search.ts` alone pinned the process
 * store identity to the dev cluster within ~3s. Every plans PG-fixture
 * integration test then observed a WRONG STORE and failed on the resulting
 * `console.error` — a red that names a database, points at no code, and looks
 * exactly like local environment churn. `search-rrf-fusion.integration.test.ts`
 * went from a year of passes to failing at the commit that added the import.
 *
 * The import is one character short of correct and reads as a stylistic
 * preference, which is why a comment on the leaf module was not enough to hold
 * it. This asserts the PROPERTY instead: the policy module's runtime import
 * graph must not reach a module that does I/O at import.
 *
 * ⚠ The walk follows RELATIVE specifiers only and stops at bare package names
 * (`@papercusp/*`, node builtins). That is a real bound: a heavy module reached
 * only through a package entrypoint would not be seen. It covers the failure
 * observed here — an intra-package re-export — and the control below proves the
 * walk actually finds what it claims to look for.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { importGraph } from './import-graph';

const HERE = dirname(new URL(import.meta.url).pathname);
const POLICY = resolve(HERE, 'configure-search-defaults.ts');
const HEAVY_EMBEDDER = resolve(HERE, '../agent-tools/search/embedder.ts');
const MEMORY_CONFIGURE = resolve(HERE, '../memory/configure.ts');

const reachable = (entry: string) => importGraph(entry).modules;
const rel = (f: string) => relative(resolve(HERE, '../..'), f);

describe('configure-search-defaults import purity (P-016/P-017)', () => {
  it('does NOT statically reach memory/configure.ts, which opens PG at import', () => {
    const graph = reachable(POLICY);
    expect(graph.has(MEMORY_CONFIGURE)).toBe(false);
  });

  it('does NOT statically reach agent-tools/search/embedder.ts — read the LEAF registry', () => {
    const graph = reachable(POLICY);
    // If this fails, the fix is a one-line import change, not a new module:
    //   import { embedderModeOf } from './embedder-mode-registry';
    expect(graph.has(HEAVY_EMBEDDER)).toBe(false);
  });

  it('still reads the embedder-mode registry — the policy is not merely inert', () => {
    // A guard that only asserts absences passes just as happily if someone
    // deletes the floor lookup entirely. This is the calibration case.
    const graph = reachable(POLICY);
    expect(graph.has(resolve(HERE, 'embedder-mode-registry.ts'))).toBe(true);
    expect(graph.has(resolve(HERE, 'prose-min-score.ts'))).toBe(true);
  });

  it('CONTROL: the walk really does find memory/configure.ts from embedder.ts', () => {
    // Falsifiability. Without this, a walker that resolved nothing at all
    // (a renamed file, a regex that stopped matching) would pass every
    // assertion above while checking nothing.
    const graph = reachable(HEAVY_EMBEDDER);
    expect(
      graph.has(MEMORY_CONFIGURE),
      `walk from ${rel(HEAVY_EMBEDDER)} found ${graph.size} modules but not ` +
        `${rel(MEMORY_CONFIGURE)} — the walker is broken, so the absence ` +
        `assertions above prove nothing`,
    ).toBe(true);
  });

  it('CONTROL: memory/configure.ts still does I/O at module scope', () => {
    // The absence assertions only matter while this is true. If someone makes
    // memory/configure.ts import-pure, this test should fail and the whole
    // file should be re-evaluated rather than silently kept as ceremony.
    const src = readFileSync(MEMORY_CONFIGURE, 'utf8');
    expect(/getOrgPg|withWorkspace|getHarnessAdminUrl|postgres\(/.test(src)).toBe(true);
  });
});
