/**
 * P-007 — the property under test is DISCRIMINATION, not reporting.
 *
 * Every one of these states delivers zero rows. The item exists because they
 * are indistinguishable from outside, so each test pins the CODE and its
 * `fault` verdict rather than merely asserting that a row came back.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  hasProducerFault,
  readAppProducerStatus,
  type AppProducerStatus,
  type AppProducerStatusDeps,
} from './status';
import type { AppOwnerMapping } from './owner-mapping';

const SQL = {} as unknown as Sql;
const WORKSPACE = 'papercusp-workspace';
const USER = '22222222-2222-4222-8222-222222222222';

function mapping(app: 'email' | 'calendar', ownerId = 'owner-abc'): AppOwnerMapping {
  return {
    workspaceId: WORKSPACE,
    userId: USER,
    app,
    ownerId,
    note: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const NO_PUSH = { delivered: 0, failed: 0, pending: 0, lastError: null, lastErrorAt: null, lastDeliveredAt: null };

/** Everything stubbed to the healthy answer; each test overrides what it is about. */
function deps(over: Partial<AppProducerStatusDeps> = {}): AppProducerStatusDeps {
  return {
    listMappings: vi.fn(async () => [mapping('email'), mapping('calendar')]),
    fetchCursor: vi.fn(async () => ({ reachable: true, cursor: '2026-08-30T10:00:00.000Z|abc' })),
    readEnv: () => 'http://127.0.0.1:9999',
    readRollup: vi.fn(async () => ({ ...NO_PUSH })),
    countPending: vi.fn(async () => 0),
    ...over,
  };
}

const forApp = (rows: AppProducerStatus[], app: string) => rows.find((r) => r.app === app)!;

