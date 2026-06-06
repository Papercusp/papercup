/**
 * wake-resume.e2e.integration.test.ts — LIVE smoke (unify-watch-primitive P-014).
 *
 * A REAL claude agent sleeps on a watch and is REALLY resumed by the NEW pump:
 *   1. spawn a real `claude -p` turn → a resumable session (the agent "sleeps").
 *   2. register a STANDING wake watch + fire the key TWICE (a burst) → 2 deliveries.
 *   3. run the REAL pumpWakeDeliveries (the new floor+coalesce code) against an ISOLATED
 *      Postgres → it coalesces the burst into ONE wake and the REAL executeWake resumes
 *      the REAL claude session headless (`claude -p --resume <sid> "<wake text>"`).
 *   4. assert the session file grew with a new turn carrying the COALESCED wake text.
 *
 * Isolated DB on purpose — so this pump can never claim a live peer's wake delivery.
 * One-off (spawns real claude, costs tokens, needs auth) — NOT a committed CI test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn as childSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync, openSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-e2e' }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));
vi.mock('../../fleet/governor', () => ({ admitSpawn: vi.fn(async () => ({ admitted: true })) }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: vi.fn(async () => ({ msg_id: 'm' })) }));

const store = await import('./store');
const { pumpWakeDeliveries } = await import('./engine');
const { PtyError } = await import('../../pty-bridge');
const { createOrgTestDb } = await import('../../../test/_org-test-db');

function findSessionFile(sid: string): string | null {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const proj of readdirSync(root)) {
    const f = join(root, proj, `${sid}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

describe('LIVE: a real agent sleeps on a watch and the new pump resumes it', () => {
  let db: OrgTestDb;
  let cwd: string;
  let sid: string;
  let advSessionId: number;

  beforeAll(async () => {
    // The engine deliberately console.warn's wake outcomes (visible drops, D-004);
    // the suite-wide fail-on-console guard must not count those.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // (1) A real claude turn → a resumable session. This is the agent "sleeping".
    cwd = mkdtempSync(join(tmpdir(), 'wake-e2e-'));
    const out = execFileSync(
      'claude',
      ['-p', 'Reply with exactly the word SLEEPING.', '--output-format', 'json', '--dangerously-skip-permissions', '--model', 'opus'],
      { cwd, encoding: 'utf8', timeout: 120_000 },
    );
    sid = JSON.parse(out).session_id;
    expect(sid).toMatch(/[0-9a-f-]{36}/);

    // The adv_sessions row the executor re-reads at fire time. ended_at set + a dead pid
    // → the executor takes the RESUME path (the agent's turn-1 process has exited).
    const rows = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, agent, role, mode, pid, cwd, coord_owner_id, session_id, started_at, ended_at, exit_code)
      VALUES (${h.ws}, 'claude', 'worker', 'console', 987654, ${cwd}, 'su-e2e', ${sid}, now(), now(), 0)
      RETURNING id`;
    advSessionId = Number(rows[0].id);
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('coalesces a burst into ONE real resume of the sleeping agent', async () => {
    // (2) A standing wake watch + a burst of TWO fires on the key → two deliveries.
    await store.registerAwait({
      subscriberId: 'su-e2e',
      eventKey: 'e2e:ready',
      policy: 'wake',
      once: false,
      wakeHandle: { kind: 'adv-session', advSessionId, agent: 'claude', sessionId: sid, ompThreadId: null, cwd, pid: 987654 },
    });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'e2e:ready' }), summary: 'first thing landed' });
    await store.insertDeliveries({ awaits: await store.fireAwaitsForKey({ eventKey: 'e2e:ready' }), summary: 'second thing landed' });

    const sessionFile = findSessionFile(sid)!;
    expect(sessionFile).toBeTruthy();
    const sizeBefore = statSync(sessionFile).size;

    // (3) The REAL pump. Force the headless resume branch (no pty needed in this env):
    // spawnManagedPty throws PTY_CAP_REACHED → executeWake falls to detached `claude -p --resume`.
    const resumeLog = join(cwd, 'resume.log');
    const stats = await pumpWakeDeliveries(h.ws, {
      spawnManagedPty: () => {
        throw new PtyError('pty cap', 'PTY_CAP_REACHED');
      },
      // Same real `claude --resume` command the production headless path runs, but with
      // output captured so a failed resume is diagnosable instead of a blind 60s wait.
      spawnDetached: (bin, args, o) => {
        const fd = openSync(resumeLog, 'a');
        const child = childSpawn(bin, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, detached: true, stdio: ['ignore', fd, fd] });
        child.unref();
        return child.pid ?? null;
      },
    });

    // Coalesced: TWO events → ONE wake delivered, ONE sibling folded in (no second turn).
    expect(stats.delivered).toBe(1);
    expect(stats.coalesced).toBe(1);

    // (4) The real agent resumed: its session file grew with a new turn carrying the
    // coalesced wake text. Poll — a headless resume takes a few seconds.
    let grew = false;
    for (let i = 0; i < 40 && !grew; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (statSync(sessionFile).size > sizeBefore) {
        const body = readFileSync(sessionFile, 'utf8');
        // The coalesced wake text names both events ("2 events fired while you slept").
        if (body.includes('e2e:ready') && body.includes('2 events')) grew = true;
      }
    }
    const diag = grew ? '' : ` resume.log: ${existsSync(resumeLog) ? readFileSync(resumeLog, 'utf8').slice(0, 1500) : '(none)'}`;
    expect(grew, `the resumed claude session appended a turn carrying the coalesced wake text.${diag}`).toBe(true);
  }, 120_000);
});
