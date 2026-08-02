#!/usr/bin/env node
/**
 * check-no-raw-block-edge.mjs — fail-loud guard against a NEW feature→feature
 * `rel='blocks'` edge write that bypasses the acyclicity policy
 * (work-item-dependency-edges-2026-08-02, P-007 / D-013).
 *
 * WHY THIS IS A BUILD GUARD AND NOT A TEST. A feature→feature `blocks` CYCLE
 * permanently deadlocks the dispatch frontier: every feature in the cycle is
 * forever non-ready, because its blocker never terminates. The policy that
 * prevents this lives in ONE module — `packages/operator-core/lib/dbos/
 * feature-blockers-edges.ts` — via two sanctioned entry points:
 *
 *   - `syncFeatureBlockEdges(...)`  the AUTHORITATIVE replace-semantics writer,
 *     which enforces acyclicity itself (throws on a cycle-closing set);
 *   - `guardFeatureBlockEdgeAcyclic(src, dst)` for the ONE path that structurally
 *     cannot use the writer — the link tools add a SINGLE raw coord_links edge,
 *     while the writer is DELETE-all-then-INSERT, so routing a single-edge add
 *     through it would clobber the feature's other blockers.
 *
 * The existing acyclicity tests (feature-blockers-acyclicity{,.integration}.test.ts,
 * feature-blockers-edges.integration.test.ts, link.test.ts) cover the BEHAVIOUR of
 * those functions thoroughly. What they cannot cover is a NEW call site that never
 * calls them at all — a behaviour test cannot observe code that bypasses it. That
 * gap is exactly how the frontier acquires a silent, permanent deadlock, so it is
 * closed here at build time.
 *
 *   node scripts/check-no-raw-block-edge.mjs
 *
 * THE TELL — a WRITE of a blocks edge, never a read: the file touches a coord_links
 * WRITE primitive (`linkWorkItem(...)` or a raw `INSERT INTO harness_shared.coord_links`)
 * AND carries a `'blocks'` rel literal. A file is CLEARED when it references either
 * sanctioned entry point, since that means the policy is being applied. Comments are
 * stripped first, so prose about blocks edges never trips it.
 *
 * The match is FILE-LEVEL rather than argument-level, which is a measured trade — see
 * `writesRawBlocksEdge` for why the tighter form was implemented, tested, and rejected
 * (it missed the one real in-tree caller, which passes the rel as a variable).
 *
 * Deliberately NOT flagged (verified against the live tree): READS such as
 * `listIn(ref, { rel: 'blocks' })` / `listInMany(dsts, { rel: 'blocks' })` in
 * work-items-events.ts — reading the blocker set cannot create a cycle. A rel other
 * than 'blocks' is out of scope entirely: only feature→feature blocking deadlocks
 * the frontier.
 *
 * EXCLUDED (never scanned): vendored / build output / _retired / tests / non-source.
 *
 * ALLOWLIST: the policy module itself — it necessarily contains both the raw INSERT
 *   and the 'blocks' literal, and it IS the thing every other site must route through.
 *
 * BASELINE: EMPTY, and must stay empty. Verified 2026-08-02 across 5003 tracked .ts
 *   files: zero offenders. There is no grandfathered debt here, so a hit is always a
 *   genuine NEW bypass — never a BASELINE addition.
 *
 * The predicate (`writesRawBlocksEdge`) is exported + unit-tested
 * (packages/operator-core/lib/dbos/no-raw-block-edge-guard.test.ts) so the
 * "fails on a NEW bypass" property is durably verified rather than merely
 * green-on-a-clean-tree — a guard nobody has ever seen FAIL is not a guard.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Permanently-allowed files. ONLY the policy module: it holds the authoritative
 * writer + the tool-facing guard, so it legitimately contains the raw INSERT and
 * the 'blocks' literal. Nothing else belongs here — a new site that needs to write
 * a blocks edge should CALL one of its entry points, not be exempted from them.
 */
