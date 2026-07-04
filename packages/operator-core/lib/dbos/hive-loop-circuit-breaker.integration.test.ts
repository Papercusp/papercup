/**
 * hive-loop-circuit-breaker.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-003: the autoloop circuit-breaker LIFECYCLE driven through the LIVE fire
 * path (routineFireWorkflow → system:blueprint-run → defaultFire → the real
 * recordFire writes), not unit calls. autoloop-state.integration.test.ts already
 * proves recordFire row semantics; THIS proves the loop-level behavior:
 *
 *   1. eight consecutive decider-fire failures (the stub operator answers the
 *      invoke route with HTTP 500) accumulate consecutive_errors 1..8 — each
 *      re-fire admitted only after its exponential backoff window;
 *   2. at the threshold the circuit OPENS: an immediate re-fire is WITHHELD
 *      (no invoke-route hit, counter frozen) and the gate reports
 *      reason 'circuit-open' with a ~cap-window retry (the degraded probe
 *      cadence — one half-open probe per cap window, ~hourly at defaults);
 *   3. after a cap window a half-open probe IS admitted; while the operator
 *      still fails, the circuit stays open (counter 9, still circuit-open);
 *   4. ONE successful fire (stub flips to 200) closes the circuit:
 *      consecutive_errors resets to 0, last_status 'ok', and the gate allows
 *      immediately again.
 *
 * Time compression: PAPERCUSP_AUTOLOOP_{BACKOFF_BASE_SEC=5, BACKOFF_CAP_SEC=40,
 * CIRCUIT_THRESHOLD=8} + honest time-travel — between fires the test backdates
 * `last_fired_at` in PG rather than sleeping, so the REAL gate math runs against
 * real timestamps with zero wall-clock waits.
 *
 * Setup mirrors hive-loop-e2e.integration.test.ts: real DBOS + migrated
 * throwaway PG, env-routed getOrgPg, PAPERCUSP_OPERATOR_BASE pinned at the stub
 * server so the decider fire NEVER reaches a real operator host.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { teardownTestPg } from '@papercusp/test-config';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-circuit';
const SLUG = 'circuit';
const RID = 'rt-circuit-0';
const ROLE = 'director'; // the coding blueprint's decider — the role the fire gates on

process.env.PAPERCUSP_WORKSPACE_ID = WS;
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB = '0 0 0 1 1 *';
process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'none';
// Compressed breaker constants (read at call time by autoloop.ts).
process.env.PAPERCUSP_AUTOLOOP_BACKOFF_BASE_SEC = '5';
process.env.PAPERCUSP_AUTOLOOP_BACKOFF_CAP_SEC = '40';
process.env.PAPERCUSP_AUTOLOOP_CIRCUIT_THRESHOLD = '8';

let DBOS: typeof DBOSType;
let db: OrgTestDb;
let server: Server;
let respondOk = false;
const invokeHits: string[] = [];

let routineFireWorkflow: typeof import('./routines-workflow').routineFireWorkflow;
let checkFireGate: typeof import('../autoloop').checkFireGate;

beforeAll(async () => {
  db = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.DATABASE_URL = db.adminDsn;

  // Stub operator host: the decider fire's invoke route. 500 = a failing
  // decider dispatch; 200 = a successful one. Recorded for withheld-assertions.
  server = createServer((req, res) => {
    invokeHits.push(req.url ?? '');
    res.statusCode = respondOk ? 200 : 500;
    res.end(respondOk ? 'ok' : 'boom');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  process.env.PAPERCUSP_OPERATOR_BASE = `http://127.0.0.1:${port}`;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  const routines = await import('./routines-workflow');
  routineFireWorkflow = routines.routineFireWorkflow;
  ({ checkFireGate } = await import('../autoloop'));

  await DBOS.launch();

  await db.adminSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, active, next_fire_at, workspace_id)
    VALUES
      (${RID}, ${SLUG}, 'bp-schedule-0', 'cron', ${'{"cron":"*/30 * * * * *"}'}::text::jsonb,
       'system:blueprint-run', null, true, now() + interval '1 year', ${WS})`;
}, 300_000);

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  await new Promise<void>((r) => server?.close(() => r()));
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const fire = () => routineFireWorkflow(RID, WS, SLUG, 'system:blueprint-run', { cron: '*/30 * * * * *' }, null);

async function readState(): Promise<{ errors: number; status: string | null } | null> {
  const rows = await db.adminSql`
    SELECT consecutive_errors, last_status FROM harness_shared.autoloop_state
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND role = ${ROLE}`;
  return rows.length ? { errors: Number(rows[0].consecutive_errors), status: rows[0].last_status } : null;
}

/** Poll until consecutive_errors reaches `n` (the fire's recordFire is async fire-and-forget). */
async function awaitErrors(n: number, deadlineMs = 10_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const s = await readState();
    if (s?.errors === n) return;
    if (Date.now() > deadline) throw new Error(`consecutive_errors never reached ${n} (now ${s?.errors})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Honest time-travel: age the fire-state row instead of sleeping out a backoff. */
