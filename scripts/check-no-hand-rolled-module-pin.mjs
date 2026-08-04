#!/usr/bin/env node
/**
 * lint:no-hand-rolled-module-pin — every module that pins its state to the realm
 * must do it THROUGH `@papercusp/module-singleton`, not by hand.
 *
 * ## What it detects
 *
 * The shape `globalThis[Symbol.for('...')] = state` — a module storing its
 * mutable state on the realm so a duplicated module record cannot split it in
 * half. That is a CORRECT fix for the split; the problem is that it is an
 * INVISIBLE one.
 *
 * `listModuleDuplications()` only knows about keys pinned through
 * `pinModuleState()`. A hand-rolled pin is therefore absent from the realm-wide
 * report, which then answers a confident, clean `[]` while the module is
 * duplicated. That is the exact failure shape of the outage that motivated the
 * primitive (EI-19451658870832332): a surface reporting health because its
 * subject is invisible to it, not because the subject is healthy. An empty
 * report is evidence only when there is exactly one report and it can see
 * everything.
 *
 * So this guard exists to keep the report complete BY CONSTRUCTION rather than
 * by memory — the same reason `pinModuleState` counts evaluations instead of
 * only sharing state.
 *
 * ## What it deliberately does NOT flag
 *
 *  - Reading a THIRD-PARTY well-known symbol (`Symbol.for('drizzle:Name')`) —
 *    that is not pinning anything.
 *  - Tagging a non-`globalThis` shared object (`console[Symbol.for(...)]` in
 *    log-events.ts) — a different pattern with a different fix.
 *  - Test files, which may legitimately probe the realm store.
 *  - `libs/generic/module-singleton` itself, which IS the mechanism.
 *
 * ## The allowlist
 *
 * ALLOW is the measured population that predates this guard, and it is
 * SHRINK-ONLY: migrating a site removes its entry. Do not add to it — a new
 * hand-rolled pin re-opens the hole this guard closes. Migration is tracked on
 * EI-19469900474673886.
 *
 * Exit 0 clean / 1 on a new violation.
 */
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ROOTS = ['libs', 'packages', 'apps'];

/** Directories never worth walking. */
const SKIP_DIR = new Set([
  'node_modules', 'dist', 'dist-sidecar', 'build', '.next', 'target',
  '_retired', 'coverage', '.git', 'out',
]);

/**
 * Known hand-rolled pins that predate this guard. SHRINK-ONLY — see the header.
 * Each entry is a repo-relative path; a file may hold more than one pin.
 */
const ALLOW = new Set([
  'apps/operator/lib/chat-cards/ask-user-local.ts',
  'packages/operator-core/lib/agent-tools/coordination/agent-question-gate.ts',
  'packages/operator-core/lib/agents-list.ts',
  'packages/operator-core/lib/card-response-rate-limit.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/discord.ts',
  'packages/operator-core/lib/endpoint-route/routes/harness/projects.ts',
  'packages/operator-core/lib/harness-agent-runs.ts',
  'packages/operator-core/lib/harness-core.ts',
  'packages/operator-core/lib/operator-state-pg.ts',
  'packages/operator-core/lib/posthog-config.ts',
  'packages/operator-core/lib/scratch-gc.ts',
  'packages/operator-core/lib/search/doc-embed-sync.ts',
  'packages/operator-core/lib/search/embed-backfill.ts',
  'packages/operator-core/lib/search/session-ingest.ts',
  'packages/operator-core/lib/search/turn-chunk-sync.ts',
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec)\.[cm]?tsx?$/.test(name)) {
      yield full;
    }
  }
}

/**
 * Find hand-rolled pins in one file's source.
 *
 * A pin needs BOTH halves: a `Symbol.for(...)` key AND that key used to index
 * `globalThis`. Requiring both is what keeps a third-party symbol read
 * (`Symbol.for('drizzle:Name')`, no globalThis) and a globalThis access with a
 * string key out of the results.
 */
