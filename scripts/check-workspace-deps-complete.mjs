#!/usr/bin/env node
/**
 * check-workspace-deps-complete.mjs — shrink-only guard against workspaces that import
 * a local @papercusp/* package without declaring it (EI-9831, generalizing
 * lint-affected-gate.mjs's check #4 from @papercusp/memory-only to every local package).
 *
 * WHY THIS MATTERS: scripts/affected-tests.mjs builds its reverse-dependency walk from
 * each workspace's package.json dependencies/devDependencies/peerDependencies. An
 * UNDECLARED local import is invisible to that walk — a change to the imported package
 * will NOT mark the importing workspace affected, so its tests silently do not run on
 * that change. This is the same failure class lint-affected-gate.mjs was hardened for
 * (memory-only), generalized to the whole @papercusp/* namespace.
 *
 * A 2026-07-11 repo-wide scan found 54 such undeclared edges (worst offender:
 * @papercusp/operator-core omits ~24). Fixing all 54 at once was out of scope for the
 * task that found them and would touch many unrelated packages in one sweep — so this
 * guard is SHRINK-ONLY: the 54 known-at-authoring-time violations are grandfathered into
 * BASELINE and must not grow; any NEW undeclared edge is a hard failure.
 *
 *   node scripts/check-workspace-deps-complete.mjs        # check (used by npm run lint:workspace-deps-complete)
 *   node scripts/check-workspace-deps-complete.mjs --list  # print the current offender set (regenerate BASELINE)
 *
 * BASELINE entries shrink as each is fixed (declare the dependency + regenerate
 * package-lock.json) — remove the entry when its edge is declared. Do NOT add new
 * entries; a NEW undeclared edge must be fixed, not grandfathered.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * BASELINE (TEMPORARY — must shrink to EMPTY): `${importerPkgName}->${importedPkgName}`
 * edges that exist today without a declared dependency. Seeded 2026-07-12 from the
 * repo-wide scan referenced in EI-9831 (54 edges). Fix an edge (declare the dependency +
 * `npm install` to regenerate package-lock.json) and REMOVE its entry here — that is how
 * this guard ratchets to zero. Do NOT add new entries.
 */
export const BASELINE = new Set([
  '@papercup/marketplace-public-ui->@papercusp/test-config',
  '@papercusp/agent-mcp->@papercusp/plugin-sdk',
  '@papercusp/agent-mcp->@papercusp/test-config',
  '@papercusp/backup->@papercusp/test-config',
  '@papercusp/coordination->@papercusp/test-config',
  '@papercusp/docs-engine->@papercusp/test-config',
  '@papercusp/flags->@papercusp/test-config',
  '@papercusp/host-platform->@papercusp/test-config',
  '@papercusp/model-pricing->@papercusp/test-config',
  '@papercusp/omp->@papercusp/test-config',
  '@papercusp/operator-core->@papercusp/agent-mcp',
  '@papercusp/operator-core->@papercusp/backup',
  '@papercusp/operator-core->@papercusp/coordination',
  '@papercusp/operator-core->@papercusp/db-org',
  '@papercusp/operator-core->@papercusp/desktop-ipc',
  '@papercusp/operator-core->@papercusp/docs-engine',
  '@papercusp/operator-core->@papercusp/embedded-pg-discovery',
  '@papercusp/operator-core->@papercusp/embedded-postgres-server',
  '@papercusp/operator-core->@papercusp/fanout-resolver',
  '@papercusp/operator-core->@papercusp/grid-core',
  '@papercusp/operator-core->@papercusp/harness',
  '@papercusp/operator-core->@papercusp/ipc-endpoint-server',
  '@papercusp/operator-core->@papercusp/ipc-framing',
  '@papercusp/operator-core->@papercusp/lexicon',
  '@papercusp/operator-core->@papercusp/locks',
  '@papercusp/operator-core->@papercusp/papercusp-shared',
  '@papercusp/operator-core->@papercusp/plan-parser',
  '@papercusp/operator-core->@papercusp/plugin-loader',
  '@papercusp/operator-core->@papercusp/plugin-sdk',
  '@papercusp/operator-core->@papercusp/projection-index',
  '@papercusp/operator-core->@papercusp/publish-auth',
  '@papercusp/operator-core->@papercusp/rate-limit',
  '@papercusp/operator-core->@papercusp/search',
  '@papercusp/operator-core->@papercusp/search-core',
  '@papercusp/operator-core->@papercusp/sync',
  '@papercusp/operator-core->@papercusp/testing-shell',
  '@papercusp/operator-core->@papercusp/tooldef',
  '@papercusp/operator-core->@papercusp/tooldef-mcp',
  '@papercusp/operator-vite->@papercusp/flags',
  '@papercusp/operator-vite->@papercusp/grid-core',
  '@papercusp/operator-vite->@papercusp/operator-core',
  '@papercusp/operator-vite->@papercusp/p2p-voice',
  '@papercusp/operator-vite->@papercusp/sync',
  '@papercusp/operator-vite->@papercusp/testing-shell',
  '@papercusp/operator-vite->@papercusp/ui-primitives',
  '@papercusp/plugin-loader->@papercusp/agent-mcp',
  '@papercusp/plugin-sdk->@papercusp/test-config',
  '@papercusp/plugin-wit->@papercusp/test-config',
  '@papercusp/sync->@papercusp/test-config',
  '@papercusp/testing-shell->@papercusp/test-config',
  '@papercusp/tooldef-mcp->@papercusp/test-config',
  '@papercusp/web->@papercusp/agent-mcp',
  '@papercusp/web->@papercusp/chat-protocol',
  '@papercusp/web->@papercusp/embedded-postgres-server',
  '@papercusp/web->@papercusp/p2p-voice',
  '@papercusp/web->@papercusp/resource-profile',
  '@papercusp/web->@papercusp/scheduled-registry',
  '@papercusp/web->@papercusp/seed-bundle',
  '@papercusp/web->@papercusp/testing-shell',
  '@papercusp/web->@papercusp/tooldef',
]);

