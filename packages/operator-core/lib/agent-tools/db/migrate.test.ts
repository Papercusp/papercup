/**
 * migrate.test.ts — db:migrate tool surface (EI-6962).
 *
 * Locks in the two behaviors this ticket touches:
 *  - the WITHHELD (PAPERCUSP_ALLOW_DB_MIGRATE unset) branch's fallback command
 *    still tells the caller to record schema_migrations in the same
 *    BEGIN/COMMIT (unchanged from before this fix — a human/agent applying by
 *    hand still needs the reminder);
 *  - the ENABLED branch now ACTUALLY records the schema_migrations row itself
 *    (the fix): the script piped to psql wraps the migration file's own `\i`
 *    in the SAME BEGIN/COMMIT as an INSERT into harness_shared.schema_migrations
 *    with the file's sha256 — not just the su_meta coordination-domain
 *    idempotency ledger (recordResourceAction), which is a separate concern.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/db/migrate.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WI-5217: explicit result/param types so `.mock.calls[...]` destructures and
// `.mockResolvedValue({...extra fields})` overrides typecheck against the real
// shapes (checkResourceAction's ResourceActionRecord has an optional fence_seq;
// openEscalation takes (identity, input) — an untyped `vi.fn(async () => ...)`
// infers a ZERO-arg mock, so `.mock.calls[0]` was a `[]` tuple with no index 0/1).
type ResourceActionResult = { applied: boolean; fence_seq?: number; applied_ts?: Date };
type EscalationInputLike = {
  severity: string;
  summary: string;
  body: string;
  meta?: { subjectSignature?: string };
};

const h = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readFileSync: vi.fn(() => 'CREATE TABLE foo (id int);\n'),
  checkResourceAction: vi.fn(async (): Promise<ResourceActionResult> => ({ applied: false })),
  recordResourceAction: vi.fn(async () => undefined),
  inWorkspaceTxn: vi.fn(async (_domain: unknown, _owner: unknown, fn: (tx: unknown) => unknown) => fn({})),
  openEscalation: vi.fn(async (_identity: unknown, _input: EscalationInputLike) => ({ msg_id: 'msg-esc-1', ts: '2026-07-17T00:00:00.000Z' })),
  // EI-18159491440495603: default behavior mirrors the original inline mock (acquire +
  // run the callback); individual tests override with mockImplementationOnce to throw
  // a transient connection error before eventually resolving.
  guardResource: vi.fn(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
    acquired: true,
    result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
  })),
}));

vi.mock('node:child_process', () => ({ spawnSync: h.spawnSync }));
vi.mock('node:fs', () => ({ readFileSync: h.readFileSync }));
vi.mock('../locks/identity', () => ({
  readIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', coordinationDomain: 'default' }),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', workspaceId: 'default' }),
}));
vi.mock('../coordination/escalations', () => ({ openEscalation: h.openEscalation }));
vi.mock('../../embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => 'postgres://admin-url/db',
}));
vi.mock('../locks/su-lock-store', () => ({
  checkResourceAction: h.checkResourceAction,
  recordResourceAction: h.recordResourceAction,
  getTxPool: () => ({}),
}));
vi.mock('../locks/in-workspace-txn', () => ({ inWorkspaceTxn: h.inWorkspaceTxn }));
vi.mock('../locks/resource-lock-guard', () => ({
  guardResource: h.guardResource,
}));

import migrateTool, {
  isLockTimeoutFailure,
  lockRetryBackoffMs,
  isTransientConnectionFailure,
  connectionRetryBackoffMs,
} from './migrate';

const CTX = { role: 'operator' } as never;
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);
const FILE = '/repo/libs/papercusp/libs/db/sql/999-fake.sql';

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DB_MIGRATE;

beforeEach(() => {
  h.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' });
  h.readFileSync.mockReset().mockReturnValue('CREATE TABLE foo (id int);\n');
  h.checkResourceAction.mockReset().mockResolvedValue({ applied: false });
  h.recordResourceAction.mockReset().mockResolvedValue(undefined);
  h.openEscalation.mockReset().mockResolvedValue({ msg_id: 'msg-esc-1', ts: '2026-07-17T00:00:00.000Z' });
  h.guardResource.mockReset().mockImplementation(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
    acquired: true,
    result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
  }));
  delete process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
});

/** A postgres-js-shaped transient connection error (see node_modules/postgres/src/errors.js's
 *  `connection()` factory) — `.code` is what isTransientConnectionFailure keys on. */
