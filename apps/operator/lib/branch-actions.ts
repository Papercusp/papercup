/**
 * Per-branch action registry.
 *
 * Discovers shell scripts at:
 *
 *   <project>/.harness/actions/<branch>/<name>.sh
 *
 * (where `<project>` is the harness's *staging* worktree — actions are
 * branch-scoped data, not branch-scoped storage). Branches: staging |
 * testing | production.
 *
 * Spawning is intentionally minimal: bash <script>, cwd = the branch's
 * phase worktree if it exists else the staging worktree, env =
 * { ...process.env, PAPERCUSP_BRANCH, PAPERCUSP_PROJECT_DIR,
 *   PAPERCUSP_PHASE_DIR, PAPERCUSP_HARNESS_SLUG, PAPERCUSP_ACTION_NAME }.
 *
 * Logs land at <staging>/.harness/action-runs/<branch>/<name>/<runId>.log
 * with a sibling `<runId>.json` capturing exit code + timing.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Branch = 'staging' | 'testing' | 'production';
export const BRANCHES: Branch[] = ['staging', 'testing', 'production'];

export function isBranch(s: unknown): s is Branch {
  return s === 'staging' || s === 'testing' || s === 'production';
}

export interface ActionDescriptor {
  name: string;
  scriptPath: string;
  branch: Branch;
}

export interface RunMeta {
  runId: string;
  harness: string;
  branch: Branch;
  name: string;
  scriptPath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function actionsDir(stagingPath: string, branch: Branch): string {
  return join(stagingPath, '.harness', 'actions', branch);
}

export function runRoot(stagingPath: string, branch: Branch, name: string): string {
  return join(stagingPath, '.harness', 'action-runs', branch, name);
}

export function runLogPath(stagingPath: string, branch: Branch, name: string, runId: string): string {
  return join(runRoot(stagingPath, branch, name), `${runId}.log`);
}

export function runMetaPath(stagingPath: string, branch: Branch, name: string, runId: string): string {
  return join(runRoot(stagingPath, branch, name), `${runId}.json`);
}

export async function listActions(stagingPath: string, branch: Branch): Promise<ActionDescriptor[]> {
  const dir = actionsDir(stagingPath, branch);
  try {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    const out: ActionDescriptor[] = [];
    for (const e of ents) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.sh')) continue;
      const name = e.name.replace(/\.sh$/, '');
      if (!NAME_RE.test(name)) continue;
      out.push({ name, branch, scriptPath: join(dir, e.name) });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return [];
  }
}

export async function listAllActions(
  stagingPath: string,
): Promise<Record<Branch, ActionDescriptor[]>> {
  const out: Record<Branch, ActionDescriptor[]> = {
    staging: [], testing: [], production: [],
  };
  for (const b of BRANCHES) out[b] = await listActions(stagingPath, b);
  return out;
}

export interface RunOpts {
  stagingPath: string;
  /** Phase worktree path; falls back to stagingPath if absent. */
  phasePath?: string;
  harness: string;
  branch: Branch;
  name: string;
  /** Extra env to merge over the defaults. */
  extraEnv?: Record<string, string>;
}

export interface RunHandle {
  runId: string;
  meta: RunMeta;
  /** Resolves once the child has exited and meta is flushed. */
  done: Promise<RunMeta>;
}

/**
 * Validate name + branch, ensure script exists, then spawn it. The child
 * runs detached enough that the SSE stream can attach later; output is
 * captured to the log file. The promise on `done` resolves when the child
 * exits — the route does NOT wait for it.
 */
export async function runAction(opts: RunOpts): Promise<RunHandle> {
  const { stagingPath, phasePath, harness, branch, name, extraEnv } = opts;
  if (!isBranch(branch)) throw new Error(`invalid branch: ${branch}`);
  if (!NAME_RE.test(name)) throw new Error(`invalid action name: ${name}`);

  const desc = (await listActions(stagingPath, branch)).find((a) => a.name === name);
  if (!desc) throw new Error(`action not found: ${branch}/${name}`);

  const cwd = phasePath && existsSync(phasePath) ? phasePath : stagingPath;
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const root = runRoot(stagingPath, branch, name);
  await fs.mkdir(root, { recursive: true });
  const logPath = runLogPath(stagingPath, branch, name, runId);
  const metaPath = runMetaPath(stagingPath, branch, name, runId);

  const startedAt = new Date().toISOString();
  const meta: RunMeta = {
    runId, harness, branch, name,
    scriptPath: desc.scriptPath,
    startedAt,
    status: 'running',
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

  const logFh = await fs.open(logPath, 'w');
  // Header so attached clients see what they're streaming.
  await logFh.write(`::papercusp::action-started\t${JSON.stringify({
    runId, harness, branch, name, scriptPath: desc.scriptPath,
    cwd, startedAt,
  })}\n`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PAPERCUSP_BRANCH: branch,
    PAPERCUSP_PROJECT_DIR: cwd,
    PAPERCUSP_STAGING_DIR: stagingPath,
    PAPERCUSP_PHASE_DIR: cwd,
    PAPERCUSP_HARNESS_SLUG: harness,
    PAPERCUSP_ACTION_NAME: name,
    PAPERCUSP_RUN_ID: runId,
    ...(extraEnv ?? {}),
  };

  const child = spawn('bash', [desc.scriptPath], { cwd, env });

  const t0 = Date.now();
  const writeLine = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    // Tag stderr lines so xterm can colour them.
    const text = chunk.toString('utf8');
    if (stream === 'stderr') {
      // Prefix each non-empty line with a marker.
      const lines = text.split('\n');
      const tagged = lines.map((l, i) => (l.length > 0 ? `::papercusp::stderr\t${l}` : (i < lines.length - 1 ? '' : ''))).join('\n');
      logFh.write(tagged).catch(() => undefined);
    } else {
      logFh.write(text).catch(() => undefined);
    }
  };
  child.stdout.on('data', (b: Buffer) => writeLine(b, 'stdout'));
  child.stderr.on('data', (b: Buffer) => writeLine(b, 'stderr'));

  const done = new Promise<RunMeta>((resolve) => {
    child.on('close', async (code, signal) => {
      const endedAt = new Date().toISOString();
      const final: RunMeta = {
        ...meta,
        endedAt,
        exitCode: code,
        signal: signal as string | null,
        durationMs: Date.now() - t0,
        status: code === 0 ? 'completed' : 'failed',
      };
      try {
        await logFh.write(`\n::papercusp::action-${final.status}\t${JSON.stringify({
          runId, exitCode: code, signal, durationMs: final.durationMs, endedAt,
        })}\n`);
      } catch { /* ignore */ }
      try { await logFh.close(); } catch { /* ignore */ }
      try { await fs.writeFile(metaPath, JSON.stringify(final, null, 2), 'utf8'); } catch { /* ignore */ }
      resolve(final);
    });
  });

  return { runId, meta, done };
}

export async function listRuns(
  stagingPath: string, branch: Branch, name: string,
): Promise<RunMeta[]> {
  const dir = runRoot(stagingPath, branch, name);
  try {
    const ents = await fs.readdir(dir);
    const metas: RunMeta[] = [];
    for (const f of ents) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(join(dir, f), 'utf8');
        metas.push(JSON.parse(raw) as RunMeta);
      } catch { /* skip */ }
    }
    metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return metas;
  } catch { return []; }
}
