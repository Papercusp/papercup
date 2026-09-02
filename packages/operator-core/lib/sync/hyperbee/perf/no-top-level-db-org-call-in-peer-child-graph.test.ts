/**
 * The perf peer-child resolves `@papercusp/db-org` to `no-pg-stub.mjs` (see no-pg-hooks.mjs),
 * whose every binding THROWS when called. A module that calls one of those bindings at MODULE
 * TOP LEVEL therefore kills the child during import — before it can emit a single event.
 *
 * This is a DIFFERENT failure mode from its sibling guard `no-pg-stub-covers-db-org-imports`,
 * and neither catches the other:
 *
 *   sibling  — the stub does not EXPORT a name someone imports  → SyntaxError at LINK time.
 *   this one — the stub exports it fine, but a module CALLS it at import time → the stub's own
 *              `throw` at EVALUATE time.
 *
 * Both surface identically and uselessly: `child-driver.ts` routes the child's stderr into a
 * `logs` array that the failing assertion never prints, so the parent sees only
 * `expected null to match object { evt: 'ready' }` after a 30-second wait — a timeout that names
 * nothing. Diagnosing it requires booting the child by hand with its stderr attached.
 *
 * MEASURED (WI-2141279, 2026-09-02): `projections/harness-plans.ts` began importing
 * `deriveIndexFromContent` from `agent-tools/plans/source` at 2026-09-01T03:12Z. `source.ts` is
 * the plans data-access layer, so that one import put this chain into the child's graph —
 *
 *   peer-child → sync/hyperbee/boot → projections/register-all → projections/harness-plans
 *     → agent-tools/plans/source → fleet-drained-events → events/await/engine
 *     → agent-tools/coordination/messages → coordination/audience-host
 *     → agent-tools/locks/su-lock-store → agent-tools/locks/configure
 *
 * — and `locks/configure.ts` calls `setAdminPoolStatementTimeoutProvider(...)` at column 0.
 * Every peer-child died on import; `child-driver.test.ts` went red on the green-checkpoint gate
 * and stayed red (last pass 2026-09-01T02:29Z; 26 consecutive fails after). The `deriveIndexFromContent`
 * derivation is PURE, so the fix was to extract it to the leaf `agent-tools/plans/derive-index`
 * — but nothing stops the next import from re-acquiring the data layer, which is what this guard
 * is for.
 *
 * SCOPE — the child's own RUNTIME import graph, NOT a directory tree. That is deliberate and is
 * the opposite choice from the sibling guard, for a real reason: a top-level db-org call is
 * perfectly CORRECT in a module the child never imports (`locks/configure.ts` is right to do it
 * for the operator host — it must register its provider before the first pool is built). Only
 * reachability from `peer-child.ts` makes such a call fatal, so only the graph can answer it.
 * Type-only imports are excluded because tsx/esbuild erase them, so they create no runtime edge.
 *
 * ⚠ A GRAPH-SCOPED GUARD FAILS OPEN IF ITS WALK STOPS SHORT, and that is not hypothetical here:
 * the sibling guard sat GREEN AND BLIND through this exact break because its scan root was
 * narrower than the child's real graph. A walk that silently resolves nothing would report a
 * clean bill of health for every possible violation. So the calibration assertions below are
 * load-bearing, not ceremony: they fail if the walk shrinks or stops reaching known-deep modules.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PEER_CHILD = fileURLToPath(new URL('./peer-child.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

/**
 * A relative import/export specifier, and whether the whole statement is type-only.
 * `import type { X } from './y'` and `export type { X } from './y'` are erased at build time
 * and create NO runtime edge, so following them would inflate the graph with modules the child
 * never actually loads (and produce false positives).
 */
const RELATIVE_EDGE = /(?:^|\n)\s*(?:import|export)(\s+type)?\s[^;]*?from\s*['"](\.[^'"]*)['"]/g;
/** Bare side-effect import: `import './x'` — always a runtime edge. */
const SIDE_EFFECT_EDGE = /(?:^|\n)\s*import\s*['"](\.[^'"]*)['"]/g;

