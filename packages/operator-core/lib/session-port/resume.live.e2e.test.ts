/** D-021's final current-build matrix. Run only after the launcher source wall. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexHomeForSessionKey, sessionClaudeConfigDir } from '@papercusp/orchestrator/session-launch-dirs';
import { describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun } from '../agent-tools/testing/record-run';
import { ompAgentHomeForSessionKey } from '../session-transcript-resolvers';
import { pgSessionArchiveStore } from '../session-archive';
import { findCanonicalClaudeLiveJsonl, findCanonicalNativeLiveJsonl, readCanonicalClaudeArchive,
  readCanonicalNativeArchive, readStableLiveJsonl } from './source';
import { adaptNativeSessionJsonl } from './native-adapter';
import { SESSION_PORT_SUPPORTED_PAIRS, type SessionBackend } from './types';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const enabled = Boolean(profilePath && process.env.PAPERCUSP_CBP_FINAL_MATRIX === '1');
const workspace = 'papercusp-workspace';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Session = { id: string; agent: SessionBackend; coord_owner_id: string;
  session_id: string | null; omp_thread_id: string | null; ended_at: string | null };

function call(name: string, args: Record<string, unknown>, origin: string) {
  const env = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.ok, JSON.stringify(value)).not.toBe(false);
  return value;
}

function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 10, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, any>>;
}

async function native(session: Session, archivedSource = false) {
  const id = session.agent === 'omp' ? session.omp_thread_id ?? session.session_id : session.session_id;
  if (!id) return undefined;
  const path = await (session.agent === 'claude'
    ? findCanonicalClaudeLiveJsonl(sessionClaudeConfigDir(session.coord_owner_id), id)
    : findCanonicalNativeLiveJsonl(join(session.agent === 'codex'
      ? codexHomeForSessionKey(Number(session.id)) : ompAgentHomeForSessionKey(Number(session.id)), 'sessions'), session.agent, id))
    .catch(error => { if (!archivedSource) throw error; return null; });
  // Ended fixtures are archived and removed from disk by the normal lifecycle.
  // Read their exact native archive with the production manifest/hash guards.
  // A fresh cross-backend target must still prove its physical live transcript.
  const snapshot = path ? await readStableLiveJsonl(path) : session.agent === 'claude'
    ? await readCanonicalClaudeArchive({ sessionId: id }, pgSessionArchiveStore())
    : await readCanonicalNativeArchive({ backend: session.agent, sessionId: id }, pgSessionArchiveStore());
  const text = adaptNativeSessionJsonl(session.agent, snapshot.bytes.toString('utf8'), id)
    .turns.flatMap(turn => turn.blocks.flatMap(block => 'text' in block ? [String(block.text)] : [])).join('\n');
  return { id, path, sha256: snapshot.sha256, text };
}

describe.skipIf(!enabled)('final live session resume matrix', () => {
  it('delivers six cross-backend ports and three original-backend PUI-shaped resumes', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    const origin = profile.origin as string;
    const recordContext = { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    const owner = call('coord:whoami', {}, origin).ownerId as string;
    expect(owner).toBe(process.env.PAPERCUSP_SID);
    const ids = profile.resumeMatrix.sourceAdvSessionIds as number[];
    expect(ids).toHaveLength(3);
    expect(ids.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true);
    const sessions = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at
      FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
      AND id IN (${ids.join(',')}) ORDER BY id LIMIT 3`, origin) as Session[];
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map(session => session.agent))).toEqual(new Set(['claude', 'codex', 'omp']));
    for (const source of sessions) {
      expect(source.ended_at, `Source ${source.id} must be an ended plan fixture`).toBeTruthy();
      const snapshot = await native(source, true);
      expect(snapshot?.text).toContain('MATRIX-SRC');
    }
    // Fresh managed hosts below use the canonical launcher, whose bytes must
    // match this committed test tree. No existing peer host is restarted.
    const canonical = process.env.PAPERCUSP_CANONICAL_TREE || process.env.PAPERCUSP_INTEGRATION_ROOT;
    if (!canonical) throw new Error('The final matrix requires the maintained canonical tree selector');
    const sourceHashes: Record<string, string> = {};
    for (const path of ['apps/operator/scripts/psu-launcher.mjs', 'apps/operator/scripts/psu-pty-host.mjs']) {
      const hash = (base: string) => createHash('sha256').update(readFileSync(resolve(base, path))).digest('hex');
      sourceHashes[path] = hash(root);
      expect(hash(canonical), `Canonical ${path} changed after preparation`).toBe(sourceHashes[path]);
    }
    const observations: Array<Record<string, unknown>> = [];
    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts',
      name: 'D-021 six ordered session ports and original-backend PUI resume shapes', framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/session-port/resume.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const launch = async (source: Session, target?: SessionBackend) => {
          const startedAt = new Date().toISOString();
          const args = ['--no-picker', '--headless', `--workspace=${workspace}`, '--harness=papercusp',
            '--no-plan', '--context-size=trimmed', '--account=auto', `--launched-by=${owner}`,
            `--resume=${source.id}`, `--label=cbp-final-${source.agent}-${target ?? 'same'}`];
          if (target) {
            args.push(`--agent=${target}`);
            // Preserve the established matrix's compatible backend profiles.
            if (target === 'codex') args.push('--model=gpt-6.1-sol:xhigh', '--model-source=explicit');
            if (target === 'claude') args.push('--model=fable[1m]');
          }
          const command = ['env', '-u', 'PAPERCUSP_SID', '-u', 'PAPERCUSP_CAPABILITY_BASH_FOREGROUND',
            `PAPERCUSP_PSU_LAUNCHER=${canonical}/apps/operator/scripts/psu-launcher.mjs`,
            `PAPERCUSP_OPERATOR_URL=${origin}`, process.execPath,
            `${canonical}/apps/operator/scripts/psu-launcher.mjs`, ...args].map(shellQuote).join(' ');
          const task = call('capability:bash', { command, cwd: canonical, timeout: 900_000,
            run_in_background: true, work_item_id: 'WI-6554700010009934',
            description: `Final matrix ${source.agent} to ${target ?? 'original backend'}` }, origin);
          expect(task.task_id).toBeTruthy();
          console.info('CBP_FINAL_RESUME_TASK', JSON.stringify(task));
          try {
            let resumed!: Session;
            let port: Record<string, any> | undefined;
            await expect.poll(() => {
              const candidates = rows(`SELECT id, agent, coord_owner_id, session_id, omp_thread_id, ended_at,
                port_id FROM harness_shared.adv_sessions WHERE workspace_id = ${literal(workspace)}
                AND ${target ? `label = ${literal(`cbp-final-${source.agent}-${target}`)}
                  AND started_at >= ${literal(startedAt)}::timestamptz` : `id = ${Number(source.id)} AND ended_at IS NULL`}
                ORDER BY id DESC LIMIT 1`, origin);
              if (!candidates[0]) return false;
              resumed = candidates[0] as Session;
              if (resumed.agent !== (target ?? source.agent)) return false;
              if (!target) return Boolean(resumed.session_id || resumed.omp_thread_id);
              port = rows(`SELECT id, status, source_adv_session_id, target_adv_session_id, metadata
                FROM harness_shared.session_ports WHERE workspace_id = ${literal(workspace)}
                AND target_adv_session_id = ${Number(resumed.id)} ORDER BY prepared_at DESC LIMIT 1`, origin)[0];
              return port?.status === 'delivered';
            }, { timeout: 240_000, interval: 5000 }).toBe(true);
            let snapshot: Awaited<ReturnType<typeof native>>;
            await expect.poll(async () => {
              snapshot = await native(resumed);
              return Boolean(snapshot?.text.includes(target ? `port-id: ${port!.id}` : 'MATRIX-SRC'));
            }, { timeout: 120_000, interval: 5000 }).toBe(true);
            if (!target) expect(snapshot!.id).toBe(source.agent === 'omp'
              ? source.omp_thread_id ?? source.session_id : source.session_id);
            else {
              expect(Number(port!.source_adv_session_id)).toBe(Number(source.id));
              expect(port!.metadata.persistenceProof).toBeTruthy();
            }
            observations.push({ source: source.agent, target: target ?? source.agent,
              sourceAdvSessionId: source.id, targetAdvSessionId: resumed.id,
              port, nativePath: snapshot!.path, nativeSha256: snapshot!.sha256, nativeSessionId: snapshot!.id });
            console.info('CBP_FINAL_RESUME_OBSERVATION', JSON.stringify(observations.at(-1)));
          } finally {
            // This task was created by this test; stop its managed subtree only.
            call('processes:kill', { taskId: task.task_id, includeSubtree: true }, origin);
          }
        };
        for (const pair of SESSION_PORT_SUPPORTED_PAIRS) {
          await launch(sessions.find(session => session.agent === pair.source)!, pair.target);
        }
        for (const source of sessions) await launch(source);
        expect(observations).toHaveLength(9);
        for (const [path, sha256] of Object.entries(sourceHashes)) {
          expect(createHash('sha256').update(readFileSync(resolve(canonical, path))).digest('hex')).toBe(sha256);
        }
        return { exitCode: 0, summary: 'Six fresh delivered ports and three PUI-shaped original-backend native resumes',
          assertions: observations.map((observation, index) => ({
            id: `resume-${index}-${observation.source}-${observation.target}`, passed: true,
            evidence: JSON.stringify(observation).slice(0, 2000),
          })) };
      },
    }, recordContext);
    console.info('CBP_FINAL_RESUME_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 3_600_000);
});