export function findPins(src) {
  const hits = [];
  // Bind each Symbol.for key to the const name it is assigned to.
  const keyByName = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Symbol\.for\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    keyByName.set(m[1], m[2]);
  }
  if (keyByName.size === 0) return hits;

  const lines = src.split('\n');
  for (const [name, key] of keyByName) {
    // The pin half: `globalThis` reached with this symbol as the index — either
    // as a direct index (`g[NAME]`) or via a mapped type on a globalThis cast
    // (`typeof globalThis & { [NAME]?: T }`). Both appear in this repo.
    const indexed = new RegExp(`\\[\\s*${name}\\s*\\]`);
    if (!indexed.test(src)) continue;
    if (!/globalThis/.test(src)) continue;

    const declLine = lines.findIndex((l) =>
      new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*Symbol\\.for`).test(l),
    );
    hits.push({ line: declLine + 1, key, name });
  }
  return hits;
}

/**
 * `--list` ignores ALLOW and prints the FULL measured population.
 *
 * Seed and re-measure the allowlist from this, never from a hand-run grep: the
 * first version of this list came from an `rg | head -30` and was two sites
 * short, which would have baked a wrong count into the very guard whose job is
 * to make the count trustworthy.
 */
const LIST_ONLY = process.argv.includes('--list');

/**
 * Scan the tree. Exported so a unit test can assert the CURRENT population
 * without shelling out or duplicating the walk.
 */
export function scanTree() {
  const violations = [];
  const allowedSeen = new Set();
  const everyPin = [];

  for (const root of ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      // The mechanism itself is exempt — it IS the sanctioned pin.
      if (rel.startsWith('libs/generic/module-singleton/')) continue;

      let src;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes('Symbol.for')) continue;

      const pins = findPins(src);
      if (pins.length === 0) continue;

      for (const p of pins) everyPin.push({ rel, ...p });

      if (ALLOW.has(rel)) {
        allowedSeen.add(rel);
        continue;
      }
      for (const p of pins) violations.push({ rel, ...p });
    }
  }
  const stale = [...ALLOW].filter((f) => !allowedSeen.has(f)).sort();
  return { violations, allowedSeen, everyPin, stale };
}

/**
 * Run the scan only when invoked as a CLI — importing this module (for the unit
 * test) must NOT exit the process. Symlink-robust (WI-1443): node realpaths
 * import.meta.url while argv[1] keeps the invoked path, so compare both.
 */
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

if (!isMain) {
  // Imported for its predicate — nothing else to do.
} else {
  main();
}

function main() {
const { violations, allowedSeen, everyPin, stale } = scanTree();

if (LIST_ONLY) {
  everyPin.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  const files = new Set(everyPin.map((p) => p.rel));
  console.log(`${everyPin.length} hand-rolled pin(s) across ${files.size} file(s):\n`);
  for (const p of everyPin) console.log(`  ${p.rel}:${p.line}  Symbol.for('${p.key}')`);
  console.log('\nALLOW seed (paste into this script):\n');
  for (const f of [...files].sort()) console.log(`  '${f}',`);
  process.exit(0);
}

if (violations.length > 0) {
  console.error('\n✖ lint:no-hand-rolled-module-pin — new hand-rolled realm pin(s):\n');
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  Symbol.for('${v.key}')  (via ${v.name})`);
  }
  console.error(`
Pin module state THROUGH the primitive instead:

    import { pinModuleState } from '@papercusp/module-singleton';
    const state = pinModuleState('${violations[0].key}', () => ({ /* ... */ }));

A hand-rolled globalThis[Symbol.for(...)] slot is equally CORRECT and completely
INVISIBLE to listModuleDuplications() — so the realm-wide report answers a clean
[] while your module is split. The primitive shares the state AND counts the
module records, which is what makes an empty report mean something.

Worked example: libs/generic/scheduled-registry/src/index.ts
Migration of the remaining known sites: EI-19469900474673886
`);
  process.exit(1);
}

if (stale.length > 0) {
  console.log('✔ lint:no-hand-rolled-module-pin — no new hand-rolled pins.');
  console.log(
    `\n  ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer match — ` +
      'migrated or moved. Remove from ALLOW in scripts/check-no-hand-rolled-module-pin.mjs ' +
      '(the list is shrink-only, so a stale entry hides a regression):',
  );
  for (const f of stale) console.log(`    ${f}`);
  process.exit(0);
}

console.log(
  `✔ lint:no-hand-rolled-module-pin — no new hand-rolled pins ` +
    `(${allowedSeen.size} known site${allowedSeen.size === 1 ? '' : 's'} still awaiting migration, EI-19469900474673886).`,
);
}