/** `{ … }` bound against '@papercusp/db-org'; group 1 = `type` when the statement is type-only. */
const DB_ORG_CLAUSE =
  /(?:import|export)(\s+type)?\s+(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@papercusp\/db-org['"]/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Runtime (value) relative edges only — type-only statements are erased and never followed. */
function runtimeEdges(file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RELATIVE_EDGE)) {
    if (m[1]) continue; // `import type … from` / `export type … from`
    const r = resolveRelative(file, m[2]);
    if (r) out.push(r);
  }
  for (const m of text.matchAll(SIDE_EFFECT_EDGE)) {
    const r = resolveRelative(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

/** Names bound as VALUES from db-org (a `type` specifier binds nothing at runtime). */
export function dbOrgValueNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(DB_ORG_CLAUSE)) {
    if (m[1]) continue; // whole statement is `import type`
    for (const item of m[2].split(',')) {
      const cleaned = item.trim();
      if (!cleaned || /^type\s/.test(cleaned)) continue; // inline `type X` specifier
      const local = (cleaned.split(/\s+as\s+/)[1] ?? cleaned).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) names.push(local);
    }
  }
  return names;
}

/**
 * Top-level invocations of `names` in `text`, as `{ name, line }`.
 *
 * A module-top-level statement sits at column 0 in this Prettier-formatted tree, while anything
 * inside a function/class body is indented — so zero indentation is the discriminator. This
 * deliberately catches the assignment form too (`export const pool = getOrgPg();`), which is just
 * as fatal as a bare call.
 *
 * The exclusions below are all EAGER-vs-LAZY distinctions, and each was earned:
 *   - comment/import lines — a name merely mentioned in prose is not a call;
 *   - `function` / `class` declarations — a db-org call in a DEFAULT PARAMETER runs per-call, not
 *     at import. MEASURED: the first run of this guard flagged
 *     `p2p/foreign-workspaces.ts:268`, `export async function listLiveForeignRoots(sql = getOrgPg().sql)`,
 *     which is perfectly safe and which the child in fact imports and boots through;
 *   - any line containing `=>` — an arrow function's params and body are likewise deferred.
 */
export function topLevelCalls(text: string, names: readonly string[]): Array<{ name: string; line: number }> {
  if (names.length === 0) return [];
  const hits: Array<{ name: string; line: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || line === '') continue; // indented ⇒ inside a body
    if (/^(?:import|export\s+type|\/\/|\/\*|\*)/.test(line.trim()) || line.startsWith('*')) continue;
    // Deferred-evaluation forms: a declaration's default parameters, or any arrow function.
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(line)) continue;
    if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(line)) continue;
    if (line.includes('=>')) continue;
    for (const name of names) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(line)) hits.push({ name, line: i + 1 });
    }
  }
  return hits;
}