async function backdate(seconds: number): Promise<void> {
  await db.adminSql`
    UPDATE harness_shared.autoloop_state
       SET last_fired_at = last_fired_at - make_interval(secs => ${seconds})
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND role = ${ROLE}`;
}

describe('autoloop circuit-breaker lifecycle (P-003)', () => {
  it('8 failures open the circuit; probes degrade to ~one per cap window; one success closes it', async () => {
    // The WITHHELD console.warn is the gate's own observable signal — capture
    // it so Phase 2 can ASSERT on it (and keep vitest-fail-on-console quiet).
    // Installed INSIDE the test: fail-on-console re-patches console per-test in
    // its own beforeEach, so a module-scope spy would be overwritten.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // ── Phase 1: accumulate 8 consecutive fire errors through the live path.
    for (let i = 1; i <= 8; i++) {
      if (i > 1) await backdate(45); // > any backoff window → the re-fire is admitted
      await fire();
      await awaitErrors(i);
    }
    let s = await readState();
    expect(s?.errors).toBe(8);
    expect(s?.status).toMatch(/error: HTTP 500/);
    expect(invokeHits.length).toBe(8);
    // The fires hit the REAL decider invoke route for this harness.
    expect(invokeHits[0]).toContain(`/api/harness/${SLUG}/invoke?role=${ROLE}`);

    // ── Phase 2: circuit OPEN. The gate reports the degraded probe cadence —
    // the next attempt is a half-open probe a full CAP window away (~hourly at
    // production defaults; 40s compressed here).
    const open = await checkFireGate(SLUG, ROLE);
    expect(open.allow).toBe(false);
    expect(open.reason).toBe('circuit-open');
    expect(open.consecutiveErrors).toBe(8);
    expect(open.retryAfterSec).toBeGreaterThan(35);
    expect(open.retryAfterSec).toBeLessThanOrEqual(40);

    // A fire attempt inside the open window is WITHHELD: no invoke-route hit,
    // counter frozen, and the handler logged the withholding.
    warnSpy.mockClear();
    await fire();
    await new Promise((r) => setTimeout(r, 500)); // give a (wrong) fire time to surface
    expect(invokeHits.length).toBe(8);
    expect((await readState())?.errors).toBe(8);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('WITHHELD'))).toBe(true);

    // ── Phase 3: after a cap window, ONE half-open probe is admitted. The
    // operator still fails → counter grows, circuit stays open.
    await backdate(41);
    const probeGate = await checkFireGate(SLUG, ROLE);
    expect(probeGate.allow).toBe(true); // the half-open probe
    await fire();
    await awaitErrors(9);
    const stillOpen = await checkFireGate(SLUG, ROLE);
    expect(stillOpen.allow).toBe(false);
    expect(stillOpen.reason).toBe('circuit-open');
    expect(invokeHits.length).toBe(9);

    // ── Phase 4: one SUCCESS closes the circuit and resets the counter.
    respondOk = true;
    await backdate(41);
    await fire();
    const deadline = Date.now() + 10_000;
    for (;;) {
      s = await readState();
      if (s?.errors === 0 && s?.status === 'ok') break;
      if (Date.now() > deadline) throw new Error(`circuit never closed (errors=${s?.errors}, status=${s?.status})`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(invokeHits.length).toBe(10);

    // Closed circuit: the very next fire is admitted with no backoff at all.
    const closed = await checkFireGate(SLUG, ROLE);
    expect(closed).toMatchObject({ allow: true, consecutiveErrors: 0 });
    await fire();
    const finalDeadline = Date.now() + 10_000;
    while (invokeHits.length < 11) {
      if (Date.now() > finalDeadline) throw new Error('closed-circuit fire never reached the invoke route');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await readState())?.errors).toBe(0);
  }, 240_000);
});
