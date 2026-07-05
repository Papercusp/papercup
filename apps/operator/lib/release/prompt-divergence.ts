/**
 * Prompt divergence guard — decouple-agent-prompts-from-release-gate-2026-06-20 P-004.
 *
 * The decoupling (P-002/P-003) lets agent PROMPT files resolve from the
 * integration/staging tree so an edit goes live without a code release. The
 * detector-failure that motivated the plan: an agent edits a prompt in the
 * working tree, but the LIVE operator reads prompts from a *different* location
 * (a stale release checkout, or a desktop sidecar bundle frozen at build time),
 * so the edit silently has no effect — "I edited a prompt" quietly meaning "not
 * live".
 *
 * This module makes that LOUD: it content-hashes a representative set of base
 * prompt files in the location the runtime ACTUALLY reads from (the live prompt
 * root, via `promptHarnessRoot`) and compares them against a source/working
 * tree. Any difference (or a missing file on either side) is a reported
 * divergence. It also compares a desktop sidecar bundle against source.
 *
 * Companion to `verify-release-paths.ts`, which guards the RESOLUTION LOCATION
 * (an override that silently no-ops at deploy); this guards the CONTENT (a live
 * root whose bytes lag the working tree).
 *
 * Pure FS + sha256; no network/git. Exposes functions for tests/health checks
 * and a CLI (`tsx prompt-divergence.ts <sourceRoot>`) that exits non-zero on
 * divergence — the same real-tool pattern as verify-release-paths (NOT a smoke
 * script).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptHarnessRoot } from '@papercusp/harness/paths';

/**
 * Representative base prompt files (relative to a HARNESS root) the guard
 * content-compares. The base blueprint is the universal role library every
 * spawn resolves through, so drift here affects every fleet agent. Kept small +
 * load-bearing rather than exhaustive — a missing entry never fails the guard,
 * it just isn't compared.
 */
export const BASE_HARNESS_PROMPT_FILES: readonly string[] = [
  'blueprints/base/prompts/agent-base-preamble.md',
  'blueprints/base/prompts/mug.md',
  'blueprints/base/prompts/cup.base.md',
  'blueprints/base/prompts/worker.md',
  'blueprints/base/prompts/scanner.md',
  'blueprints/coding/prompts/agent-base-overlay.md',
];

export type DivergenceReason = 'content-differs' | 'missing-in-live' | 'missing-in-source';

export interface PromptDivergence {
  file: string;
  reason: DivergenceReason;
  liveHash: string | null;
  sourceHash: string | null;
}

export interface DivergenceResult {
  ok: boolean;
  liveRoot: string;
  sourceRoot: string;
  /** files present (on at least one side) and thus compared */
  checked: number;
  divergences: PromptDivergence[];
  note?: string;
}

function sha256OrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compare prompt files (relative paths) between a LIVE read root and a SOURCE
 * tree. When the two roots are the same directory, there is nothing to diverge
 * (the common no-override case) — returns ok with a note.
 */
export function comparePromptRoots(
  liveRoot: string,
  sourceRoot: string,
  relFiles: readonly string[] = BASE_HARNESS_PROMPT_FILES,
): DivergenceResult {
  if (join(liveRoot) === join(sourceRoot)) {
    return {
      ok: true,
      liveRoot,
      sourceRoot,
      checked: 0,
      divergences: [],
      note: 'live root === source root — no decoupling, no divergence possible',
    };
  }
  const divergences: PromptDivergence[] = [];
  let checked = 0;
  for (const rel of relFiles) {
    const liveHash = sha256OrNull(join(liveRoot, rel));
    const sourceHash = sha256OrNull(join(sourceRoot, rel));
    if (liveHash === null && sourceHash === null) continue; // file in neither tree — not compared
    checked += 1;
    if (liveHash === sourceHash) continue;
    let reason: DivergenceReason;
    if (sourceHash === null) reason = 'missing-in-source';
    else if (liveHash === null) reason = 'missing-in-live';
    else reason = 'content-differs';
    divergences.push({ file: rel, reason, liveHash, sourceHash });
  }
  return { ok: divergences.length === 0, liveRoot, sourceRoot, checked, divergences };
}

