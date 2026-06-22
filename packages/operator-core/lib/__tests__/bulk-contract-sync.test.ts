/**
 * bulk-contract-sync.test.ts — the consistency GUARD for the keyed-array bulk
 * I/O contract (bulk-endpoint-standardization-2026-06-21 P-007).
 *
 * The contract (D-001, helpers in packages/agent-mcp/src/_bulk.ts):
 *   INPUT   a scalar OR an array on the logical id field (`id`/`ids`,
 *           `spawn_id`/`spawn_ids`, `key`/`keys`, … or a compound `items:[{…}]`),
 *           so a single call is n=1 of the bulk call.
 *   OUTPUT  `{ ok:true, results:[{ ok, <key>, …|error }], counts:{ ok, failed } }`
 *           — produced ONCE, by `runBulk` in _bulk.ts, serialized by `bulkContent`.
 *
 * Every bulk verb routes its output through `_bulk` rather than re-hand-rolling
 * the loop + envelope. This lint is the growth ratchet: it discovers the bulk
 * tools by their `_bulk` footprint and asserts each one honors the whole
 * contract, so a NEW bulk-shaped tool that forgets a piece (returns a raw object
 * instead of `bulkContent`, hand-loops instead of `runBulk`, or omits the
 * dual-arity scalar seam) fails CI here.
 *
 * Pure-static — no operator process, no runtime catalog load. It greps the
 * defineTool source (same discovery walk as tools-md-sync.test.ts), so it cannot
 * be fooled by a tool that imports `_bulk` for types but bypasses it at runtime.
 *
 * SCOPE / what it does NOT assert: the exact dual-arity ARG NAMES vary per tool
 * (`id`/`ids`, `pid`/`pids`, compound `items:[]`, numeric `toList` merges, …), so
 * a precise per-arg static schema check would be brittle and false-positive-prone.
 * Instead it asserts the four invariants that hold UNIFORMLY across every shape
 * (import _bulk · call runBulk · return bulkContent · expose a scalar+array seam
 * via mergeIds/toList/scalarOrArray OR an `items:` array arg). The carve-outs
 * that are deliberately NOT bulk-of-single (fleet:place_batch, deploy:hive —
 * composites per D-002) never import `_bulk`, so they are invisible to the
 * discovery walk and correctly un-flagged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../');

// ─── discover defineTool files (mirrors tools-md-sync.test.ts) ─────────

const TOOL_FILES: string[] = [];
function findToolFiles(dir: string) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findToolFiles(full);
    } else if (entry.endsWith('.ts') && !entry.includes('.test.') && !entry.startsWith('index.')) {
      TOOL_FILES.push(full);
    }
  }
}
findToolFiles(join(REPO, 'packages/agent-mcp/src/tools'));
findToolFiles(join(REPO, 'packages/operator-core/lib/agent-tools'));

// The _bulk implementation file itself defines the helpers — exclude it; it is
// not a tool and would otherwise self-match every check.
const BULK_IMPL_RE = /agent-tools\/_bulk\.ts$|agent-mcp\/src\/_bulk\.ts$/;

interface BulkTool {
  name: string;
  source: string; // repo-relative
  src: string;
}

/** A file is a candidate bulk tool when it defines a tool AND imports from a
 *  `_bulk` module (the contract source — re-exported at
 *  @papercusp/agent-mcp/_bulk and ../_bulk). The leaf-subpath + barrel re-export
 *  spellings (P-005) all contain `_bulk` in the import specifier. */
function importsBulk(src: string): boolean {
  return /from\s+['"][^'"]*_bulk['"]/.test(src);
}

function toolName(src: string): string | null {
  // Require a separator (`:` or `.`) so we skip inline `name: 'project'` args.
  const m = src.match(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/);
  return m ? m[1] : null;
}

const BULK_TOOLS: BulkTool[] = [];
for (const file of TOOL_FILES) {
  if (BULK_IMPL_RE.test(file)) continue;
  const src = readFileSync(file, 'utf8');
  if (!src.includes('defineTool(')) continue;
  if (!importsBulk(src)) continue;
  const name = toolName(src);
  if (!name) continue;
  BULK_TOOLS.push({ name, src, source: file.replace(REPO + '/', '') });
}

// Scalar+array merge helpers a tool may call from _bulk (the n=1-≡-bulk-of-one
// seam). Generic-tolerant (`toList<number>(`) — trust uses numeric ids.
const SEAM_HELPERS = ['mergeIds', 'toList', 'scalarOrArray'];

function usesSeamHelper(src: string): boolean {
  return SEAM_HELPERS.some((id) => new RegExp(`\\b${id}(<[^>]*>)?\\s*\\(`).test(src));
}

