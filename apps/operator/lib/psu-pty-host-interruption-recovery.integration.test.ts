// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { hermeticEnv } from '../vitest-shims/psu-pty-temp-dir';
import { metaPathFor, socketPathFor } from '../scripts/psu-pty-host.mjs';

const m = vi.hoisted(() => ({ sql: null as any, launch: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<object>(), getOrgPg: () => ({ sql: m.sql }),
}));
// Only the final native launch is substituted: it opens a real managed PTY with
// a deterministic CLI, avoiding model calls. WAL, ingest, SQL arbitration,
// discovery, classifier, teardown and the replacement host are production code.
vi.mock('../../../packages/operator-core/lib/agent-tools/capability/launch-agent', () => ({
  default: { handler: m.launch }, INTERNAL_INTERRUPTION_RECOVERY: Symbol.for('host-journey'),
}));
import { sweepSessionInterruptions } from '@papercusp/operator-core/lib/harness/routines/session-interruption-runtime';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); m.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });

async function eventually<T>(read: () => T | undefined): Promise<T> {
  return vi.waitFor(() => {
    const value = read();
    expect(value).toBeDefined();
    return value as T;
  }, { timeout: 15_000, interval: 30 });
}

describe('lost host to restored native conversation', () => {
  it.each([
    { headless: true, waiting: false, stopped: false },
    { headless: false, waiting: true, stopped: false },
    { headless: true, waiting: false, stopped: true },
  ])('preserves placement=$headless wait=$waiting stop=$stopped', async scenario => {
    const root = mkdtempSync(join(tmpdir(), 'interrupted-host-journey-'));
    const owner = `ih-${process.pid}-${Date.now()}`;
    const ws = 'interrupted-host-journey';
    const native = '30c49db4-e1e3-4ac7-9bec-960c500b46ea';
    const config = join(root, 'codex');
    mkdirSync(join(config, 'sessions'), { recursive: true });
    writeFileSync(join(config, 'config.toml'), '');
    const transcript = join(config, 'sessions', `rollout-${native}.jsonl`);
    writeFileSync(transcript, '');
    const [adv] = await db.adminSql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, agent, mode, coord_owner_id, session_id, started_at, launch_spec)
      VALUES (${ws}, 'codex', 'console', ${owner}, ${native}, now(),
        ${JSON.stringify({ headless: scenario.headless })}::jsonb) RETURNING id`;
    const children: ChildProcess[] = [];
    const hostModule = fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url));
    const readMeta = () => {
      try { return JSON.parse(readFileSync(metaPathFor(owner), 'utf8')); } catch { return undefined; }
    };
    const start = async (work: boolean) => {
      const nativeCode = `const fs=require('node:fs');
        if (${work}) fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify({type:'event_msg',
          timestamp:new Date().toISOString(),payload:{type:'task_started'}})+'\\n');
        process.stdout.write('READY\\n'); setInterval(()=>{},1000);`;
      const hostCode = `import {hostThroughPty} from ${JSON.stringify(hostModule)};
        import {EventEmitter} from 'node:events';
        const stdin=Object.assign(new EventEmitter(),{isTTY:false,resume(){},pause(){}});
        const signalSource=new EventEmitter();
        const done=hostThroughPty({command:process.execPath,args:['-e',${JSON.stringify(nativeCode)}],
          cwd:${JSON.stringify(root)},ownerId:${JSON.stringify(owner)},advSessionId:${JSON.stringify(String(adv.id))},
          env:process.env,bridgeTty:false,activityPersistMs:25,
          io:{stdin,stdout:{isTTY:false,write(){return true;}}},signalSource,onExit(){}});
        ${scenario.stopped && work ? "setTimeout(()=>stdin.emit('data',Buffer.from('\\x03')),150);" : ''}
        process.on('SIGTERM',()=>signalSource.emit('SIGTERM')); await done;`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', hostCode], {
        cwd: root, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: hermeticEnv({ CODEX_HOME: config, PAPERCUSP_SID: owner,
          PAPERCUSP_AGENT: 'codex', PAPERCUSP_WORKSPACE_ID: ws,
          PAPERCUSP_PSU_HEADLESS: scenario.headless ? '1' : '0' }),
      });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += chunk; });
      return eventually(() => {
        if (child.exitCode != null) throw new Error(`fixture host exited: ${stderr}`);
        const meta = readMeta();
        return meta?.pid === child.pid && meta.execution?.nativeSessionId === native ? meta : undefined;
      });
    };
    try {
      const original = await start(true);
      await eventually(() => {
        const meta = readMeta();
        return meta?.execution?.phase === 'running' &&
          (!scenario.stopped || meta.execution.ownerStopRequested) ? meta : undefined;
      });
      if (scenario.waiting) await db.adminSql`INSERT INTO harness_shared.event_awaits
        (workspace_id, subscriber_id, event_key, policy)
        VALUES (${ws}, ${owner}, 'dependency:journey-ready', 'wake')`;
      await db.adminSql`UPDATE harness_shared.adv_sessions SET pid = ${original.pid}
        WHERE id = ${adv.id}`;
      const first = children[0]!;
      const exited = new Promise(resolve => first.once('exit', resolve));
      process.kill(-first.pid!, 'SIGKILL');
      await exited;
      m.launch.mockReset().mockImplementation(async (args: any) => {
        expect(args).toMatchObject({ resume: { agentId: owner }, fork: false, headless: scenario.headless });
        expect(args[Symbol.for('host-journey')]).toEqual({ ownerId: owner,
          nativeSessionId: native, wait: scenario.waiting });
        expect(Boolean(args.brief)).toBe(!scenario.waiting);
        // A wait-only restore must not manufacture native progress.
        const before = readFileSync(transcript, 'utf8');
        const replacement = await start(!scenario.waiting);
        expect(replacement.execution.nativeSessionId).toBe(native);
        if (scenario.waiting) expect(readFileSync(transcript, 'utf8')).toBe(before);
        return { data: { launch: { resumeVerified: true } } };
      });
      const result = await sweepSessionInterruptions({ workspaceId: ws,
        installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: null });
      if (scenario.stopped) {
        expect(m.launch).not.toHaveBeenCalled();
        expect(result.held[owner]).toBe('owner-stop');
      } else {
        expect(result.restored).toContain(owner);
        expect(m.launch).toHaveBeenCalledTimes(1);
        await sweepSessionInterruptions({ workspaceId: ws, installSlug: 'papercusp',
          triggerConfig: {}, payloadTemplate: null });
        expect(m.launch).toHaveBeenCalledTimes(1);
        expect(existsSync(socketPathFor(owner))).toBe(true);
      }
    } finally {
      for (const child of children) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ }
      }
      await Promise.all(children.map(child => child.exitCode != null || child.signalCode != null
        ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
      await db.adminSql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.psu_pty_host_events WHERE owner_id = ${owner}`;
      await db.adminSql`DELETE FROM harness_shared.adv_sessions WHERE id = ${adv.id}`;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
