#!/usr/bin/env node
/**
 * check-retired-resurrection.mjs — fails when a file exists BOTH under `_retired/`
 * and, byte-identically, at a live path (WI-37422).
 *
 * WHY THIS EXISTS. Retiring a surface here is a `mv` into `_retired/` plus removing
 * its import. Observed live 2026-08-09 while retiring `topics:subscribe`: the moved
 * file came BACK at its canonical path twice, byte-identical, and git-sync committed
 * the resurrection each time (`51709bff41 D` → `40eb34c3d2 A` → `2ee1fdce9f D` →
 * `f140b48983 A`).
 *
 * The failure is nasty for one specific reason: it restores FILES but not EDITS.
 * `index.ts` never regained its import in any of those commits, so the resurrected
 * file is an ORPHAN — not imported, therefore not registered, therefore the tool door
 * genuinely stays shut. Every signal an agent would normally read says something
 * different:
 *
 *   · `git status` reads clean either way — git-sync sweeps the tree every few
 *     minutes, so the window where a stray file is visibly dirty is minutes wide.
 *   · `lint:no-retired` checks IMPORTS of retired code. The import is exactly the
 *     half that was NOT restored, so it stays green.
 *   · `scan:retirement-surface` finds a live-looking source at the canonical path and
 *     reads as "the retirement was never finished" — inviting the next agent to redo
 *     completed work, or worse, to "fix" it by restoring the import and reviving a
 *     deliberately retired surface.
 *
 * So the one state that is unambiguously wrong — the same bytes present at both a
 * retired and a live path — was the one state nothing looked at.
 *
 * ── WHY BLOB IDENTITY, NOT FILENAMES ─────────────────────────────────────────
 * Matching by basename would flag every legitimately-coexisting `index.ts` /
 * `README.md`. The signature of a RESURRECTION is stronger and exact: the same
 * content at both places. We compare git's own blob SHAs from the index, so this is
 * byte-identity with zero file reads — and it cannot be fooled by a path that merely
 * looks similar.
 *
 * Zero-byte blobs are excluded: every empty file in the repo shares one SHA, so they
 * collide with each other and mean nothing. That exclusion is the whole difference
 * between a clean baseline and a permanently-red guard — measured 2026-08-09, the
 * only collision across 771 tracked `_retired/` files was the empty
 * `_retired/papercup/.next/turbopack`.
 *
 * ── SCOPE, STATED ────────────────────────────────────────────────────────────
 * Reads the SUPERPROJECT index only. `git ls-files` does not descend into submodules,
 * so a resurrection inside one is NOT covered. `_retired/` lives in the superproject,
 * which is what makes that boundary the right one today — but it is a real boundary,
 * not an absence of one, and this comment exists so nobody reads a green run as
 * "no resurrection anywhere".
 *
 * Reads the INDEX (tracked blobs), not the working tree — deliberately. A peer's
 * uncommitted edit is invisible here, so this cannot red the shared gate on someone
 * else's in-flight work; it fires only once a resurrection has actually been
 * committed, which is the point at which it is real.
 */
import { execFileSync } from 'node:child_process';

const RETIRED_PREFIX = '_retired/';

/** `git ls-files -s` → [{ sha, path }]. Exported for the unit test's fixtures. */
export function parseLsFiles(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    if (meta.length < 2) continue;
    out.push({ sha: meta[1], path: line.slice(tab + 1) });
  }
  return out;
}

/**
 * The whole decision, pure. `sizes` maps blob sha → byte length; a sha missing from
 * it is treated as non-empty (fail loud rather than silently skipping a real hit).
 */
export function findResurrections(entries, sizes = new Map()) {
  const retired = new Map();
  const live = new Map();
  for (const { sha, path } of entries) {
    const bucket = path.startsWith(RETIRED_PREFIX) ? retired : live;
    if (!bucket.has(sha)) bucket.set(sha, []);
    bucket.get(sha).push(path);
  }
  const hits = [];
  for (const [sha, retiredPaths] of retired) {
    const livePaths = live.get(sha);
    if (!livePaths) continue;
    if (sizes.get(sha) === 0) continue; // every empty file shares one sha — see header
    hits.push({ sha, retiredPaths: retiredPaths.sort(), livePaths: livePaths.sort() });
  }
  return hits.sort((a, b) => a.retiredPaths[0].localeCompare(b.retiredPaths[0]));
}

function main() {
  const listOnly = process.argv.includes('--list');
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const entries = parseLsFiles(
    execFileSync('git', ['ls-files', '-s'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 }),
  );

  const retiredCount = entries.filter((e) => e.path.startsWith(RETIRED_PREFIX)).length;

  // Size-check only the shas that actually collide — usually a handful, so this stays
  // one small batch rather than a walk over the whole index.
  const candidates = findResurrections(entries);
  const sizes = new Map();
  if (candidates.length) {
    const batch = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: repoRoot,
      input: candidates.map((c) => c.sha).join('\n') + '\n',
      encoding: 'utf8',
    });
    for (const line of batch.split('\n')) {
      const [sha, , size] = line.trim().split(/\s+/);
      if (sha && size !== undefined) sizes.set(sha, Number(size));
    }
  }
  const hits = findResurrections(entries, sizes);

  if (listOnly) {
    console.log(
      `[retired-resurrection] scanned ${entries.length} tracked files (${retiredCount} under ${RETIRED_PREFIX}); ${hits.length} resurrection(s).`,
    );
  }
  if (!hits.length) {
    if (listOnly) console.log('[retired-resurrection] clean.');
    return 0;
  }

  console.error(
    `\n[retired-resurrection] ${hits.length} file(s) exist BOTH under ${RETIRED_PREFIX} and, byte-identically, at a live path.\n` +
      'A retirement has been partially undone: the file came back, but (as in WI-37422) its\n' +
      'import very likely did not, so the surface is an orphan that READS as live.\n',
  );
  for (const hit of hits) {
    console.error(`  retired: ${hit.retiredPaths.join(', ')}`);
    console.error(`  live:    ${hit.livePaths.join(', ')}`);
    console.error(`  blob:    ${hit.sha}\n`);
  }
  console.error(
    'FIX: decide which one is real. If the retirement stands, delete the live copy. If the\n' +
      'surface is being revived, move it out of _retired/ and restore its import — do not\n' +
      'leave both.\n',
  );
  return 1;
}

process.exit(main());
