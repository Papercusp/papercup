/**
 * search-surface-conformance.test.ts — P-021's durable guard.
 *
 * Every search surface must be REGISTERED and its declared feature set must
 * match what its code actually does, so a new surface cannot silently ship
 * keyword-only (or engine-backed-but-unfloored, which is the same bug wearing
 * a better hat).
 *
 * ─── HOW IT AVOIDS BEING CEREMONY ──────────────────────────────────────────
 * Three separate failure modes are addressed, because a registry guard can be
 * defeated in all three and only the first is obvious:
 *
 *  1. **An unregistered surface** — discovery enumerates tools NAMED
 *     `*:search` / `search:*` from source and requires an entry for each.
 *  2. **A lying entry** — every declared fact is DERIVED independently from the
 *     surface's transitive runtime import graph and compared. `engine: true`
 *     additionally obliges the graph to reach the P-017 policy seam.
 *  3. **A vacuous guard** — controls below prove discovery finds something and
 *     the walker resolves something. Without them, a renamed file turns every
 *     assertion into a tautology over an empty set, and the suite still passes.
 *
 * ─── WHY THE IMPORT GRAPH, NOT A GREP ──────────────────────────────────────
 * Measured while building this: `rubrics:search` and `cupboard:search` contain
 * NO search mechanism in their own files, and neither does `recipes:search` —
 * all three delegate. A per-file grep reports "keyword-only" for a surface it
 * simply did not follow, and `recipes:search` (which really is engine-backed,
 * and really is missing its floor) would have been mis-diagnosed twice over.
 *
 * ⚠ The walk follows RELATIVE specifiers only — see `import-graph.ts` for the
 * bound. `cupboard:search` resolves a 1-module graph because it reaches its
 * implementation through a bare package specifier; its `engine: false` is
 * confirmed by the absence of any engine call there, not by graph depth.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { importGraph, stripComments } from './import-graph';
import {
  SEARCH_SURFACES,
  FLOOR_GAP_CEILING,
  RESULTS_DISCARDED_CEILING,
  CENSUS_EXCLUSIONS,
  type SearchSurface,
} from './surface-registry';

const HERE = dirname(new URL(import.meta.url).pathname);
const LIB = resolve(HERE, '..');
const AGENT_TOOLS = join(LIB, 'agent-tools');
const ROUTES = join(LIB, 'endpoint-route');
const POLICY_SEAM = join(LIB, 'search/configure-search-defaults.ts');

const abs = (s: SearchSurface) => join(LIB, s.entry);
const rel = (f: string) => relative(LIB, f);

/**
 * Every source file under `root` whose (comment-stripped) text satisfies
 * `match`. The census leans on this rather than on a candidate list, because
 * a list is only as complete as whoever wrote it — the `/api/harness/search`
 * miss that prompted this.
 *
 * Comments are stripped for the same reason the import walk strips them: a
 * doc-comment naming `runHybridSearch` would otherwise enrol a module that
 * never calls it, and a false POSITIVE here is the expensive direction — it
 * pushes someone to register or exclude a surface that does not exist.
 */
function walkLib(match: (src: string) => boolean, root: string = LIB): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      if (statSync(p).isDirectory()) {
        if (ent !== '__tests__' && ent !== 'node_modules') walk(p);
        continue;
      }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
      if (match(stripComments(readFileSync(p, 'utf8')))) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Tool files declaring a name in the search NAMING CLASS. */
function discoverSearchTools(): Array<{ id: string; file: string }> {
  const found: Array<{ id: string; file: string }> = [];
  const namePattern = /name:\s*'(search:[a-z0-9_-]+|[a-z0-9_]+:search)'/;
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent);
      if (statSync(p).isDirectory()) {
        if (ent !== '__tests__' && ent !== 'node_modules') walk(p);
        continue;
      }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
      const m = namePattern.exec(readFileSync(p, 'utf8'));
      if (m) found.push({ id: m[1], file: p });
    }
  };
  walk(AGENT_TOOLS);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** What a surface's code actually does, derived from its import graph. */
