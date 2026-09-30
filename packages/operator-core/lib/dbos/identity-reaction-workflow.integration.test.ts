/**
 * Identity reactions on the real stack (portable-identity-packages-2026-09-26
 * P-018, D-027..D-032): a fully migrated Postgres, the real DBOS executor, the
 * real key latch, the request-side DBOSClient enqueue and the real projected
 * dispatcher. Everything runs in child processes (test/_identity-reaction-child.ts)
 * so the executor can be SIGKILLed and recovered; this file asserts on the rows.
 *
 * Covered: enqueue → detach / upgrade / capability revoke before execution;
 * missing capability at install and at fire; role and quota refusal charged
 * per wearer; two wearers of one fire; replay without a second effect; and a
 * SIGKILL after authorization, before the effect, recovered by authorizing
 * again (one wearer detached in between: refused, zero effects; the other
 * unchanged: fired exactly once). Invocation attribution names the wearer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const workspaceId = 'identity-reaction-it';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childPath = resolve(packageRoot, 'test/_identity-reaction-child.ts');
const APP_VERSION = 'identity-reaction-it-v1';

interface Receipt {
  dedup_id: string; rule_id: string; status: string; error_message: string | null; fire: string; contributor: string | null;
}

let db: OrgTestDb;
let potDir: string;
let setupReport: { install: Record<string, { ok: boolean; error?: string; capability?: string }> };
let report: {
  enqueued: Record<string, Array<{ status: string; n: number }>>;
  replay: { enqueue: string; execute: { status: string; prior?: string } };
  receipts: Record<'basic' | 'guarded' | 'quota' | 'role' | 'bare', Receipt[]>;
};

function runChild(mode: 'setup' | 'scenarios' | 'crash' | 'recover') {
  return spawnSync(process.execPath, ['--import', 'tsx', childPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      IRX_MODE: mode,
      IRX_DSN: db.adminDsn,
      IRX_WORKSPACE: workspaceId,
      IRX_POT_DIR: potDir,
      DBOS__APPVERSION: APP_VERSION,
      PAPERCUSP_DBOS_ORCHESTRATOR: '1',
      HARNESS_ADMIN_DATABASE_URL: db.adminDsn,
      HARNESS_DATABASE_URL: db.appDsn,
      PAPERCUSP_SKIP_PG_DISCOVERY: '1',
      PAPERCUSP_WORKSPACE_ID: workspaceId,
    },
    timeout: 240_000,
    encoding: 'utf8' as const,
  });
}

function childReport<T>(run: ReturnType<typeof runChild>, label: string): T {
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('IRX_REPORT '));
  if (run.status !== 0 || !line) {
    throw new Error(`${label} child exited ${run.status}/${run.signal}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr.slice(-6000)}`);
  }
  return JSON.parse(line.slice('IRX_REPORT '.length)) as T;
}

/** The wearer a receipt belongs to: its id is `identity-reaction:<fire>:<owner>:<tag>:<pin>`. */
const byOwner = (rows: Receipt[], owner: string) => rows.filter((row) => row.dedup_id.includes(`:${owner}:`));
const statusOf = (rows: Receipt[], owner: string) => byOwner(rows, owner).map((row) => row.status).sort();

const effects = (tool: string) => db.adminSql<Array<{ owner_id: string; title: string }>>`
  SELECT owner_id, title FROM public.irx_effects WHERE tool = ${tool} ORDER BY owner_id, id`;

beforeAll(async () => {
  db = await createOrgTestDb();
  potDir = mkdtempSync(join(tmpdir(), 'irx-pot-'));
  setupReport = childReport(runChild('setup'), 'setup');
  report = childReport(runChild('scenarios'), 'scenarios');
}, 600_000);

afterAll(async () => {
  await db?.cleanup();
  if (potDir) rmSync(potDir, { recursive: true, force: true });
}, 120_000);

