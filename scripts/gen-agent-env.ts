/**
 * gen-agent-env.ts — regenerate AGENT-ENV.md from the REAL repo config.
 *
 * EI-10941 (corroborates EI-10904): a fresh agent cannot discover how to run
 * tests, where shared code lives, or which tree an alias points at. That
 * knowledge EXISTS — in someone's memory, a carry-note, an insights doc — but is
 * enforced by nothing and taught by no failure message, so it survives only by
 * being hand-carried across compactions. That is the definition of tribal
 * knowledge, and it is why every new agent re-pays the same tax (a package-local
 * `vitest` that is exit-127 DOA; a coin-flip between `libs/` and `packages/`; an
 * `@` alias that silently crosses into another app's tree).
 *
 * The fix is to make the operating contract a DERIVED ARTIFACT, generated from
 * the config it describes, so it cannot drift out of sync with reality the way a
 * hand-written README does. This script reads the actual root package.json, the
 * on-disk workspace layout, the operator-vite alias config, and the test tooling,
 * and emits AGENT-ENV.md. `scripts/test-doctor.mjs` then asserts the same
 * invariants as runnable checks (so a drift breaks `npm run doctor` instead of a
 * future agent), and `--check` here fails CI if the committed doc is stale.
 *
 *   Run:  npx tsx scripts/gen-agent-env.ts          (write AGENT-ENV.md)
 *         npx tsx scripts/gen-agent-env.ts --check   (CI/gate: fail if stale)
 *
 * Determinism: every derived list is sorted, so re-running on unchanged config
 * produces byte-identical output (the --check drift guard depends on this).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'AGENT-ENV.md');
const GEN_CMD = 'npx tsx scripts/gen-agent-env.ts';

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

// `apps/` holds applications; the tribal-knowledge trap EI-10941 documents is the
// SHARED-LIBRARY split (`libs/` vs `packages/`), where an agent guesses the wrong
// root for a shared package. Keep apps out of the "guess between" set.
const APP_ROOT = 'apps';

/** The workspace roots that actually exist on disk, in a stable order. */
function workspaceRoots(workspaces: string[]): string[] {
  const roots = new Set<string>();
  for (const ws of workspaces) {
    // 'packages/*' → 'packages'; 'libs/generic/tooldef' → 'libs'. We want the
    // top-level directory an agent has to guess between.
    const top = ws.split('/')[0];
    if (top && existsSync(join(REPO_ROOT, top))) roots.add(top);
  }
  return [...roots].sort();
}

/** The SHARED-LIBRARY roots (workspace roots minus the app root) — the real libs-vs-packages ambiguity. */
function sharedCodeRoots(workspaces: string[]): string[] {
  return workspaceRoots(workspaces).filter((r) => r !== APP_ROOT);
}

