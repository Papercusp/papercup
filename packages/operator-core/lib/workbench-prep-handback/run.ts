/**
 * Operational runner for the Workbench preparation-handback checker
 * (WI-6554700010049420). Supplies the real Git + Postgres reads to the pure
 * `checkPrepHandback` and writes a committed-evidence artifact shaped for
 * `testing:record-run { evidenceFile, expectedSha256 }`.
 *
 *   npx tsx packages/operator-core/lib/workbench-prep-handback/run.ts \
 *     [--handback docs/handbacks/workbench-p006-prep-ubuntu.json] \
 *     [--out docs/evidence/workbench-p006-prep-ubuntu-handback-check-20261115.json] \
 *     [--allow-dirty]
 *
 * Read-only: Git object reads and two SELECTs. It refuses to run when the
 * handback or the checker is uncommitted (the artifact must cite committed
 * bytes) unless `--allow-dirty` is passed, which is recorded in the artifact.
 * Exit 0 only when both assertions pass; 1 when an assertion fails; 2 on refusal.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import {
  INSTALLED_BOUNDARY_CASE, SOURCE_IDENTITY_CASE, checkPrepHandback, summarizeCase,
  type ClauseRow, type LedgerRow, type PrepHandbackDeps,
} from './check';

const WORKSPACE_ID = process.env.PREP_HANDBACK_WORKSPACE ?? 'papercusp-workspace';
const HARNESS_SLUG = process.env.PREP_HANDBACK_HARNESS ?? 'papercusp';
const DEFAULT_HANDBACK = 'docs/handbacks/workbench-p006-prep-ubuntu.json';
const DEFAULT_OUT = 'docs/evidence/workbench-p006-prep-ubuntu-handback-check-20261115.json';

const here = dirname(fileURLToPath(import.meta.url));

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** `git ls-tree <commit> -- <path>` entry of the wanted type, else null (absent path or object). */
function treeEntry(cwd: string, commit: string, path: string, type: 'commit' | 'blob'): string | null {
  const out = git(cwd, ['ls-tree', commit, '--', path]);
  const match = out?.match(/^\d{6} (\w+) ([0-9a-f]{40})\t(.+)$/);
  return match && match[1] === type && match[3] === path ? match[2] : null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const root = git(here, ['rev-parse', '--show-toplevel']);
  if (!root) { console.error('not inside a git checkout'); return 2; }
  const handbackRel = arg('--handback') ?? DEFAULT_HANDBACK;
  const outRel = arg('--out') ?? DEFAULT_OUT;
  const allowDirty = process.argv.includes('--allow-dirty');
  const checkerRel = relative(root, join(here, 'check.ts'));
  const runnerRel = relative(root, fileURLToPath(import.meta.url));

  const inputs = [handbackRel, checkerRel, runnerRel].map((path) => {
    const bytes = readFileSync(resolve(root, path));
    const dirty = (git(root, ['status', '--porcelain', '--', path]) ?? 'unknown').length > 0;
    const commit = git(root, ['log', '-1', '--format=%H', '--', path]) || null;
    const committedBlob = commit ? treeEntry(root, commit, path, 'blob') : null;
    const workingBlob = git(root, ['hash-object', '--', path]);
    return { path, sha256: sha256(bytes), commit, dirty, blobEqualsCommit: !!committedBlob && committedBlob === workingBlob };
  });
  const uncommitted = inputs.filter((i) => i.dirty || !i.blobEqualsCommit);
  if (uncommitted.length && !allowDirty) {
    console.error(`refusing: uncommitted input(s): ${uncommitted.map((i) => i.path).join(', ')} (wait for git-sync, or pass --allow-dirty)`);
    return 2;
  }

  const handback = JSON.parse(readFileSync(resolve(root, handbackRel), 'utf8'));
  const sub = (path: string) => resolve(root, path);
  const db = new Client({ connectionString: getHarnessAdminUrl() });
  await db.connect();
  try {
    const deps: PrepHandbackDeps = {
      gitlink: async (commit, submodulePath) => treeEntry(root, commit, submodulePath, 'commit'),
      blob: async (submodulePath, commit, path) => treeEntry(sub(submodulePath), commit, path, 'blob'),
      changedFiles: async (submodulePath, base, head) => {
        const out = git(sub(submodulePath), ['diff', '--name-only', base, head]);
        return out ? out.split('\n').filter(Boolean) : [];
      },
      registeredSuites: async (submodulePath, commit) => {
        const pkg = git(sub(submodulePath), ['show', `${commit}:package.json`]);
        if (!pkg) return [];
        const scripts = (JSON.parse(pkg).scripts ?? {}) as Record<string, string>;
        return Object.values(scripts);
      },
      testRun: async (id): Promise<LedgerRow | null> => {
        const { rows } = await db.query(
          'SELECT id, file_path, status, worktree_dirty, commit_sha FROM harness_shared.test_runs WHERE id = $1', [id]);
        const r = rows[0];
        return r ? { id: Number(r.id), filePath: r.file_path, status: r.status, worktreeDirty: r.worktree_dirty, commitSha: r.commit_sha } : null;
      },
      clause: async (plan, specId, revision): Promise<ClauseRow | null> => {
        const { rows } = await db.query(
          `SELECT revision, content_hash, plan_item_id, falsifier->'requiredScenarios' AS scenarios
             FROM harness_shared.plan_spec_clause_revisions
            WHERE workspace_id = $1 AND harness_slug = $2 AND plan_slug = $3 AND spec_id = $4 AND revision = $5`,
          [WORKSPACE_ID, HARNESS_SLUG, plan, specId, revision]);
        const r = rows[0];
        if (!r) return null;
        const scenarios = Array.isArray(r.scenarios) ? r.scenarios.filter((s: unknown): s is string => typeof s === 'string') : [];
        return { revision: r.revision, contentHash: r.content_hash, planItemId: r.plan_item_id, requiredScenarios: scenarios };
      },
    };

    const results = await checkPrepHandback(handback, deps);
    const passed = results.every((r) => r.passed);
    const exitCode = passed ? 0 : 1;
    const byId = new Map(results.map((r) => [r.id, r]));
    const artifact = {
      schemaVersion: 1,
      kind: 'operational-test-evidence',
      name: 'Workbench P-006 PREP-UBUNTU handback check: source-identity handoff and unverified installed boundary',
      framework: 'operational',
      command: ['npx', 'tsx', runnerRel, ...process.argv.slice(2)],
      exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: `${results.filter((r) => r.passed).length}/${results.length} assertions passed for ${handbackRel} `
        + `(plan ${handback.plan} ${handback.fromItem} -> ${handback.toItem}, clause ${handback.clause?.specId}@${handback.clause?.revision}). `
        + 'Read-only Git object reads plus harness_shared.test_runs and plan_spec_clause_revisions SELECTs. '
        + 'Installed-candidate checks are asserted to remain unresolved; nothing installed, accepted or on main is claimed.',
      assertions: [SOURCE_IDENTITY_CASE, INSTALLED_BOUNDARY_CASE].map((id) => {
        const r = byId.get(id)!;
        return { id, passed: r.passed, evidence: summarizeCase(r) };
      }),
      workItems: ['WI-6554700010049420'],
      plan: handback.plan,
      clauses: [`${handback.clause?.specId}@${handback.clause?.revision}`],
      evidencePlane: 'source',
      inputs,
      allowDirty,
      checks: results,
    };
    mkdirSync(dirname(resolve(root, outRel)), { recursive: true });
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(resolve(root, outRel), body);
    console.log(`${outRel} sha256=${sha256(body)} exit=${exitCode}`);
    for (const a of artifact.assertions) console.log(`${a.passed ? 'PASS' : 'FAIL'} ${a.id}: ${a.evidence}`);
    return exitCode;
  } finally {
    await db.end();
  }
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