function expandWorkspaces(patterns) {
  const out = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const base = p.replace(/\/\*$/, '');
      if (!existsSync(join(ROOT, base))) continue;
      for (const entry of readdirSync(join(ROOT, base))) {
        const dir = `${base}/${entry}`;
        if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
      }
    } else if (existsSync(join(ROOT, p, 'package.json'))) {
      out.push(p);
    }
  }
  return out;
}

function loadWorkspaces() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const wsDirs = expandWorkspaces(rootPkg.workspaces);
  const byDir = new Map();
  const byName = new Map();
  for (const dir of wsDirs) {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    byDir.set(dir, pkg);
    if (pkg.name) byName.set(pkg.name, { dir, pkg });
  }
  return { byDir, byName };
}

/** Match a real `@papercusp/x` module specifier (import/require/dynamic-import + subpaths),
 * never a bare substring hit inside prose/doc comments. Comments are stripped first. */
const SPECIFIER_RE = /(?:from|require\(|import\()\s*['"](@papercusp\/[a-zA-Z0-9._-]+)(?:\/[^'"]*)?['"]/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Local @papercusp/* imports found in one workspace's TS/TSX source (excludes tests/dist/node_modules). */
function importsInWorkspace(dir) {
  let files = '';
  try {
    files = execFileSync(
      'grep',
      [
        '-rlE',
        '--include=*.ts',
        '--include=*.tsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=.next',
        String.raw`@papercusp/`,
        join(ROOT, dir),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return new Set(); // grep exit 1 = no matches
  }
  if (!files) return new Set();
  const found = new Set();
  for (const f of files.split('\n')) {
    if (/\.(test|spec)\.[cm]?tsx?$/.test(f)) continue; // test-only imports don't gate the reverse-dep walk
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    for (const m of stripped.matchAll(SPECIFIER_RE)) found.add(m[1]);
  }
  return found;
}

/** Scan every workspace for undeclared local @papercusp/* imports. Returns [{ importer, imported, edge }]. */
export function findOffenders() {
  const { byDir, byName } = loadWorkspaces();
  const offenders = [];
  for (const [dir, pkg] of byDir) {
    const imported = importsInWorkspace(dir);
    if (imported.size === 0) continue;
    const declared = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const importedName of imported) {
      if (importedName === pkg.name) continue; // self-import (rare, re-exports)
      if (!byName.has(importedName)) continue; // not a local workspace (published-only or typo) — out of scope
      if (declared[importedName]) continue; // already declared — fine
      const edge = `${pkg.name}->${importedName}`;
      offenders.push({ importer: pkg.name, importerDir: dir, imported: importedName, edge });
    }
  }
  return offenders.sort((a, b) => a.edge.localeCompare(b.edge));
}

function main() {
  const listMode = process.argv.includes('--list');
  const offenders = findOffenders();

  if (listMode) {
    console.log(JSON.stringify(offenders.map((o) => o.edge), null, 2));
    console.log(`\n${offenders.length} total edge(s).`);
    process.exit(0);
  }

  const baselineSet = BASELINE;
  const newOffenders = offenders.filter((o) => !baselineSet.has(o.edge));
  const stillInBaseline = offenders.filter((o) => baselineSet.has(o.edge));
  const fixedFromBaseline = [...baselineSet].filter((e) => !offenders.some((o) => o.edge === e));

  if (fixedFromBaseline.length > 0) {
    console.log(`ℹ ${fixedFromBaseline.length} BASELINE edge(s) no longer reproduce (fixed but not removed from BASELINE):`);
    for (const e of fixedFromBaseline) console.log(`    ${e}`);
    console.log('  Remove these from BASELINE in scripts/check-workspace-deps-complete.mjs.\n');
  }

  if (newOffenders.length === 0) {
    console.log(
      `✓ no NEW undeclared local @papercusp/* import (${stillInBaseline.length} pre-existing edge(s) still in the shrink-to-empty BASELINE).`,
    );
    process.exit(0);
  }

  console.error('');
  console.error('✗ lint:workspace-deps-complete FAILED — NEW undeclared local @papercusp/* import(s):');
  console.error('  The affected-set reverse-dep walk is built from package.json — an undeclared import');
  console.error('  means a change to the imported package will NOT run the importer\'s tests.');
  console.error('');
  for (const o of newOffenders) {
    console.error(`    ${o.edge}  (${o.importerDir})`);
  }
  console.error(`\n  Fix: add "${newOffenders[0]?.imported}": "*" (etc.) to the importer's dependencies, then`);
  console.error('  `npm install` to regenerate package-lock.json. Do NOT add these to BASELINE.');
  process.exit(1);
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
if (isMain) {
  main();
}