describe('P-007 — a silently-idle producer is reported, not omitted', () => {
  it('reports EVERY app even when nothing is mapped, rather than returning an empty list', async () => {
    // THE CENTRAL CASE. Enumerating mappings would return [] here, which reads
    // as "no problems" and is exactly today's broken state.
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      listMappings: vi.fn(async () => []),
    }));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.app).sort()).toEqual(['calendar', 'email']);
    for (const r of rows) {
      expect(r.health).toBe('not-configured');
      expect(r.configured).toBe(false);
      // Switched OFF is not a fault. That distinction is the whole point.
      expect(r.fault).toBe(false);
      expect(r.detail).toContain('delivery is OFF');
    }
    expect(hasProducerFault(rows)).toBe(false);
  });

  it('an UNREADABLE mapping table is a fault, not an unconfigured producer', async () => {
    // The live shape of this today: migration 1029 unapplied, so the table does
    // not exist. "No mappings" and "cannot read mappings" both yield zero rows
    // from the query and mean opposite things.
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      listMappings: vi.fn(async () => { throw new Error('relation "harness_shared.app_owner_mappings" does not exist'); }),
    }));

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.health).toBe('misconfigured');
      expect(r.fault).toBe(true);
      expect(r.detail).toContain('does not exist');
    }
    expect(hasProducerFault(rows)).toBe(true);
  });

  it('a mapping with no <APP>_APP_URL is MISCONFIGURED, and is not probed', async () => {
    // Delivery is switched on and has nowhere to send. Probing first would fail
    // for this reason and report `unreachable`, naming the wrong cause.
    const fetchCursor = vi.fn(async () => ({ reachable: true, cursor: null }));
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      readEnv: () => undefined,
      fetchCursor,
    }));

    const email = forApp(rows, 'email');
    expect(email.health).toBe('misconfigured');
    expect(email.fault).toBe(true);
    expect(email.configured).toBe(true);
    expect(email.baseUrlConfigured).toBe(false);
    expect(email.detail).toContain('EMAIL_APP_URL');
    expect(fetchCursor).not.toHaveBeenCalled();
  });

  it('names the app-specific env var, so the fix is unambiguous', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({ readEnv: () => undefined }));
    expect(forApp(rows, 'email').detail).toContain('EMAIL_APP_URL');
    expect(forApp(rows, 'calendar').detail).toContain('CALENDAR_APP_URL');
  });

  it('an app that does not answer its cursor probe is UNREACHABLE, with the cause', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      fetchCursor: vi.fn(async () => ({ reachable: false, cursor: null, error: 'cursor_http_502' })),
    }));

    const email = forApp(rows, 'email');
    expect(email.health).toBe('unreachable');
    expect(email.fault).toBe(true);
    expect(email.appReachable).toBe(false);
    expect(email.detail).toContain('cursor_http_502');
  });

  it('surfaces the last push error verbatim, not just a failure count', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      readRollup: vi.fn(async () => ({
        ...NO_PUSH,
        delivered: 12,
        failed: 3,
        lastError: 'app_base_url_missing:email — set EMAIL_APP_URL',
        lastErrorAt: '2026-08-30T10:00:00.000Z',
      })),
    }));

    const email = forApp(rows, 'email');
    expect(email.health).toBe('failing');
    expect(email.fault).toBe(true);
    expect(email.detail).toContain('app_base_url_missing');
    expect(email.push.delivered).toBe(12);
  });

  it('FAILING outranks BEHIND — the backlog is usually the consequence, not the cause', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      readRollup: vi.fn(async () => ({ ...NO_PUSH, failed: 2, lastError: 'boom' })),
      countPending: vi.fn(async () => 400),
    }));
    expect(forApp(rows, 'email').health).toBe('failing');
  });

  it('rows sitting after the app cursor read as BEHIND, and that is not a fault', async () => {
    // Reconcile is expected to drain these, so a backlog alone is normal
    // operation — it becomes interesting only if it does not shrink.
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      countPending: vi.fn(async () => 685),
    }));

    const email = forApp(rows, 'email');
    expect(email.health).toBe('behind');
    expect(email.fault).toBe(false);
    expect(email.pendingRows).toBe(685);
    expect(email.detail).toContain('685');
  });

  it('configured, reachable and drained reads OK', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps());
    expect(rows.every((r) => r.health === 'ok')).toBe(true);
    expect(hasProducerFault(rows)).toBe(false);
  });

  it('never returns the base URL itself, only whether one is set', async () => {
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      readEnv: () => 'https://secret-host.internal:8443/hook',
    }));
    expect(JSON.stringify(rows)).not.toContain('secret-host.internal');
    expect(rows.every((r) => r.baseUrlConfigured)).toBe(true);
  });

  it('a ledger read failure does not mask the configuration answer', async () => {
    // The ledger is the least actionable of the three inputs; losing it must
    // not cost the caller the two that name a repair.
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      readRollup: vi.fn(async () => { throw new Error('ledger down'); }),
      readEnv: () => undefined,
    }));
    expect(forApp(rows, 'email').health).toBe('misconfigured');
    expect(forApp(rows, 'email').push.failed).toBe(0);
  });

  it('probeApps:false answers from configuration and ledger alone, touching no network', async () => {
    const fetchCursor = vi.fn(async () => ({ reachable: true, cursor: null }));
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({ probeApps: false, fetchCursor }));
    expect(fetchCursor).not.toHaveBeenCalled();
    expect(rows.every((r) => r.health === 'ok')).toBe(true);
  });

  it('reports each mapped user separately — one broken tenant must not hide behind a healthy one', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const rows = await readAppProducerStatus(SQL, WORKSPACE, deps({
      listMappings: vi.fn(async () => [
        mapping('email', 'owner-a'),
        { ...mapping('email', 'owner-b'), userId: other },
      ]),
      fetchCursor: vi.fn(async (_app: unknown, ownerId: string) =>
        ownerId === 'owner-b'
          ? { reachable: false, cursor: null, error: 'ECONNREFUSED' }
          : { reachable: true, cursor: null }),
    }));

    const emails = rows.filter((r) => r.app === 'email');
    expect(emails).toHaveLength(2);
    expect(emails.find((r) => r.ownerId === 'owner-a')!.health).toBe('ok');
    expect(emails.find((r) => r.ownerId === 'owner-b')!.health).toBe('unreachable');
    expect(hasProducerFault(rows)).toBe(true);
  });
});