function derive(entry: string): { callsEngine: boolean; callsFulltext: boolean; hasFloor: boolean } {
  const g = importGraph(entry);
  // The graph walker already ignores comments when it derives edges; feature
  // detection must do the same. Otherwise a rationale that merely names
  // `runHybridSearch(` manufactures an engine call in an unrelated surface.
  const all = [entry, ...g.modules].map((m) => stripComments(readFileSync(m, 'utf8')));
  return {
    callsEngine: all.some((src) => /runHybridSearch\s*\(/.test(src)),
    callsFulltext: all.some((src) => /runFullTextSearch\s*\(/.test(src)),
    hasFloor: g.modules.has(POLICY_SEAM),
  };
}

/**
 * Does this module CONSUME what the engine returns, or throw it away?
 *
 * Derived per call site, in the file that makes the call — which is where the
 * property lives. (This is not the per-file grep D-027 ruling #1 rejects: that
 * one asked "does search happen here?", a question about a graph. This asks
 * "is this call's value used?", a question about one statement.)
 *
 * A call is DISCARDED when nothing precedes it on its line but optional
 * `await` / `void`. Anything else — an assignment, a `return`, being an
 * argument to something else — means a caller can see the results, so a
 * relevance floor has a result set to protect and the exemption is void.
 */
function consumesEngineResult(entry: string): boolean {
  return consumesEngineResultIn(readFileSync(entry, 'utf8'));
}

/**
 * The pure core, so the control below can drive it with fixture SOURCE rather
 * than fixture FILES. Writing a throwaway .ts into the tree to prove a guard
 * bites is unsafe here: git-sync sweeps the whole working tree into a commit
 * every few minutes, so a probe that dies between write and cleanup gets its
 * fixture committed.
 */
function consumesEngineResultIn(raw: string): boolean {
  const src = stripComments(raw);
  const call = /runHybridSearch\s*\(/g;
  for (let m = call.exec(src); m !== null; m = call.exec(src)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index).replace(/\b(?:await|void)\s+$/, '').trim();
    if (before !== '') return true;
  }
  return false;
}

/** The engine entrypoint a surface's code actually reaches. */
function deriveEngine(entry: string): 'hybrid' | 'fulltext' | 'none' {
  const d = derive(entry);
  // hybrid wins when both are present: a surface that can run a vector leg is
  // floor-bearing regardless of also offering a lexical path.
  return d.callsEngine ? 'hybrid' : d.callsFulltext ? 'fulltext' : 'none';
}

const registryById = new Map(SEARCH_SURFACES.map((s) => [s.id, s]));

describe('search surface conformance (P-021)', () => {
  describe('the registry covers every discovered surface', () => {
    it('every tool named *:search / search:* has a registry entry', () => {
      const missing = discoverSearchTools()
        .filter((t) => !registryById.has(t.id))
        .map((t) => `${t.id} (${rel(t.file)})`);
      expect(
        missing,
        missing.length
          ? `New search surface(s) with no registry entry. Add each to SEARCH_SURFACES in ` +
            `search/surface-registry.ts, declaring whether it runs the hybrid engine — and if it ` +
            `does NOT, say why. That declaration is the point: shipping a keyword-only search ` +
            `should be a decision someone wrote down, not an omission.\n  ${missing.join('\n  ')}`
          : '',
      ).toEqual([]);
    });

    it('no registry entry points at a file that no longer exists', () => {
      const stale = SEARCH_SURFACES.filter((s) => !existsSync(abs(s))).map((s) => s.id);
      expect(stale).toEqual([]);
    });

    it('every surface off the hybrid engine says WHY', () => {
      const unexplained = SEARCH_SURFACES.filter(
        (s) => s.engine !== 'hybrid' && !s.whyNotEngine?.trim(),
      ).map((s) => s.id);
      expect(unexplained).toEqual([]);
    });
  });

  describe('declarations match the code', () => {
    it.each(SEARCH_SURFACES.map((s) => [s.id, s] as const))(
      '%s: declared `engine` matches the entrypoint the graph actually reaches',
      (_id, surface) => {
        expect(deriveEngine(abs(surface))).toBe(surface.engine);
      },
    );

    it.each(
      SEARCH_SURFACES.filter(
        (s) => s.engine === 'hybrid' && !s.floorGap && !s.resultsDiscarded,
      ).map((s) => [s.id, s] as const),
    )(
      '%s: hybrid-engine-backed, so it MUST inherit the P-017 floor',
      (_id, surface) => {
        // An engine caller without the policy seam runs an unfloored vector
        // leg: it returns its k nearest rows whether or not any is a match,
        // and RRF then weights rank-1 noise like a rank-1 real hit.
        // Fix: `import '../../search/configure-search-defaults';` — but ONLY
        // after measuring the floor on THIS surface's corpus (see D-023/D-025;
        // plans cleared its margin by 0.0034).
        expect(derive(abs(surface)).hasFloor).toBe(true);
      },
    );
  });

  describe('the floor-gap set is shrink-only', () => {
    const gaps = SEARCH_SURFACES.filter((s) => s.floorGap);

    it(`holds at most ${FLOOR_GAP_CEILING} entr(y|ies)`, () => {
      expect(gaps.length).toBeLessThanOrEqual(FLOOR_GAP_CEILING);
    });

    it('every gap names a reason AND a tracking id', () => {
      for (const s of gaps) {
        expect(s.floorGap?.reason?.trim(), `${s.id} floorGap.reason`).toBeTruthy();
        expect(s.floorGap?.trackedBy, `${s.id} floorGap.trackedBy`).toMatch(/^(EI|WI)-\d+$/);
      }
    });

    it.each(gaps.map((s) => [s.id, s] as const))(
      '%s: the gap is still REAL — delete the entry once it is fixed',
      (_id, surface) => {
        // Without this, a fixed surface keeps its exemption forever and the
        // ceiling stops meaning anything. A gap entry that no longer describes
        // reality is itself the failure.
        expect(derive(abs(surface)).hasFloor).toBe(false);
      },
    );
  });

  describe('the CENSUS — completeness is derived, not claimed', () => {
    // Every module reachable from something we registered. An engine caller
    // does not need its OWN entry: `code-recipes-search.ts` is how
    // `recipes:search` reaches the engine, and covering it is exactly what
    // that entry means. What must not happen is an engine caller no entry can
    // reach at all.
    const covered = (): Set<string> => {
      const seen = new Set<string>();
      for (const s of SEARCH_SURFACES) {
        const e = abs(s);
        seen.add(e);
        for (const m of importGraph(e).modules) seen.add(m);
      }
      return seen;
    };

    const unregistered = (found: string[], reached: Set<string>) =>
      found.filter((f) => !reached.has(f) && !(rel(f) in CENSUS_EXCLUSIONS)).map(rel);

    it('every module that calls the engine is registered or excluded WITH A REASON', () => {
      const reached = covered();
      const callers = walkLib((src) => /run(?:Hybrid|FullText)Search\s*\(/.test(src));
      expect(
        unregistered(callers, reached),
        'A module calls the search engine and no registry entry reaches it. Add it to ' +
          'SEARCH_SURFACES, or to CENSUS_EXCLUSIONS with the reason it is not a product surface.',
      ).toEqual([]);
    });

    it('every route whose path contains "search" is registered or excluded WITH A REASON', () => {
      // The leg that would have caught `/api/harness/search`: it reaches no
      // engine, so the caller census above cannot see it. A surface that is
      // unranked BY OMISSION is invisible to a check that looks for engine
      // calls — which is precisely the surface most worth finding.
      const reached = covered();
      const routes = walkLib((src) => /path:\s*'[^']*search[^']*'/.test(src), ROUTES);
      expect(
        unregistered(routes, reached),
        'A route serves something search-shaped and no registry entry reaches it. Add it to ' +
          'SEARCH_SURFACES, or to CENSUS_EXCLUSIONS with the reason it is not one.',
      ).toEqual([]);
    });

    it('CONTROL: the census can SEE, and can say NO', () => {
      // Two ways this guard could pass while measuring nothing, both cheap to
      // rule out and neither visible from a green run.
      //
      // 1. The walk returns [] (a moved directory, a regex that stopped
      //    matching) and every assertion above passes over an empty set.
      const callers = walkLib((s) => /run(?:Hybrid|FullText)Search\s*\(/.test(s)).map(rel);
      expect(callers).toContain('code-recipes-search.ts');
      expect(callers.length).toBeGreaterThanOrEqual(8);

      const routes = walkLib((s) => /path:\s*'[^']*search[^']*'/.test(s), ROUTES).map(rel);
      // The surface that motivated the census. It reaches no engine at all, so
      // only the ROUTE leg can see it — if this drops out, the leg has stopped
      // covering the very case it was added for.
      expect(routes).toContain('endpoint-route/routes/harness/search.ts');
      expect(routes.length).toBeGreaterThanOrEqual(4);

      // 2. `unregistered` returns [] unconditionally. Drive it with a module
      //    that is neither reachable nor excluded and require it to complain.
      expect(unregistered([join(LIB, 'no-such-search-surface.ts')], covered())).toEqual([
        'no-such-search-surface.ts',
      ]);
      // ...and stay quiet for one that IS excluded, so it discriminates.
      const excluded = join(LIB, Object.keys(CENSUS_EXCLUSIONS)[0]);
      expect(unregistered([excluded], covered())).toEqual([]);
    });

    it('no exclusion is stale, and each states a reason', () => {
      for (const [path, reason] of Object.entries(CENSUS_EXCLUSIONS)) {
        expect(existsSync(join(LIB, path)), `excluded file is gone: ${path}`).toBe(true);
        expect(reason.trim().length, `${path} needs a real reason`).toBeGreaterThan(40);
      }
    });
  });

  describe('the results-discarded exemption is earned, not asserted', () => {
    const exempt = SEARCH_SURFACES.filter((s) => s.resultsDiscarded);

    it(`holds at most ${RESULTS_DISCARDED_CEILING} entr(y|ies)`, () => {
      // Capped for the FLOOR_GAP_CEILING reason, against a sharper risk: this
      // category describes a permanently-correct state, so unlike a gap it has
      // no natural pressure to shrink — which makes it the attractive place to
      // file an inconvenient surface.
      expect(exempt.length).toBeLessThanOrEqual(RESULTS_DISCARDED_CEILING);
    });

    it('every exemption states WHY', () => {
      for (const s of exempt) expect(s.resultsDiscarded?.trim(), `${s.id}`).toBeTruthy();
    });

    it.each(exempt.map((s) => [s.id, s] as const))(
      '%s: really does discard what the engine returns',
      (_id, surface) => {
        // The exemption's whole claim, re-derived. A surface that starts USING
        // its results has a result set again — and therefore needs the floor
        // again — so it must fail here rather than keep an exemption it no
        // longer earns.
        expect(consumesEngineResult(abs(surface))).toBe(false);
      },
    );
  });

  describe('CONTROLS — a guard whose subject vanished must fail, not pass', () => {
    it('the discard-derivation can observe a CONSUMING call', () => {
      // Without this, `consumesEngineResultIn` could return false
      // unconditionally and every exemption above would verify itself against
      // a derivation that cannot say "no".
      const consuming = [
        'const hits = await runHybridSearch(sources, {});',
        'return runHybridSearch(sources, {});',
        'const [a] = await Promise.all([runHybridSearch(sources, {})]);',
      ];
      for (const src of consuming) expect(consumesEngineResultIn(src), src).toBe(true);

      const discarded = [
        '  await runHybridSearch(sources, {});',
        '  void runHybridSearch(sources, {});',
      ];
      for (const src of discarded) expect(consumesEngineResultIn(src), src).toBe(false);

      // And a mention in a comment is not a call at all — the stripComments
      // dependency this shares with the import walk, exercised on this path.
      expect(consumesEngineResultIn('// const x = await runHybridSearch(a, {});')).toBe(false);
    });


    it('discovery finds a substantial set, including a known surface', () => {
      const ids = discoverSearchTools().map((t) => t.id);
      // If the tool-name spelling or the directory layout changes, discovery
      // silently returns [] and every coverage assertion above passes over an
      // empty set. This is the tripwire for that.
      expect(ids).toContain('docs:search');
      expect(ids.length).toBeGreaterThanOrEqual(8);
    });

    it('the derivation really can observe BOTH an engine call and the floor', () => {
      // docs:search is migrated and floored, so a walker that resolved nothing
      // would fail here rather than quietly reporting every surface as clean.
      const d = derive(join(LIB, 'agent-tools/docs/search.ts'));
      expect({ callsEngine: d.callsEngine, hasFloor: d.hasFloor }).toEqual({
        callsEngine: true,
        hasFloor: true,
      });
    });

    it('the derivation really can observe the ABSENCE of both', () => {
      // The opposite pole: a module with neither. Without this, a derivation
      // hard-wired to `true` would satisfy every assertion above.
      const d = derive(join(LIB, 'search/prose-vector-dims.ts'));
      expect({ callsEngine: d.callsEngine, hasFloor: d.hasFloor }).toEqual({
        callsEngine: false,
        hasFloor: false,
      });
    });

    it('an `export function` does not bind a distant `from` as its specifier', () => {
      // The real defect this caught: `lib/work-items.ts` reported a phantom
      // `../work-items` edge because an `export function` ~4600 lines above a
      // doc comment let the lazy middle scan forward into it. A false EDGE is
      // the dangerous direction — it makes an absence guard report a coupling
      // that is not there.
      const g = importGraph(join(LIB, 'work-items.ts'));
      expect(g.unresolved).toEqual([]);
    });

    it('comments are NOT read as imports', () => {
      // The first run of this suite reported `work-items.ts -> ../work-items`
      // as an unresolved specifier. There is no such import — the string sits
      // inside a doc comment. That fails in both directions, and the dangerous
      // one is a comment naming a heavy module manufacturing a reachability
      // edge that does not exist. `stripComments` is what prevents it; this is
      // the case that proves it is still doing so.
      const src = [
        "// import { a } from './commented-out';",
        "/* every existing `from '../work-items'` importer */",
        "import { real } from './prose-vector-dims';",
        "const url = 'https://example.test/not-a-comment';",
      ].join('\n');
      expect(stripComments(src)).not.toContain('commented-out');
      expect(stripComments(src)).not.toContain('../work-items');
      expect(stripComments(src)).toContain('./prose-vector-dims');
      // A `//` inside a string literal must survive, or stripping would eat code.
      expect(stripComments(src)).toContain('https://example.test/not-a-comment');
    });

    it('the import walk resolves cleanly for every registered surface', () => {
      // An unresolved relative specifier means the walk stopped early, so any
      // absence it reported downstream is unsound. Report them rather than
      // letting a truncated graph read as a clean one.
      const broken = SEARCH_SURFACES.flatMap((s) =>
        importGraph(abs(s)).unresolved.map((u) => `${s.id}: ${rel(u.from)} -> ${u.specifier}`),
      );
      expect(broken).toEqual([]);
    });
  });
});