describe('install checks (D-027 §1)', () => {
  it('admits a catalogued key firing a class verb that declares a capability', () => {
    expect(setupReport.install.good).toMatchObject({ ok: true, capability: 'irx:tasks-create' });
  });

  it('refuses a class verb that declares no capability, and an uncatalogued key', () => {
    expect(setupReport.install.missingCapability.ok).toBe(false);
    expect(setupReport.install.missingCapability.error).toMatch(/declares no `capability`/);
    expect(setupReport.install.uncatalogued.ok).toBe(false);
    expect(setupReport.install.uncatalogued.error).toMatch(/not catalogued/);
  });
});

describe('enqueue, then live state changes before execution', () => {
  it('the emit enqueued one durable workflow per wearer without running any', () => {
    expect(report.enqueued.basic).toEqual([{ status: 'ENQUEUED', n: 4 }]);
    expect(report.enqueued.guarded).toEqual([{ status: 'ENQUEUED', n: 4 }]);
  });

  it('two unchanged wearers each fire once, as themselves', async () => {
    const rows = report.receipts.basic;
    expect(statusOf(rows, 'su-irx-alpha')).toEqual(['fired']);
    expect(statusOf(rows, 'su-irx-beta')).toEqual(['fired']);
    expect(byOwner(rows, 'su-irx-alpha')[0]).toMatchObject({
      rule_id: 'file-task', fire: 'class:irx.tasks@1.0.0#create',
    });
    expect(await effects('irx:create')).toEqual([
      { owner_id: 'su-irx-alpha', title: 'file-task' },
      { owner_id: 'su-irx-beta', title: 'file-task' },
    ]);
  });

  it('a wearer detached after enqueue is refused with zero dispatch', () => {
    const [row] = byOwner(report.receipts.basic, 'su-irx-detach');
    expect(row).toMatchObject({ status: 'refused' });
    expect(row.error_message).toMatch(/^detached: /);
  });

  it('a wearer upgraded after enqueue is refused as attachment-changed', () => {
    const [row] = byOwner(report.receipts.basic, 'su-irx-upgrade');
    expect(row).toMatchObject({ status: 'refused' });
    expect(row.error_message).toMatch(/^attachment-changed: /);
  });

  it('a capability revoked from the pot ceiling after enqueue empties the allowlist: zero dispatch', async () => {
    const rows = report.receipts.guarded;
    for (const owner of ['su-irx-alpha', 'su-irx-beta']) {
      const [row] = byOwner(rows, owner);
      expect(row.status).toBe('refused');
      expect(row.error_message).toMatch(/^capability-empty: /);
    }
    expect(await effects('irx:guarded-tool')).toEqual([]);
  });

  it('a replayed enqueue and a replayed step both collapse onto the settled receipt', async () => {
    expect(report.replay.enqueue).toBe('enqueued');
    expect(report.replay.execute).toEqual({ status: 'replayed', prior: 'fired' });
    expect((await effects('irx:create')).filter((row) => row.owner_id === 'su-irx-alpha')).toHaveLength(1);
  });
});

