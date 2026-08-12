#!/usr/bin/env node
/**
 * check-no-raw-harness-sentinel.mjs — fail-loud guard against a NEW use of the
 * operator-scope `ctx.harnessSlug` sentinel as though it were a concrete slug.
 *
 * `http-projection` sets `ctx.harnessSlug = '*'` for every superuser/operator-scope
 * call. `'*'` is a real, truthy string, but it is not a registered harness. A raw
 * nullish fallback (`args.harness ?? ctx.harnessSlug ?? ''`), an identity field
 * (`{ harnessSlug: ctx.harnessSlug }`), or a non-sentinel predicate therefore
 * silently addresses the wrong bucket. The failure is usually an empty result or
 * a no-op write, not an exception.
 *
 * The canonical resolver seams are `resolveHarnessScope`,
 * `resolveConcreteHarnessSlug`, `resolvePotHomeSlug`, `harnessScopedCtx`, and
 * `isAllHarnessSentinel`. New code should route through one of those seams before
 * using the value as an identity. This guard intentionally detects only the
 * high-signal syntactic shapes (fallbacks, identity-bearing object fields, and
 * non-sentinel predicates); free-form metadata and log labels are not identities.
 *
 *   node scripts/check-no-raw-harness-sentinel.mjs
 *   node scripts/check-no-raw-harness-sentinel.mjs --list
 *
 * `--list` is the measurement command used to seed the shrink-only BASELINE. It
 * lists every candidate, including existing candidates that are still being
 * audited. A new candidate is never made green by adding it to BASELINE: fix it,
 * route it through a resolver, or record a relation-level allowlist decision.
 *
 * The predicate and real-tree scanner are exported + unit-tested in
 * `packages/operator-core/lib/agent-tools/no-raw-harness-sentinel-guard.test.ts`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';
import { stripCommentsAndStrings, stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** The detector itself contains its own syntax examples and is therefore exempt. */
export const ALLOWLIST = new Set(['scripts/check-no-raw-harness-sentinel.mjs']);

/**
 * Existing, measured candidates pending an audit. This set may only shrink.
 *
 * Measured at HEAD f0338f50b55fb0710f082c7883ecb2a37d0e88fe with `--list` on
 * 2026-08-12. The issue deliberately did not claim these sites were all defects:
 * they are the population the detector makes visible so each relation/call-site
 * can be audited without silently growing the grandfather set. The capability:bash
 * site was subsequently fixed through the canonical resolver, shrinking the
 * pending baseline to 67. The facts:assert site was then fixed through the same
 * resolver, shrinking the pending baseline to 66. The work-items:update plan
 * stamp sites were then fixed through the same resolver, shrinking it to 63.
 * A source fingerprint makes a moved or rewritten site fail closed.
 */