function walkChildGraph(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [PEER_CHILD];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.set(file, text);
    for (const next of runtimeEdges(file, text)) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

describe('no module in the perf peer-child import graph calls @papercusp/db-org at top level', () => {
  it('detects a top-level db-org call (detector calibration)', () => {
    // A permanent deliberately-violating fixture. Without it, a detector broken by a regex edit
    // would report "no violations" — indistinguishable from a clean tree, which is precisely the
    // silent-pass this guard exists to prevent.
    const violating = [
      `import { setAdminPoolStatementTimeoutProvider } from '@papercusp/db-org';`,
      `import { adminPoolStatementTimeoutMs } from '../../txn-timeouts-config';`,
      ``,
      `setAdminPoolStatementTimeoutProvider(adminPoolStatementTimeoutMs);`,
    ].join('\n');
    const names = dbOrgValueNames(violating);
    expect(names).toContain('setAdminPoolStatementTimeoutProvider');
    expect(topLevelCalls(violating, names)).toEqual([
      { name: 'setAdminPoolStatementTimeoutProvider', line: 4 },
    ]);

    // ...and does NOT fire on the two shapes that are safe: a call INSIDE a function body, and a
    // type-only binding (erased at build time, so it can never be called at all).
    const safe = [
      `import { getOrgPg } from '@papercusp/db-org';`,
      `import type { OrgPg } from '@papercusp/db-org';`,
      ``,
      `export function later(): OrgPg {`,
      `  return getOrgPg();`,
      `}`,
      ``,
      // The real shape that produced this guard's first false positive
      // (p2p/foreign-workspaces.ts:268): a default parameter, evaluated per CALL.
      `export async function listLiveForeignRoots(sql: OrgSql = getOrgPg().sql) {`,
      `  return sql;`,
      `}`,
      ``,
      // Same deferral, arrow form.
      `export const lazily = (sql = getOrgPg().sql) => sql;`,
    ].join('\n');
    expect(dbOrgValueNames(safe)).toEqual(['getOrgPg']);
    expect(topLevelCalls(safe, dbOrgValueNames(safe))).toEqual([]);

    // ...but the EAGER assignment form is still caught — the exclusions above must not have
    // widened into "anything with an `=` is fine".
    const eager = [
      `import { getOrgPg } from '@papercusp/db-org';`,
      ``,
      `export const pool = getOrgPg();`,
    ].join('\n');
    expect(topLevelCalls(eager, dbOrgValueNames(eager))).toEqual([{ name: 'getOrgPg', line: 3 }]);
  });

  it('walks the real child graph deeply enough to be able to fail (scope calibration)', () => {
    const graph = walkChildGraph();
    const rel = [...graph.keys()].map((f) => f.slice(REPO_ROOT.length));

    // A walk that resolved almost nothing would pass the real assertion vacuously.
    expect(graph.size).toBeGreaterThan(50);

    // Known-deep modules the child genuinely loads. If a resolver or regex change makes the walk
    // stop short, these fail LOUDLY here instead of quietly shrinking the guarded set to nothing.
    for (const must of [
      'packages/operator-core/lib/sync/hyperbee/boot.ts',
      'packages/operator-core/lib/sync/hyperbee/projections/register-all.ts',
      'packages/operator-core/lib/sync/hyperbee/projections/harness-plans.ts',
    ]) {
      expect(rel, `child graph walk no longer reaches ${must} — the walk broke, not the tree`).toContain(must);
    }
  });

  it('has no module reaching db-org at import time', () => {
    const graph = walkChildGraph();
    const violations: string[] = [];

    for (const [file, text] of graph) {
      if (!text.includes('@papercusp/db-org')) continue;
      const names = dbOrgValueNames(text);
      for (const hit of topLevelCalls(text, names)) {
        violations.push(`  ${file.slice(REPO_ROOT.length)}:${hit.line}  ${hit.name}(...)`);
      }
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : `${violations.length} module(s) in the perf peer-child's import graph call ` +
          `'@papercusp/db-org' at MODULE TOP LEVEL. Every binding in no-pg-stub.mjs throws, so ` +
          `each of these kills the child during import — surfacing only as an opaque 30s ` +
          `"expected null to match object { evt: 'ready' }" in child-driver.test.ts.\n\n` +
          `${violations.join('\n')}\n\n` +
          `Fix the GRAPH, not the stub: the call itself is usually correct for the operator host ` +
          `— what is wrong is that the perf child reaches it. Import the pure leaf you actually ` +
          `need (e.g. 'agent-tools/plans/derive-index', not 'agent-tools/plans/source'), or make ` +
          `the offending module's registration lazy. Do NOT soften no-pg-stub.mjs: the throwing ` +
          `binding is what keeps a perf run that reaches Postgres from being read as a measurement.`,
    ).toEqual([]);
  });
});