describe('dispatch as the wearer: no bypass, charged to the wearer (D-032)', () => {
  it('quota is per wearer: each wearer fires once, then its own second reaction is refused', async () => {
    const rows = report.receipts.quota;
    for (const owner of ['su-irx-alpha', 'su-irx-beta']) {
      expect(statusOf(rows, owner)).toEqual(['failed', 'fired']);
      const failed = byOwner(rows, owner).find((row) => row.status === 'failed');
      expect(failed?.error_message).toMatch(/quota/i);
    }
    expect((await effects('irx:limited')).map((row) => row.owner_id)).toEqual(['su-irx-alpha', 'su-irx-beta']);
  });

  it('a role the tool does not admit fails the reaction with zero effect', async () => {
    for (const owner of ['su-irx-alpha', 'su-irx-beta']) {
      const [row] = byOwner(report.receipts.role, owner);
      expect(row.status).toBe('failed');
      expect(row.error_message).toMatch(/role/i);
    }
    expect(await effects('irx:admin-only')).toEqual([]);
  });

  it('a class verb with no capability is refused at fire with zero dispatch', async () => {
    for (const owner of ['su-irx-alpha', 'su-irx-beta']) {
      const [row] = byOwner(report.receipts.bare, owner);
      expect(row.status).toBe('refused');
      expect(row.error_message).toMatch(/^class-invalid: /);
    }
    expect(await effects('irx:bare')).toEqual([]);
  });

  it('every dispatch is attributed to its wearer and windowed on the wearer subject', async () => {
    const rows = await db.adminSql<Array<{
      tool_name: string; coord_owner_id: string | null; spawn_id: string; role: string; window_key: string; status: string;
    }>>`
      SELECT tool_name, coord_owner_id, spawn_id, role, window_key, status
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId} AND tool_name LIKE 'irx:%'
       ORDER BY tool_name, coord_owner_id, id`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.spawn_id).toBe('identity-reaction');
      expect(row.role).toBe('su');
      expect(row.window_key).toBe(`subject:wearer:${row.coord_owner_id}`);
    }
    expect(rows.filter((row) => row.tool_name === 'irx:create' && row.status === 'ok').map((row) => row.coord_owner_id))
      .toEqual(['su-irx-alpha', 'su-irx-beta']);
    // No reaction ever ran under the generic reaction authorities.
    const [{ n }] = await db.adminSql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId} AND coord_owner_id IN ('system:event-reaction', 'plugin:event-reaction')`;
    expect(n).toBe(0);
  });
});

describe('SIGKILL after authorization, before the effect', () => {
  it('recovery authorizes again: a wearer detached meanwhile is refused, the unchanged one fires exactly once', async () => {
    const crash = runChild('crash');
    expect(crash.signal, `crash child stdout:\n${crash.stdout}\nstderr:\n${crash.stderr.slice(-6000)}`).toBe('SIGKILL');
    const pending = await db.adminSql<Array<{ status: string; wf: string }>>`
      SELECT r.status, w.status AS wf FROM harness_shared.event_reactions r
        JOIN dbos.workflow_status w ON w.workflow_uuid = r.dedup_id
       WHERE r.workspace_id = ${workspaceId} AND r.trigger_tool = 'event:irx.crash'`;
    expect(pending).toEqual([
      { status: 'authorizing', wf: 'PENDING' },
      { status: 'authorizing', wf: 'PENDING' },
    ]);
    expect(await effects('irx:create')).toHaveLength(2); // only the earlier basic fires

    await db.adminSql`
      UPDATE harness_shared.session_briefs
         SET control_state = ${db.adminSql.json({ scope: { harness: 'irx-pot' } })},
             control_generation = control_generation + 1
       WHERE owner_id = 'su-irx-crash-detach'`;

    const recovered = childReport<{ receipts: Receipt[] }>(runChild('recover'), 'recover');
    expect(statusOf(recovered.receipts, 'su-irx-crash')).toEqual(['fired']);
    const [detached] = byOwner(recovered.receipts, 'su-irx-crash-detach');
    expect(detached.status).toBe('refused');
    expect(detached.error_message).toMatch(/^detached: /);
    expect((await effects('irx:create')).filter((row) => row.title === 'crash')).toEqual([
      { owner_id: 'su-irx-crash', title: 'crash' },
    ]);
    const settled = await db.adminSql<Array<{ status: string }>>`
      SELECT w.status FROM dbos.workflow_status w
        JOIN harness_shared.event_reactions r ON r.dedup_id = w.workflow_uuid
       WHERE r.workspace_id = ${workspaceId} AND r.trigger_tool = 'event:irx.crash'`;
    expect(settled.map((row) => row.status)).toEqual(['SUCCESS', 'SUCCESS']);
  }, 600_000);
});