/**
 * Compare the base prompts the runtime ACTUALLY reads (the live prompt root,
 * `promptHarnessRoot()`) against the working/integration SOURCE tree's harness
 * subtree. `sourceRoot` is a repo root (e.g. PAPERCUSP_INTEGRATION_ROOT); its
 * harness subtree is derived. A working-tree prompt edit that hasn't reached the
 * live root surfaces as `content-differs` / `missing-in-live`.
 */
export function detectHarnessPromptDivergence(opts: {
  sourceRoot: string;
  liveRoot?: string;
  files?: readonly string[];
}): DivergenceResult {
  const liveRoot = opts.liveRoot ?? promptHarnessRoot();
  const sourceHarness = join(opts.sourceRoot, 'libs', 'papercusp', 'packages', 'harness');
  return comparePromptRoots(liveRoot, sourceHarness, opts.files);
}

/**
 * Compare a desktop sidecar's bundled harness prompts (frozen at build time by
 * build-desktop-sidecar.sh) against the SOURCE tree. A sidecar that predates a
 * prompt edit serves stale prompts to the packaged desktop. No-ops (ok, note)
 * when the sidecar harness subtree is absent (e.g. on a dev box with no build).
 */
export function detectSidecarPromptDrift(opts: {
  sidecarRoot: string;
  sourceRoot: string;
  files?: readonly string[];
}): DivergenceResult {
  // The sidecar bundles the harness package under sidecar/harness (see
  // build-desktop-sidecar.sh: HARNESS_DST). Probe both that and a bare layout.
  const candidates = [
    join(opts.sidecarRoot, 'harness'),
    join(opts.sidecarRoot, 'libs', 'papercusp', 'packages', 'harness'),
    opts.sidecarRoot,
  ];
  const sidecarHarness = candidates.find((c) => existsSync(join(c, 'blueprints')));
  const sourceHarness = join(opts.sourceRoot, 'libs', 'papercusp', 'packages', 'harness');
  if (!sidecarHarness) {
    return {
      ok: true,
      liveRoot: opts.sidecarRoot,
      sourceRoot: sourceHarness,
      checked: 0,
      divergences: [],
      note: 'no sidecar harness bundle present — nothing to compare',
    };
  }
  return comparePromptRoots(sidecarHarness, sourceHarness, opts.files);
}

// CLI — same marker/stderr contract as verify-release-paths so a caller can
// parse one JSON line. `tsx prompt-divergence.ts <sourceRoot>`; sourceRoot
// defaults to PAPERCUSP_INTEGRATION_ROOT. Exits 1 on divergence.
export const PROMPT_DIVERGENCE_MARKER = '__PROMPT_DIVERGENCE__';
if (require.main === module) {
  const sourceRoot = process.argv[2] ?? process.env.PAPERCUSP_INTEGRATION_ROOT;
  if (!sourceRoot) {
    console.error('[prompt-divergence] no sourceRoot (arg or PAPERCUSP_INTEGRATION_ROOT) — nothing to compare');
    console.log(`${PROMPT_DIVERGENCE_MARKER} ${JSON.stringify({ ok: true, checked: 0, divergences: [], note: 'no source root' })}`);
    process.exit(0);
  }
  const result = detectHarnessPromptDivergence({ sourceRoot });
  console.log(`${PROMPT_DIVERGENCE_MARKER} ${JSON.stringify(result)}`);
  if (!result.ok) {
    console.error(`\n[prompt-divergence] DIVERGENCE — ${result.divergences.length} prompt(s) differ between the live root and ${sourceRoot}`);
    for (const d of result.divergences) console.error(`   - ${d.file}: ${d.reason}`);
    console.error('   An edit to these in the working tree will NOT be live until the live prompt root is updated.');
    process.exit(1);
  }
  console.error(`\n[prompt-divergence] OK — live prompt root matches source (${result.checked} file(s) compared)`);
}
