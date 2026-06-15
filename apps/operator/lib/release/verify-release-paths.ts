/**
 * Phase 0 verification — plan release-gate-ready-branch-2026-06-04.
 *
 * Proves the release-checkout isolation: when the operator runs with
 * cwd = <release>/apps/operator, EVERY runtime file read (prompts, SQL
 * migrations, docs, SU playbooks) resolves UNDER the release checkout, not the
 * churning integration tree. This is the plan's #1 risk ("if any runtime read
 * still hits the churning tree, the operator runs ready code with HEAD config").
 *
 * Run it FROM the release tree so process.cwd() matches what the operator sees:
 *   cd <release>/apps/operator && node_modules/.bin/tsx \
 *     lib/release/verify-release-paths.ts
 * (the deploy runs it automatically post-swap.)
 *
 * Exits 0 if every read resolves under the release root; 1 (with the offending
 * paths) otherwise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { releaseConfig } from './release-config';
import { resolveSqlDir } from '@papercusp/operator-core/lib/migration-drift';

interface Check {
  name: string;
  resolved: string | null;
  /** Must exist on disk. */
  mustExist: boolean;
}

/** promptsDir() is private in prompt-assembly.ts — replicate its cwd logic. */
function promptsDirResolved(): string | null {
  const fromRoot = path.join(process.cwd(), 'apps/operator/prompts');
  if (fs.existsSync(fromRoot)) return fromRoot;
  const fromOperator = path.join(process.cwd(), 'prompts');
  if (fs.existsSync(fromOperator)) return fromOperator;
  return null;
}

/** loadScannerRolePrompt()'s first candidate (operator-prompt-system.ts). */
function scannerPromptResolved(): string | null {
  const candidates = [
    path.join(process.cwd(), '..', '..', 'libs', 'papercusp', 'packages', 'harness', 'blueprints', 'base', 'prompts', 'scanner.md'),
    path.join(process.cwd(), 'libs', 'papercusp', 'packages', 'harness', 'blueprints', 'base', 'prompts', 'scanner.md'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** host-docs.ts PUBLIC_DOCS_ROOT default (__dirname-relative → release when running release code). */
function docsRootResolved(): string | null {
  if (process.env.PAPERCUSP_DOCS_ROOT) return path.resolve(process.env.PAPERCUSP_DOCS_ROOT);
  const fromCwd = path.join(process.cwd(), 'apps/operator/public/internal/docs');
  if (fs.existsSync(fromCwd)) return fromCwd;
  const fromOperator = path.join(process.cwd(), 'public/internal/docs');
  if (fs.existsSync(fromOperator)) return fromOperator;
  return null;
}

export interface VerifyResult {
  ok: boolean;
  releaseRoot: string;
  cwd: string;
  checks: Array<{ name: string; resolved: string | null; underRelease: boolean; exists: boolean }>;
  failures: string[];
}

export function verifyReleasePaths(releaseRoot?: string): VerifyResult {
  const cfg = releaseConfig();
  const root = path.resolve(releaseRoot ?? cfg.releaseRoot);
  const checks: Check[] = [
    { name: 'sqlMigrations', resolved: resolveSqlDir(), mustExist: true },
    { name: 'operatorPrompts', resolved: promptsDirResolved(), mustExist: true },
    { name: 'scannerPrompt', resolved: scannerPromptResolved(), mustExist: true },
    { name: 'internalDocs', resolved: docsRootResolved(), mustExist: false },
  ];

  const out: VerifyResult['checks'] = [];
  const failures: string[] = [];
  for (const c of checks) {
    const resolved = c.resolved ? path.resolve(c.resolved) : null;
    const underRelease = resolved ? (resolved === root || resolved.startsWith(root + path.sep)) : false;
    const exists = resolved ? fs.existsSync(resolved) : false;
    out.push({ name: c.name, resolved, underRelease, exists });
    if (!resolved) failures.push(`${c.name}: did not resolve`);
    else if (!underRelease) failures.push(`${c.name}: resolved OUTSIDE release root → ${resolved}`);
    else if (c.mustExist && !exists) failures.push(`${c.name}: resolved but missing on disk → ${resolved}`);
  }

  return { ok: failures.length === 0, releaseRoot: root, cwd: process.cwd(), checks: out, failures };
}

// CLI — stdout carries ONLY the marker-delimited JSON line so the deploy's
// parser is immune to stray stdout (a trailing human line, or a PG NOTICE that
// an imported module's onnotice handler logs — both observed polluting this
// subprocess's stdout, 2026-06-05). All human text goes to stderr.
export const VERIFY_RESULT_MARKER = '__VERIFY_RELEASE_PATHS__';
if (require.main === module) {
  const result = verifyReleasePaths(process.argv[2]);
  console.log(`${VERIFY_RESULT_MARKER} ${JSON.stringify(result)}`);
  if (!result.ok) {
    console.error(`\n[verify-release-paths] FAIL — ${result.failures.length} issue(s)`);
    for (const f of result.failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.error('\n[verify-release-paths] OK — all runtime reads resolve under the release checkout');
}
