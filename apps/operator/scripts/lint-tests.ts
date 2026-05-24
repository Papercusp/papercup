/**
 * lint-tests.ts — CI guard for the four-framework rule.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-038.
 *
 * D-006 says new tests go in Vitest / Playwright / Cargo / LLM
 * scenarios — never `.mjs` integration scripts or tsx `-smoke.ts`
 * files. This lint enforces it via a debt counter
 * (`lint-tests-debt.json`):
 *
 *   - Files listed in the JSON are pre-migration legacy. Their
 *     presence is accepted.
 *   - A NEW `.mjs` under `apps/operator/__tests__/integration/`
 *     fails CI.
 *   - A NEW `-smoke.ts` under `apps/operator/scripts/` fails CI.
 *   - REMOVING an entry from the JSON (because the file was migrated)
 *     succeeds — the JSON only shrinks.
 *
 * Exit code:
 *   0 — clean (no new offenders)
 *   1 — at least one new file found
 *
 * Usage:
 *   tsx apps/operator/scripts/lint-tests.ts
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(__dirname);

interface Debt {
  integrationMjs: string[];
  scriptsSmoke: string[];
}

function resolveRepoRoot(from: string): string {
  let dir = resolve(from);
  while (true) {
    // .git is the universal marker — works for any workspace shape.
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

async function loadDebt(): Promise<Debt> {
  const debtPath = join(REPO_ROOT, 'apps/operator/scripts/lint-tests-debt.json');
  const raw = await readFile(debtPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Debt>;
  return {
    integrationMjs: parsed.integrationMjs ?? [],
    scriptsSmoke: parsed.scriptsSmoke ?? [],
  };
}

async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const e of entries) {
    if (e.isFile() && predicate(e.name)) {
      hits.push(e.name);
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const debt = await loadDebt();
  const debtMjs = new Set(debt.integrationMjs);
  const debtSmoke = new Set(debt.scriptsSmoke);

  const offenders: string[] = [];

  // Forbidden #1: new .mjs under apps/operator/__tests__/integration/
  const intDir = join(REPO_ROOT, 'apps/operator/__tests__/integration');
  const intFiles = await listFiles(intDir, (n) => n.endsWith('.mjs'));
  for (const name of intFiles) {
    const rel = posix.join('apps/operator/__tests__/integration', name);
    if (!debtMjs.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → .mjs integration scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Forbidden #2: new *-smoke.ts under apps/operator/scripts/
  const scriptsDir = join(REPO_ROOT, 'apps/operator/scripts');
  const smokeFiles = await listFiles(scriptsDir, (n) => n.endsWith('-smoke.ts'));
  for (const name of smokeFiles) {
    const rel = posix.join('apps/operator/scripts', name);
    if (!debtSmoke.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → tsx -smoke.ts scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Stale debt entries — files in the JSON that no longer exist.
  // Not an error; just a heads-up the JSON should be pruned.
  const stale: string[] = [];
  for (const path of [...debtMjs, ...debtSmoke]) {
    const abs = join(REPO_ROOT, path);
    try {
      await stat(abs);
    } catch {
      stale.push(path);
    }
  }

  if (stale.length > 0) {
    process.stdout.write('Stale debt entries (file deleted; remove from lint-tests-debt.json):\n');
    for (const p of stale) process.stdout.write(`  - ${p}\n`);
  }

  if (offenders.length > 0) {
    process.stderr.write('\n✗ lint-tests: new test-framework offenders found\n\n');
    for (const o of offenders) process.stderr.write(`  ${o}\n\n`);
    process.stderr.write(
      'See apps/operator-docs/src/content/docs/testing/index.mdx §1.0a ' +
      'for the four canonical frameworks.\n',
    );
    process.exit(1);
  }

  process.stdout.write('✓ lint-tests: no new offenders\n');
  process.stdout.write(`  ${debtMjs.size} .mjs + ${debtSmoke.size} -smoke.ts debt entries\n`);
}

void main();