const connErr = (code: string) => Object.assign(new Error(`write ${code} 127.0.0.1:6432`), { code });

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
  else process.env.PAPERCUSP_ALLOW_DB_MIGRATE = ORIGINAL_ENV;
});

describe('db:migrate — dry run', () => {
  it('never touches psql / the lock when confirm is omitted', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE }, CTX));
    expect(out.dry_run).toBe(true);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });
});

describe('db:migrate — withheld (PAPERCUSP_ALLOW_DB_MIGRATE unset)', () => {
  it('drains but withholds the apply, and the fallback command still records schema_migrations by hand', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.applied).toBe(false);
    expect(out.drained).toBe(true);
    expect(out.fallback.command).toContain('INSERT INTO harness_shared.schema_migrations');
    expect(out.fallback.command).toContain('BEGIN;');
    expect(out.fallback.command).toContain('COMMIT;');
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('EI-13299: a routine withheld confirm (no escalate) never raises a coord:escalate', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.escalation).toEqual({ escalated: false });
    expect(h.openEscalation).not.toHaveBeenCalled();
  });

  it('EI-13299: escalate:true raises a blocker coord:escalate carrying the ready-to-run command, keyed per-file for coalescing', async () => {
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true, escalate: true }, CTX),
    );
    expect(out.applied).toBe(false);
    expect(out.escalation).toMatchObject({ escalated: true, msg_id: 'msg-esc-1', ts: '2026-07-17T00:00:00.000Z' });

    expect(h.openEscalation).toHaveBeenCalledTimes(1);
    const [identity, input] = h.openEscalation.mock.calls[0];
    expect(identity).toMatchObject({ ownerId: 'su-test' });
    expect(input.severity).toBe('blocker');
    expect(input.summary).toContain('999-fake.sql');
    expect(input.body).toContain('BEGIN;');
    expect(input.body).toContain('INSERT INTO harness_shared.schema_migrations');
    expect(input.meta?.subjectSignature).toBe('db-migrate-withheld:999-fake.sql');
  });

  it('EI-13299: a failed escalation is fail-soft — the withheld response still succeeds, with the error surfaced', async () => {
    h.openEscalation.mockRejectedValueOnce(new Error('coord log unavailable'));
    const out = parse(
      await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true, escalate: true }, CTX),
    );
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.escalation.escalated).toBe(false);
    expect(out.escalation.error).toContain('coord log unavailable');
  });
});

