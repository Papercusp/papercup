import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { engineeringDocsSurfaceHint } from './_mcp-handler';

/**
 * EI-20206112532711097: a workspace-scoped su session called `docs:get { harness: 'all' }`
 * — the spelling its own guide recommended — and got the generic global-escape refusal,
 * whose stated repair is "Name a concrete harness in scope". It followed that to
 * `harness: 'papercusp'` and read a DIFFERENT corpus.
 *
 * That is why this refusal is worse than the bare "no" crossHiveLaunchHint was written
 * for: `docs:*` resolves the `'engineering'` sentinel and `'all'` to the same
 * engineering-reference corpus, while a plain `'papercusp'` resolves to that harness's own
 * doc surface. The wrong repair therefore fails SILENTLY — a weak or empty result that
 * reads like "no such page exists" (the false-negative class of EI-18894866320087268).
 *
 * The clamp is NOT the defect and these tests must never be "fixed" by widening it —
 * `'all'` is the cross-workspace escape (P-006/P-007/P-008). What is asserted here is only
 * that the refusal names the repair that reaches the corpus the caller actually asked for.
 */
describe('engineeringDocsSurfaceHint', () => {
  it("names `harness:'engineering'` as the in-scope repair for a refused docs read", () => {
    const hint = engineeringDocsSurfaceHint('docs:get');

    expect(hint).toContain("harness:'engineering'");
  });

  it('states the substitution is lossless, so the caller does not treat it as a lesser fallback', () => {
    // Without this, `'engineering'` reads as a narrower consolation prize for the `'all'`
    // the caller wanted, and the rational move is to go find an unscoped session instead
    // of just re-running the call.
    const hint = engineeringDocsSurfaceHint('docs:search');

    expect(hint).toContain('SAME');
    expect(hint).toContain('loses nothing');
  });

  it('pre-empts the wrong next move the generic refusal steers toward', () => {
    // The reported failure. The generic text says "Name a concrete harness in scope"; for a
    // docs read the obvious concrete slug is the one that OWNS the docs, and that silently
    // reads the wrong surface. The hint must say so explicitly, and must say the empty
    // result it produces is not evidence of an absent page.
    const hint = engineeringDocsSurfaceHint('docs:outline');

    expect(hint).toContain("harness:'papercusp'");
    expect(hint).toContain('wrong corpus, not an');
    expect(hint).toContain('absent page');
  });

  it('covers the whole docs-surface family, not just the one tool that was reported', () => {
    for (const tool of ['docs:get', 'docs:search', 'docs:outline', 'docs:author']) {
      expect(
        engineeringDocsSurfaceHint(tool),
        `expected an engineering-surface repair for ${tool}`,
      ).toContain("harness:'engineering'");
    }
  });

  // CONTROL. Every assertion above would still pass if the helper ignored `toolName` and
  // returned the hint unconditionally — which would staple docs advice onto every
  // unrelated global-escape refusal (plans:list, work_items:list, coord:orient, …), where
  // `'engineering'` is not a valid harness at all.
  it('CONTROL: returns nothing for tools that are not docs surfaces', () => {
    for (const tool of [
      'plans:list',
      'work_items:list',
      'coord:orient',
      'fleet:launch-on-plan',
      'docs:index', // takes no `harness` arg, so this branch can never fire for it
      'docs:section',
    ]) {
      expect(engineeringDocsSurfaceHint(tool), `expected NO docs hint for ${tool}`).toBe('');
    }
  });
});

describe('engineeringDocsSurfaceHint wiring', () => {
  // A correct helper that nothing calls is invisible at runtime, and the unit tests above
  // cannot tell the difference. `_mcp-handler.ts` builds the global-escape refusal in TWO
  // places (the spawn-context clamp and the dispatch clamp) with DIFFERENT local variable
  // names, so a fix applied to only one is half-live and reads as fully fixed — which is
  // exactly how a caller on the other path keeps getting the misleading repair.
  // Path is overridable so falsifiability can be proven against a MUTATED COPY outside the
  // tree (scripts/mutation-probe.sh), never by mutating this shared checkout — a git-sync
  // sweep commits the working tree on a timer and would commit the mutant.
  const source = readFileSync(
    process.env.ENGINEERING_DOCS_SURFACE_HINT_SOURCE ?? join(__dirname, '_mcp-handler.ts'),
    'utf8',
  );

  const globalEscapeRefusals = source
    .split('\n')
    .filter(
      (line) =>
        line.includes('harness_forbidden: ') && line.includes('is the unscoped global escape'),
    );

  it('is interpolated into every global-escape harness_forbidden refusal', () => {
    // Both known sites; a third added later without the hint fails here rather than
    // silently reintroducing the defect on a new path.
    expect(globalEscapeRefusals.length).toBeGreaterThanOrEqual(2);

    for (const line of globalEscapeRefusals) {
      expect(
        line,
        `a global-escape harness_forbidden refusal does not call engineeringDocsSurfaceHint: ${line.trim()}`,
      ).toContain('engineeringDocsSurfaceHint(toolName)');
    }
  });

  it('is NOT stapled onto the cross-hive refusals, where its advice would be false', () => {
    // The hint's load-bearing sentence — "'engineering' resolves to the SAME corpus
    // `harness:'all'` would have read" — is only true when the caller asked for 'all'. On a
    // cross-hive refusal the caller named a concrete foreign harness, and 'engineering'
    // does not reach it, so the hint would be actively wrong advice there.
    const crossHiveRefusals = source
      .split('\n')
      .filter(
        (line) =>
          line.includes('harness_forbidden: ') && line.includes("outside this session's hive"),
      );

    expect(crossHiveRefusals.length).toBeGreaterThanOrEqual(1);
    for (const line of crossHiveRefusals) {
      expect(
        line,
        `a cross-hive refusal wrongly carries the engineering-surface hint: ${line.trim()}`,
      ).not.toContain('engineeringDocsSurfaceHint');
    }
  });
});
