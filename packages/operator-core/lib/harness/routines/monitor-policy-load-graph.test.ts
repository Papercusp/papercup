/**
 * RECURRENCE GUARD for the P-004 load-graph regression.
 *
 * WHAT BROKE (2026-08-27): `harness/routines/loop.ts` began VALUE-importing the monitor
 * parsers, where it had previously carried only an erased `import type` from
 * `monitor-policy.ts`. That single edge dragged an 11-module chain into the
 * module-EVALUATION graph of every consumer of `loop.ts`:
 *
 *   loop -> monitor-standdown -> monitor-policy -> coordination/presence -> control-anchor
 *        -> presence-selfwake -> inbox-wake -> events/await/engine -> progress-lease
 *        -> predicate-watch -> projected-tool-deps -> capability-envelope/policy
 *
 * `capability-envelope/policy.ts` evaluates `AGENT_ROLES.filter(...)` at MODULE SCOPE, so
 * merely importing `loop.ts` now executed it. `continuity-probes.ts` dynamically imports
 * `./harness/routines/loop`, and `continuity-probes.test.ts` mocks `@papercusp/agent-mcp`
 * without `AGENT_ROLES` — so that test began failing on import alone, with an error naming
 * a file nobody had touched. It was green for 16 consecutive runs, then red.
 *
 * WHY A GUARD AND NOT JUST THE FIX: the failure surfaces in an unrelated test, blames an
 * unmodified file, and is invisible to typecheck (the graph is type-correct either way).
 * Nothing else in the tree fails when this edge comes back.
 *
 * THE RULE: the monitor lane's PURE half (parsers + `decideMonitorAdmission`) must stay
 * importable without paying for the I/O half. Keep the four I/O seams in `monitor-policy.ts`
 * type-only + `await import(...)`-ed at their call sites.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, '../..'); // packages/operator-core/lib
const POLICY = resolve(LIB, 'capability-envelope/policy.ts');

/**
 * Specifiers that load at MODULE-EVALUATION time.
 *
 * Deliberately excludes BOTH forms that do not:
 *  - `import type { X } from '...'` — erased by the compiler, costs nothing at runtime.
 *  - `await import('...')` / `import('...')` — deferred until the enclosing function RUNS.
 *
 * Getting either wrong makes this guard useless in opposite directions: following `import
 * type` reports edges that do not exist, and following dynamic `import()` reports a path
 * through every lazily-loaded module in the tree (which is how the original diagnosis of
 * this very bug first went wrong — a dynamic-following walk "found" a path that was
 * byte-identical in the known-good revision).
 */
export function staticValueImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*import\s+([\s\S]*?)\s*from\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (/^\s*type\b/.test(m[1] ?? '')) continue;
    out.push(m[2]!);
  }
  return out;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // bare specifier — not part of the local graph
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Shortest module-evaluation-time path from `entry` to `target`, or null. */
function staticPathTo(entry: string, target: string): string[] | null {
  const seen = new Set([entry]);
  const queue: Array<[string, string[]]> = [[entry, [entry]]];
  while (queue.length) {
    const [current, path] = queue.shift()!;
    if (path.length > 12) continue;
    let source: string;
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    for (const spec of staticValueImportSpecifiers(source)) {
      const next = resolveSpecifier(current, spec);
      if (!next || seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === target) return nextPath;
      seen.add(next);
      queue.push([next, nextPath]);
    }
  }
  return null;
}

const show = (p: string[] | null) => (p ? p.map((f) => relative(LIB, f)).join('\n  -> ') : 'none');

describe('monitor lane load graph — the pure half must not drag in the I/O half', () => {
  it.each([
    ['harness/routines/loop.ts', resolve(HERE, 'loop.ts')],
    ['harness/routines/monitor-policy.ts', resolve(HERE, 'monitor-policy.ts')],
    ['harness/routines/monitor-standdown.ts', resolve(HERE, 'monitor-standdown.ts')],
  ])('%s does not statically reach capability-envelope/policy.ts', (_label, entry) => {
    const path = staticPathTo(entry, POLICY);
    expect(
      path,
      `This module now loads capability-envelope/policy.ts at import time, which evaluates\n` +
        `AGENT_ROLES at module scope and breaks any test mocking @papercusp/agent-mcp.\n` +
        `Offending chain:\n  ${show(path)}\n\n` +
        `Fix: keep the new edge type-only, or defer it with await import(...) at the call site.`,
    ).toBeNull();
  });

  // ---- falsifiability: a guard that cannot fail proves nothing -------------------------

  it('CONTROL: the walker DOES find a real path when one genuinely exists', () => {
    // projected-tool-deps.ts statically imports capability-envelope/policy.ts. If this
    // stops finding a path, the walker is broken and the assertions above are vacuous.
    const path = staticPathTo(resolve(LIB, 'projected-tool-deps.ts'), POLICY);
    expect(path, 'walker failed to find a known-present static edge').not.toBeNull();
    expect(path!.at(-1)).toBe(POLICY);
  });

  it('CONTROL: `import type` is not followed (it is erased at runtime)', () => {
    expect(staticValueImportSpecifiers(`import type { A } from './a';`)).toEqual([]);
    expect(staticValueImportSpecifiers(`import { A } from './a';`)).toEqual(['./a']);
  });

  it('CONTROL: dynamic import() is not followed (it defers to call time)', () => {
    // This is the exact distinction that made the first diagnosis of this bug wrong.
    expect(staticValueImportSpecifiers(`const { a } = await import('./a');`)).toEqual([]);
    expect(staticValueImportSpecifiers(`void import('./a');`)).toEqual([]);
  });

  it('CONTROL: the real monitor-policy.ts still keeps its I/O seams deferred', () => {
    const src = readFileSync(resolve(HERE, 'monitor-policy.ts'), 'utf8');
    for (const io of [
      '../../agent-fleets-store',
      '../../agent-tools/coordination/presence',
      '../../work-items',
      '../../pg-read-query',
    ]) {
      const specs = staticValueImportSpecifiers(src);
      expect(specs, `${io} must not be a static value import in monitor-policy.ts`).not.toContain(
        io,
      );
    }
  });
});