describe('db:migrate — enabled (PAPERCUSP_ALLOW_DB_MIGRATE=1)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });

  it('EI-6962: wraps the file in the SAME BEGIN/COMMIT as a schema_migrations INSERT, fed to psql via stdin (not -f)', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.schema_migrations_recorded).toBe(true);
    expect(typeof out.sha256).toBe('string');
    expect(out.sha256).toHaveLength(64); // sha256 hex digest length

    expect(h.spawnSync).toHaveBeenCalledTimes(1);
    const [cmd, cmdArgs, opts] = h.spawnSync.mock.calls[0];
    expect(cmd).toBe('psql');
    expect(cmdArgs).not.toContain('-f'); // no longer runs the file directly —
    expect(cmdArgs).not.toContain(FILE); // it's `\i`-included inside the piped script
    const script = (opts as { input: string }).input;
    expect(script).toContain('BEGIN;');
    expect(script).toContain(`\\i ${FILE}`);
    expect(script).toContain('INSERT INTO harness_shared.schema_migrations (filename, sha256) VALUES');
    expect(script).toContain('999-fake.sql');
    expect(script).toContain('COMMIT;');
    // The INSERT must be INSIDE the same transaction as the \i, not appended after COMMIT.
    expect(script.indexOf('BEGIN;')).toBeLessThan(script.indexOf('\\i'));
    expect(script.indexOf('\\i')).toBeLessThan(script.indexOf('INSERT INTO'));
    expect(script.indexOf('INSERT INTO')).toBeLessThan(script.lastIndexOf('COMMIT;'));

    // The su_meta coordination-domain idempotency ledger is STILL recorded —
    // a separate, additive concern from the schema_migrations row above.
    expect(h.recordResourceAction).toHaveBeenCalledTimes(1);
  });

  it('a failed psql apply is reported and never records either ledger', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: syntax error' });
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out.exit_code).toBe(1);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });

  it('an already-applied file (su_meta idempotency ledger) short-circuits without touching psql', async () => {
    h.checkResourceAction.mockResolvedValue({ applied: true, fence_seq: 3 });
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.already_applied).toBe(true);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });
});

describe('db:migrate — lock-timeout retry on a hot table (EI-9417)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const LOCK_TIMEOUT_STDERR = 'ERROR:  canceling statement due to lock timeout';

  it('sets an explicit lock_timeout so a stuck attempt fails fast instead of hanging indefinitely', async () => {
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(1);
    const script = (h.spawnSync.mock.calls[0][2] as { input: string }).input;
    expect(script).toContain("SET LOCAL lock_timeout = '10s';");
    expect(script.indexOf('SET LOCAL lock_timeout')).toBeLessThan(script.indexOf('\\i'));
  });

  it('retries a lock-timeout cancel with backoff and succeeds once contention clears', async () => {
    vi.useFakeTimers();
    h.spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(4000); // backoff after attempt 2
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.attempts).toBe(3);
    expect(h.spawnSync).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-lock-timeout failure — fails fast on a single attempt', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'ERROR: syntax error' });
    const out = parse(await (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX));
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.lock_timeout_retries_exhausted).toBe(false);
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries after 5 repeated lock-timeout cancels and reports lock_timeout_retries_exhausted', async () => {
    vi.useFakeTimers();
    h.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: LOCK_TIMEOUT_STDERR });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    const out = parse(await promise);
    expect(out.ok).toBe(false);
    expect(out.attempts).toBe(5);
    expect(out.lock_timeout_retries_exhausted).toBe(true);
    expect(h.spawnSync).toHaveBeenCalledTimes(5);
    expect(h.recordResourceAction).not.toHaveBeenCalled();
  });
});

describe('isLockTimeoutFailure / lockRetryBackoffMs — pure helpers (EI-9417)', () => {
  it("matches PG's own lock-timeout cancel message, case-insensitively", () => {
    expect(isLockTimeoutFailure('ERROR:  canceling statement due to lock timeout')).toBe(true);
    expect(isLockTimeoutFailure('error: CANCELING STATEMENT DUE TO LOCK TIMEOUT')).toBe(true);
  });

  it('does not match an unrelated failure (including the similarly-worded statement_timeout cancel)', () => {
    expect(isLockTimeoutFailure('ERROR: syntax error at or near "FOO"')).toBe(false);
    expect(isLockTimeoutFailure('ERROR: canceling statement due to statement timeout')).toBe(false);
    expect(isLockTimeoutFailure('')).toBe(false);
  });

  it('backs off exponentially (2s, 4s, 8s, 16s), capped at 30s', () => {
    expect(lockRetryBackoffMs(1)).toBe(2000);
    expect(lockRetryBackoffMs(2)).toBe(4000);
    expect(lockRetryBackoffMs(3)).toBe(8000);
    expect(lockRetryBackoffMs(4)).toBe(16000);
    expect(lockRetryBackoffMs(5)).toBe(30000); // would be 32000 uncapped
  });
});