export const BASELINE = new Set([
  "libs/generic/tooldef/src/dispatch-stack.ts:360:predicate:const slug = ctx.harnessSlug?.trim();",
  "libs/papercusp/packages/orchestrator/src/state-pg.ts:118:fallback:ON hfc.harness_slug = ${ctx.harnessSlug ?? ''}",
  "libs/papercusp/packages/orchestrator/src/state-pg.ts:146:fallback:AND harness_slug  = ${ctx.harnessSlug ?? ''}",
  "libs/papercusp/packages/orchestrator/src/state.ts:66:fallback:ctx.harnessSlug ??",
  "packages/operator-core/lib/agent-tools/cell-reader-ctx.ts:50:identity-field:...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/cell-reader-ctx.ts:54:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/code/run.ts:992:fallback:harness: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/conventions/governing.ts:92:fallback:const harness = (args.harness ?? ctx.harnessSlug ?? '').trim();",
  "packages/operator-core/lib/agent-tools/coordination/coupled-topics-read.ts:72:identity-field:...(ctx.harnessSlug ? { harnessSlug: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/coordination/identity.ts:367:fallback:? `${sysRole} · ${ctx.harnessSlug ?? 'system'}`",
  "packages/operator-core/lib/agent-tools/datatypes/declare.ts:227:fallback:potSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/dev/pg_query.ts:170:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/dev/why.ts:45:fallback:harnessSlug: args.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/events/watch.ts:241:fallback:const harnessSlug = ctx.harnessSlug ?? null;",
  "packages/operator-core/lib/agent-tools/facts/scope-ctx.ts:56:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/improvements/resolve.ts:86:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/recipes/run.ts:210:identity-field:...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/recipes/run.ts:303:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/recipes/search.ts:97:identity-field:...(ctx.harnessSlug ? { harness: ctx.harnessSlug } : {}),",
  "packages/operator-core/lib/agent-tools/state/read.ts:116:fallback:harnessSlug: ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/state/read.ts:151:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/state/subscribe.ts:94:fallback:harnessSlug: ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/testing/flakiness.ts:40:fallback:const harnessSlug = args.harness ?? ctx.harnessSlug ?? undefined;",
  "packages/operator-core/lib/agent-tools/testing/flakiness.ts:70:identity-field:{ ownerId: ident.ownerId, workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug },",
  "packages/operator-core/lib/agent-tools/tools/define.ts:103:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:249:fallback:harness: args.harness ?? ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:274:fallback:harness: args.harness ?? ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:346:fallback:harnessSlug: args.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/agent-tools/work_items/_create-core.ts:405:fallback:const planItemStampHarness = harnessForItem ?? ctx.harnessSlug ?? undefined;",
  "packages/operator-core/lib/agent-tools/work_items/arm-reversible-work-item.ts:151:fallback:harnessSlug: ctx.harnessSlug ?? prior.harness ?? null,",
  "packages/operator-core/lib/agent-tools/work_items/create.ts:285:identity-field:const createCtx = { ownerId: ident.ownerId, workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug };",
  "packages/operator-core/lib/agent-tools/work_items/create.ts:472:fallback:harness: s.harness ?? ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/blueprint-steps/ops/calibration-resolve.ts:55:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/change-ledger-scan.ts:56:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/deferral-interest-refit.ts:58:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/fleet-ekg-scan.ts:78:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/graduation-scan.ts:68:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/hive-eval-gen.ts:60:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/iq-battery-gen.ts:60:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/memory-live-recall-canary.ts:52:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/memory-precision-bench.ts:53:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/negative-space-scan.ts:63:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/neologism-mine.ts:69:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/prompt-ablation.ts:61:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/red-queen-drill.ts:50:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/regret-mine.ts:68:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/scout-cycle.ts:83:fallback:const perHiveInstall = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/blueprint-steps/ops/transfer-distill.ts:72:fallback:const installSlug = ctx.harnessSlug ?? 'op';",
  "packages/operator-core/lib/coord-ops/ops/compose.ts:130:identity-field:harness: ctx.harnessSlug,",
  "packages/operator-core/lib/coord-ops/ops/thread-open.ts:35:fallback:harness: a.harness ?? ctx.harnessSlug,",
  "packages/operator-core/lib/decision-ledger/emit.ts:141:fallback:harnessSlug: ctx.harnessSlug ?? null,",
  "packages/operator-core/lib/deployment/frame-installer.ts:139:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/deployment/headless-peer.ts:86:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/endpoint-route/routes/plugins/catchall.ts:36:fallback:console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);",
  "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-handler.ts:1890:predicate:spawnRes.ctx.harnessSlug === '*' &&",
  "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-slash-prompts.ts:135:identity-field:harness: ctx.harnessSlug,",
  "packages/operator-core/lib/events/reaction-id.ts:33:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/events/rules.ts:52:fallback:harness_slug: e.ctx.harnessSlug ?? undefined,",
  "packages/operator-core/lib/fleet/bee-completion-reconcile.ts:162:identity-field:{ harnessSlug: ctx.harnessSlug, featureId: ctx.featureId, workspaceId: ctx.workspaceId },",
  "packages/operator-core/lib/gym/control-plane.ts:706:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/gym/control-plane.ts:721:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/harness-ops/proxy.ts:58:identity-field:harnessSlug: ctx.harnessSlug,",
  "packages/operator-core/lib/projected-tool-deps.ts:534:fallback:input.ctx.harnessSlug ?? \"\",",
]);

/** Vendored/generated/test files are not operator source and are not scanned. */
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
  !/\.(ts|tsx|mjs|cjs)$/.test(f);

