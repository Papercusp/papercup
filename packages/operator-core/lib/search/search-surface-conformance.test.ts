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
import { SEARCH_SURFACES, FLOOR_GAP_CEILING, type SearchSurface } from './surface-registry';

const HERE = dirname(new URL(import.meta.url).pathname);
const LIB = resolve(HERE, '..');
const AGENT_TOOLS = join(LIB, 'agent-tools');
const POLICY_SEAM = join(LIB, 'search/configure-search-defaults.ts');

const abs = (s: SearchSurface) => join(LIB, s.entry);
const rel = (f: string) => relative(LIB, f);

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
  const all = [entry, ...g.modules].map((m) => readFileSync(m, 'utf8'));
  return {
    callsEngine: all.some((src) => /runHybridSearch\s*\(/.test(src)),
    callsFulltext: all.some((src) => /runFullTextSearch\s*\(/.test(src)),
    hasFloor: g.modules.has(POLICY_SEAM),
  };
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
      SEARCH_SURFACES.filter((s) => s.engine === 'hybrid' && !s.floorGap).map(
        (s) => [s.id, s] as const,
      ),
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

  describe('CONTROLS — a guard whose subject vanished must fail, not pass', () => {
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