describe('db:migrate — connection-drop retry around guardResource (EI-18159491440495603)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DB_MIGRATE = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient CONNECTION_CLOSED throw and succeeds once the connection recovers', async () => {
    vi.useFakeTimers();
    h.guardResource
      .mockImplementationOnce(async () => {
        throw connErr('CONNECTION_CLOSED');
      })
      .mockImplementationOnce(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
        acquired: true,
        result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
      }));
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
    await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 1
    const out = parse(await promise);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(h.guardResource).toHaveBeenCalledTimes(2);
  });

  it('retries CONNECTION_DESTROYED and CONNECT_TIMEOUT the same way (all three postgres-js connection-layer codes)', async () => {
    for (const code of ['CONNECTION_DESTROYED', 'CONNECT_TIMEOUT']) {
      h.guardResource.mockReset();
      vi.useFakeTimers();
      h.guardResource
        .mockImplementationOnce(async () => {
          throw connErr(code);
        })
        .mockImplementationOnce(async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
          acquired: true,
          result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
        }));
      const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX);
      await vi.advanceTimersByTimeAsync(1000);
      const out = parse(await promise);
      expect(out.applied).toBe(true);
      vi.useRealTimers();
    }
  });

  it('does NOT retry a genuine (non-connection-layer) throw — fails fast, unretried', async () => {
    h.guardResource.mockImplementation(async () => {
      throw new Error('boom: something unrelated broke');
    });
    await expect(
      (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX),
    ).rejects.toThrow('boom: something unrelated broke');
    expect(h.guardResource).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries after 3 repeated CONNECTION_CLOSED throws and rethrows the last one', async () => {
    vi.useFakeTimers();
    h.guardResource.mockImplementation(async () => {
      throw connErr('CONNECTION_CLOSED');
    });
    const promise = (migrateTool as never as { handler: Function }).handler({ file: FILE, confirm: true }, CTX)
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(2000); // backoff after attempt 2
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('CONNECTION_CLOSED');
    expect(h.guardResource).toHaveBeenCalledTimes(3);
  });
});

describe('isTransientConnectionFailure / connectionRetryBackoffMs — pure helpers (EI-18159491440495603)', () => {
  it("matches postgres-js's own connection-layer error codes", () => {
    expect(isTransientConnectionFailure(connErr('CONNECTION_CLOSED'))).toBe(true);
    expect(isTransientConnectionFailure(connErr('CONNECTION_DESTROYED'))).toBe(true);
    expect(isTransientConnectionFailure(connErr('CONNECT_TIMEOUT'))).toBe(true);
  });

  it('does not match a genuine SQL/logic error (no matching .code) or a non-Error value', () => {
    expect(isTransientConnectionFailure(new Error('plain error, no code'))).toBe(false);
    expect(isTransientConnectionFailure(Object.assign(new Error('x'), { code: 'SOME_OTHER_CODE' }))).toBe(false);
    expect(isTransientConnectionFailure('not an error')).toBe(false);
    expect(isTransientConnectionFailure(null)).toBe(false);
    expect(isTransientConnectionFailure(undefined)).toBe(false);
  });

  it('backs off exponentially (1s, 2s, 4s), capped at 8s', () => {
    expect(connectionRetryBackoffMs(1)).toBe(1000);
    expect(connectionRetryBackoffMs(2)).toBe(2000);
    expect(connectionRetryBackoffMs(3)).toBe(4000);
    expect(connectionRetryBackoffMs(4)).toBe(8000); // would be 8000 anyway, but locks in the cap
    expect(connectionRetryBackoffMs(5)).toBe(8000); // would be 16000 uncapped
  });
});