export const ALLOWLIST = new Set([
  // The policy module: holds the authoritative writer + the tool-facing guard, so it
  // legitimately contains the raw INSERT and the 'blocks' literal. It IS the thing
  // every other site must route through.
  'packages/operator-core/lib/dbos/feature-blockers-edges.ts',
  // The DEFINITION SITE of the generic `linkWorkItem` primitive (work-items.ts:5360) —
  // allowlisted the same way the sibling guards allowlist their own definition sites.
  // Verified 2026-08-02: it does not CALL linkWorkItem anywhere; its 'blocks' literals
  // are work_item_deps SQL (dep_type='blocks' — a different table), read-side
  // `links.listIn(target, { rel: 'blocks' })`, and the rel dispatch inside the
  // definition itself. A blocks-edge WRITE added here would need re-review by hand.
  'packages/operator-core/lib/work-items.ts',
]);

/**
 * Grandfathered offenders. EMPTY on purpose and must remain so — the tree was clean
 * when this guard landed, so any hit is a genuine new bypass to fix at the call site.
 */
export const BASELINE = new Set([]);

/** Vendored / generated / non-source / test files are never scanned. */
export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') ||
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  /\.(test|spec)\.[cm]?tsx?$/.test(f) ||
  !/\.(ts|mjs|cjs)$/.test(f);

/** Strip block + line comments so prose about blocks edges isn't flagged. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * A call into a coord_links WRITE primitive: the generic link writer, or a raw INSERT.
 * Reads (`listIn` / `listInMany` / `listOut`) are deliberately absent — reading a
 * blocker set cannot create a cycle.
 */
const WRITE_PRIMITIVE = /\blinkWorkItem\s*\(|INSERT\s+INTO\s+harness_shared\.coord_links/i;
/** A `blocks` rel literal in any quoting style. */
const BLOCKS_LITERAL = /['"`]blocks['"`]/;
/** Referencing either sanctioned entry point means the policy is being applied. */
const SANCTIONED = /syncFeatureBlockEdges|guardFeatureBlockEdgeAcyclic/;

/**
 * Does this source WRITE a feature→feature `blocks` edge without going through the
 * acyclicity policy? Pure (text → boolean) so it is unit-testable in isolation.
 *
 * FILE-LEVEL on purpose, and this is a deliberate trade rather than laziness. The
 * obvious tighter predicate — require the `'blocks'` literal INSIDE the call's own
 * arguments — was implemented first and MEASURED against the tree: it missed
 * `agent-tools/work_items/link.ts`, which passes the rel as a VARIABLE
 * (`linkWorkItem(it.id, dst, it.rel, ...)` after an `it.rel === 'blocks'` branch).
 * Since the one real in-tree caller already uses the variable form, a
 * literal-in-call predicate would miss the realistic bypass shape while looking
 * precise — the worst combination for a guard.
 *
 * So: a file that touches a coord_links write primitive AND traffics in a `blocks`
 * rel must reference the policy, or be allowlisted. Measured cost of the coarser
 * form on the live tree (2026-08-02, 5680 scanned files): exactly ONE additional
 * file, `work-items.ts`, which merely DEFINES linkWorkItem — allowlisted above with
 * a reason, the same way the sibling guards allowlist their own definition sites.
 */
export function writesRawBlocksEdge(text) {
  const t = stripComments(text);
  return WRITE_PRIMITIVE.test(t) && BLOCKS_LITERAL.test(t) && !SANCTIONED.test(t);
}

/**
 * Scan the tracked tree for offenders. Enumerates via `listTrackedFiles`, which
 * recurses into submodules — a bare `git ls-files` emits one gitlink entry per
 * submodule and would silently report ✓ for all of them (the WI-6730 failure the
 * sibling guards already learned). Returns coverage alongside offenders so `main`
 * can state what it could not check rather than implying a clean tree.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    if (writesRawBlocksEdge(text)) offenders.push(f);
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ no feature→feature `blocks` edge write bypasses the acyclicity policy.' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ blocks-edge write(s) bypassing the acyclicity policy:');
  console.error('  A feature→feature `blocks` CYCLE permanently deadlocks the dispatch frontier —');
  console.error('  every feature in the cycle is forever non-ready. Route the write through one of:');
  console.error('    syncFeatureBlockEdges(harness, featureId, blockedBy)   — the authoritative writer');
  console.error('    guardFeatureBlockEdgeAcyclic(srcRef, dstRef)           — for a single raw edge');
  console.error('  both from packages/operator-core/lib/dbos/feature-blockers-edges.ts.\n');
  for (const o of offenders) console.error('    ' + o);
  console.error(
    `\n  ${offenders.length} offender(s). See plan work-item-dependency-edges-2026-08-02 (P-007 / D-013).`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