/** Detect the dual-arity scalar+array INPUT seam — "a single call is n=1 of the
 *  bulk call". Three equivalent forms across the converted tools (verified to
 *  cover the full set):
 *   1. a scalar+array merge helper is CALLED (mergeIds / toList / scalarOrArray)
 *      — e.g. work_items:get `mergeIds(args.id, args.ids)`, trust:add
 *      `toList<number>(…)`, locks:release `mergeIds(args.lock_id, args.lock_ids)`;
 *   2. a plural id-array arg `*ids:`/`*Ids: z.array(…)` (the homogeneous "many"
 *      half paired with a scalar singular) — e.g. processes:kill `pids:`,
 *      issues:claim `ids:`, plans:set-status `itemIds:`;
 *   3. a compound `items: z.array(…)` arg (the heterogeneous-record path) — e.g.
 *      features:get `items:[{ slug, feature_id }]`, coord:send `items:[{ to,… }]`.
 *  (2)/(3) are matched whitespace-tolerantly so a multi-line `items: z\n .array(`
 *  declaration still counts. */
function hasDualAritySeam(src: string): boolean {
  if (usesSeamHelper(src)) return true;
  if (/\b[a-zA-Z_]*(?:ids|Ids):\s*z\.array\(/.test(src)) return true;
  // Whitespace-collapsed so a multi-line `items: z\n  .array(...)` arg matches.
  const collapsed = src.replace(/\s+/g, '');
  if (/items:z\.array\(/.test(collapsed)) return true;
  return false;
}

// ─── tests ─────────────────────────────────────────────────────────────

describe('bulk-contract-sync (P-007 guard)', () => {
  it('discovered a non-trivial set of bulk tools', () => {
    // P-001..P-006 converted ~60+ verbs; a regression that silently drops the
    // _bulk footprint from all of them (e.g. a bad refactor of the helper) should
    // trip this floor rather than vacuously passing the per-tool checks below.
    expect(
      BULK_TOOLS.length,
      `Found only ${BULK_TOOLS.length} _bulk-importing tools — expected the full converted set. ` +
        `Did the discovery walk or the _bulk import spelling change?`,
    ).toBeGreaterThan(40);
  });

  it('every bulk tool produces the envelope via runBulk (never hand-rolls the loop)', () => {
    const offenders = BULK_TOOLS.filter((t) => !/\brunBulk\s*\(/.test(t.src)).map((t) => `${t.name} (${t.source})`);
    expect(
      offenders,
      `These tools import _bulk but never call runBulk — they hand-roll the per-item ` +
        `loop/never-throw/counts envelope instead of routing through the one contract impl. ` +
        `Build the { ok, results, counts } envelope with runBulk(items, op, { keyOf }):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every bulk tool serializes its result through bulkContent', () => {
    const offenders = BULK_TOOLS.filter((t) => !/\bbulkContent\s*\(/.test(t.src)).map((t) => `${t.name} (${t.source})`);
    expect(
      offenders,
      `These tools call runBulk but do not return via bulkContent — the ToolResult must be ` +
        `bulkContent(env) so the framework's mcp-only TOON re-encode (P-002/D-008) can see the ` +
        `{ ok, results:[…], counts } envelope:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every bulk tool exposes the dual-arity scalar+array input seam (n=1 ≡ bulk-of-one)', () => {
    const offenders = BULK_TOOLS.filter((t) => !hasDualAritySeam(t.src)).map((t) => `${t.name} (${t.source})`);
    expect(
      offenders,
      `These bulk tools route through runBulk/bulkContent but expose NO scalar+array input seam ` +
        `(no mergeIds/toList/scalarOrArray call and no \`items: z.array(…)\` arg). The contract is ` +
        `that a single call is n=1 of the bulk call — accept a scalar id (n=1 shorthand) OR an array/items[]:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the carve-out composites do NOT import _bulk (they are not bulk-of-single)', () => {
    // D-002: fleet:place_batch (affinity ranking + warm-inject + overflow) and
    // deploy:hive (queen/swarm topology) are composites, intentionally NOT the
    // keyed-array contract. Guard the carve-out so a future edit can't quietly
    // pull them under the contract (or vice-versa, leaving them half-converted).
    const carveOuts = [
      'packages/operator-core/lib/agent-tools/fleet/place_batch.ts',
      'packages/operator-core/lib/agent-tools/deploy/hive.ts',
    ];
    const violations: string[] = [];
    for (const rel of carveOuts) {
      const full = join(REPO, rel);
      if (!existsSync(full)) {
        violations.push(`${rel} (MISSING — carve-out moved/renamed; update this guard)`);
        continue;
      }
      if (importsBulk(readFileSync(full, 'utf8'))) {
        violations.push(`${rel} (now imports _bulk — if it was deliberately converted, drop it from the carve-out list)`);
      }
    }
    expect(violations, `Carve-out invariant broken:\n  ${violations.join('\n  ')}`).toEqual([]);
  });
});