/** Every top-level entry under a root — the concrete set an agent picks from (node_modules + dotdirs excluded). */
function entriesUnder(root: string): string[] {
  const dir = join(REPO_ROOT, root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * The operator-vite `@` alias target, read from the config itself. Returns the
 * resolve() argument (e.g. '../operator') so the doc names the REAL cross-tree
 * target, and the drift guard re-derives it if the config moves.
 */
function operatorViteAliasTarget(): { target: string | null; aliasPresent: boolean } {
  const rel = 'apps/operator-vite/vite.config.ts';
  if (!existsSync(join(REPO_ROOT, rel))) return { target: null, aliasPresent: false };
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const decl = src.match(/const\s+operatorRoot\s*=\s*resolve\(\s*import\.meta\.dirname\s*,\s*['"]([^'"]+)['"]/);
  const aliasPresent = /\{\s*find:\s*['"]@['"]\s*,\s*replacement:\s*operatorRoot\s*\}/.test(src);
  return { target: decl ? decl[1] : null, aliasPresent };
}

const rootPkg = readJson('package.json');
const workspaces = Array.isArray(rootPkg.workspaces) ? (rootPkg.workspaces as string[]) : [];
const scripts = (rootPkg.scripts ?? {}) as Record<string, string>;
const roots = sharedCodeRoots(workspaces);
const vite = operatorViteAliasTarget();
const pcHeavy = existsSync(join(REPO_ROOT, 'scripts', 'pc-heavy.sh'));

// A sample package that GENUINELY has no package-local vitest, to demonstrate the
// "use the hoisted root binary" fact with a concrete, TRUE example. A few packages
// (e.g. those pinning a different vitest major) do ship their own — the doc must not
// point at one of those, or its example would be a lie. Derived, so it stays true.
const concretePkgWorkspaces = workspaces
  .filter((ws) => ws.startsWith('packages/') && ws !== 'packages/*')
  .map((ws) => ws)
  .sort();
const sampleWs =
  concretePkgWorkspaces.find((ws) => !existsSync(join(REPO_ROOT, ws, 'node_modules', '.bin', 'vitest'))) ??
  // Fall back to scanning packages/* on disk if the workspaces glob is '*'.
  entriesUnder('packages')
    .map((name) => `packages/${name}`)
    .find((rel) => !existsSync(join(REPO_ROOT, rel, 'node_modules', '.bin', 'vitest'))) ??
  null;

const lines: string[] = [];
const w = (s = '') => lines.push(s);

w(`<!-- GENERATED by ${GEN_CMD} — do NOT edit by hand. Regenerate after changing`);
w(`     workspaces, the operator-vite alias, or the test tooling. \`npm run doctor\``);
w(`     asserts these same invariants as runnable checks. -->`);
w('# AGENT-ENV — the machine-checked repo operating contract');
w();
w('You are working in a large monorepo. The facts below are the ones that cost a');
w('fresh agent a failed command or a wrong edit when undiscovered. They are');
w('GENERATED from the real config (package.json, the vite config, the on-disk');
w('layout), so they cannot drift out of sync the way a hand-written note does.');
w();
w(`- **Repo root:** \`${(rootPkg.name as string) ?? '(unnamed)'}\``);
w(`- **Package manager:** \`${(rootPkg.packageManager as string) ?? 'npm'}\``);
w();

w('## Where shared code lives');
w();
if (roots.length > 1) {
  const quantifier = roots.length === 2 ? 'both' : 'all';
  w(`There is **no single shared-code directory** — ${roots.map((r) => `\`${r}/\``).join(' and ')} ${quantifier}`);
  w(`exist and are ${quantifier} npm workspaces, with shared packages split across them under no`);
  w('stated rule (e.g. `test-config` lives in `libs/`, not `packages/`). Guessing the');
  w('wrong root is a `No such file or directory`. Search across them before assuming:');
  w();
  w('```');
  w(`ls -d ${roots.map((r) => `${r}/*<name>*`).join(' ')} 2>/dev/null   # find which root actually holds it`);
  w('```');
} else if (roots.length === 1) {
  w(`Shared code lives under \`${roots[0]}/\`.`);
}
w();
w(`Applications live separately under \`${APP_ROOT}/\` (each is its own workspace).`);
w();
for (const r of roots) {
  const entries = entriesUnder(r);
  w(`<details><summary><code>${r}/</code> — ${entries.length} entries</summary>`);
  w();
  w('```');
  w(entries.join('  '));
  w('```');
  w('</details>');
  w();
}

w('## Running tests');
w();
w('`vitest` is **hoisted to the repo root**, and MOST packages have no local copy —');
w('so a package-local invocation is exit-127 DOA. (A few packages that pin a different');
w('vitest major do ship their own; the root binary is the safe default everywhere else.)');
w();
w('```');
w(`node_modules/.bin/vitest            # EXISTS (the hoisted binary — the safe default)`);
if (sampleWs) w(`${sampleWs}/node_modules/.bin/vitest   # does NOT exist → a package-local call there is exit-127 DOA`);
w('```');
w();
w('Run a suite one of these ways (both resolve the hoisted binary):');
w();
w('```');
if (scripts['test:file']) w(`npm run test:file -- <path>                       # the supported wrapper`);
w(`node_modules/.bin/vitest run <path>               # the hoisted binary directly`);
if (pcHeavy) {
  w(`scripts/pc-heavy.sh node_modules/.bin/vitest run <path>   # REQUIRED for heavy runs on the shared box`);
}
w('```');
w();
if (pcHeavy) {
  w('On the shared 128-core box, heavy commands (a full suite, a build) must go');
  w('through `scripts/pc-heavy.sh` (nice + a flock concurrency semaphore) or the');
  w('admission guard rejects them under load.');
  w();
}
w('Some apps need their own vitest config, e.g. `apps/operator`:');
w();
w('```');
w('node_modules/.bin/vitest run <path> --config apps/operator/vitest.config.ts');
w('```');
w();

w('## Cross-tree alias trap (operator-vite)');
w();
if (vite.aliasPresent && vite.target) {
  w(`In \`apps/operator-vite/vite.config.ts\`, the \`@\` alias resolves to \`${vite.target}\``);
  w('relative to that config — i.e. it points at a **DIFFERENT app** (`apps/operator`,');
  w('the Next tree), not into operator-vite itself. So inside `apps/operator-vite`, an');
  w('intuitive `@/…` import silently crosses into another app\'s source tree.');
  w('**Intra-app imports here must be relative.** Nothing at the import site warns you.');
} else {
  w('_(No `@`→operator alias detected in apps/operator-vite/vite.config.ts.)_');
}
w();

w('## Desktop (Tauri)');
w();
w('The Tauri webview serves a **prebuilt, hashed bundle**, not the dev server — so');
w('source edits appear to do nothing until you rebuild the bundle. If a UI change');
w('is not showing up, rebuild before assuming the edit was wrong.');
w();

w('---');
w(`_Regenerate: \`${GEN_CMD}\`. Verify (and assert the invariants as checks): \`npm run doctor\`._`);

const out = lines.join('\n') + '\n';

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== out) {
    process.stderr.write(`✗ AGENT-ENV.md is stale. Run: ${GEN_CMD}\n`);
    process.exit(1);
  }
  process.stdout.write('✓ AGENT-ENV.md is up to date\n');
} else {
  writeFileSync(OUT, out);
  process.stdout.write(`✓ wrote AGENT-ENV.md (${roots.length} shared-code roots, alias target ${vite.target ?? 'n/a'})\n`);
}

// Note: test-doctor.mjs re-derives these same invariants inline rather than
// importing them from here — this module runs its generation side effects at
// module scope (it WRITES AGENT-ENV.md), so importing it would trigger a write.
// The "AGENT-ENV.md is not stale" doctor check + the gen:agent-env:check CI gate
// are what keep the doc and the runnable checks in agreement.