const CTX_HARNESS = /\bctx(?:\?\.)?\.harnessSlug\b/;
const RAW_FALLBACK = /(?:\?\?|\|\|)\s*ctx(?:\?\.)?\.harnessSlug\b|\bctx(?:\?\.)?\.harnessSlug\s*(?:\?\?|\|\|)/;
const IDENTITY_FIELD = /\b(?:harness|harnessSlug|harness_slug|installSlug|potSlug)\s*:\s*(?:[^,\n]*?\s)?ctx(?:\?\.)?\.harnessSlug\b/;
const NON_SENTINEL_PREDICATE =
  /(?:\bctx(?:\?\.)?\.harnessSlug\s*(?:===|!==|==|!=)\s*(?!['"]\s*(?:\*|all)\s*['"])|(?:===|!==|==|!=)\s*ctx(?:\?\.)?\.harnessSlug\b)/;
const TRUTHINESS_PREDICATE =
  /(?:\bif\s*\(\s*ctx(?:\?\.)?\.harnessSlug\s*\)|\bwhile\s*\(\s*ctx(?:\?\.)?\.harnessSlug\s*\)|\bctx(?:\?\.)?\.harnessSlug\s*\?)/;
const SAFE_RESOLVER =
  /\b(?:resolveHarnessScope|resolveConcreteHarnessSlug|resolvePotHomeSlug|harnessScopedCtx|isAllHarnessSentinel)\s*\(/;
const EXPLICIT_SENTINEL_GUARD =
  /\bctx(?:\?\.)?\.harnessSlug\s*!==?\s*['"]\s*(?:\*|all)\s*['"]|['"]\s*(?:\*|all)\s*['"]\s*!==?\s*ctx(?:\?\.)?\.harnessSlug\b/;

/** Stable key for the shrink-only baseline; the source text prevents line reuse. */
export function findingKey(file, finding) {
  return `${file}:${finding.line}:${finding.kind}:${finding.text.trim()}`;
}

/**
 * Find high-signal raw sentinel uses in one source file.
 *
 * `stripCommentsAndStrings` removes prose and string values while preserving
 * offsets/line numbers. `stripCommentsOnly` is used only for recognizing an
 * explicit `!== '*'`/`!== 'all'` guard; it leaves the string literal needed by
 * that check intact.
 */
export function findRawHarnessSentinelUses(text, fileName = 'source.ts') {
  const code = stripCommentsAndStrings(text, fileName);
  const commentFree = stripCommentsOnly(text, fileName);
  const sourceLines = String(text).split('\n');
  const codeLines = code.split('\n');
  const commentFreeLines = commentFree.split('\n');
  const findings = [];

  for (let i = 0; i < codeLines.length; i += 1) {
    const line = codeLines[i];
    if (!CTX_HARNESS.test(line)) continue;
    if (SAFE_RESOLVER.test(line) || EXPLICIT_SENTINEL_GUARD.test(commentFreeLines[i])) continue;

    let kind = null;
    if (RAW_FALLBACK.test(line)) kind = 'fallback';
    else if (IDENTITY_FIELD.test(line)) kind = 'identity-field';
    else if (NON_SENTINEL_PREDICATE.test(line) || TRUTHINESS_PREDICATE.test(line)) kind = 'predicate';
    if (!kind) continue;

    findings.push({
      line: i + 1,
      kind,
      text: sourceLines[i] ?? '',
    });
  }
  return findings;
}

/**
 * Scan the tracked tree. The result keeps coverage separate from findings so
 * an incomplete submodule enumeration cannot be reported as a repo-wide pass.
 */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);
  const offenders = [];
  const observedBaseline = new Set();
  let scanned = 0;

  for (const f of tracked) {
    if (isExcluded(f) || ALLOWLIST.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    for (const finding of findRawHarnessSentinelUses(text, f)) {
      const key = findingKey(f, finding);
      if (BASELINE.has(key)) observedBaseline.add(key);
      else offenders.push({ file: f, ...finding, key });
    }
  }

  const staleBaseline = [...BASELINE].filter((key) => !observedBaseline.has(key));
  return { offenders, staleBaseline, scanned, unscanned };
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line} [${finding.kind}] ${finding.text.trim()}`;
}

function main() {
  const scan = findOffenders();
  const allCandidates = [...scan.offenders];
  if (process.argv.includes('--list')) {
    console.log(`raw ctx.harnessSlug candidates (${allCandidates.length + BASELINE.size} total):`);
    for (const o of allCandidates) console.log(`  ${formatFinding(o)}`);
    for (const key of BASELINE) {
      if (!scan.staleBaseline.includes(key)) console.log(`  BASELINE ${key}`);
    }
    console.log(describeUnscanned(scan.unscanned));
    process.exit(0);
  }

  if (scan.staleBaseline.length > 0) {
    console.error('✗ BASELINE entries were not observed; remove them or restore the guarded site:');
    for (const key of scan.staleBaseline) console.error(`    ${key}`);
  }
  if (scan.offenders.length > 0) {
    console.error('✗ NEW raw ctx.harnessSlug identity use(s) without a sentinel guard:');
    console.error('  Route concrete-harness operations through resolveConcreteHarnessSlug / resolveHarnessScope.');
    console.error('  Route pot-home operations through resolvePotHomeSlug; compare the sentinel explicitly when that is the intent.');
    console.error('  A raw "*" is truthy but is not a registered harness, so the failure can look like a clean empty result.');
    for (const o of scan.offenders) console.error(`    ${formatFinding(o)}`);
  }
  if (scan.staleBaseline.length > 0 || scan.offenders.length > 0) {
    console.error(`\n  ${scan.offenders.length + scan.staleBaseline.length} finding(s). Use --list for the measured candidate set.`);
    process.exit(1);
  }
  console.log(`✓ no NEW raw ctx.harnessSlug identity uses (${scan.scanned} files scanned; ${BASELINE.size} baseline candidate(s)).${describeUnscanned(scan.unscanned)}`);
  process.exit(0);
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
