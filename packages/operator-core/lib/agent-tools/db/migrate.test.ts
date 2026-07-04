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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  readFileSync: vi.fn(() => 'CREATE TABLE foo (id int);\n'),
  checkResourceAction: vi.fn(async () => ({ applied: false })),
  recordResourceAction: vi.fn(async () => undefined),
  inWorkspaceTxn: vi.fn(async (_domain: unknown, _owner: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('node:child_process', () => ({ spawnSync: h.spawnSync }));
vi.mock('node:fs', () => ({ readFileSync: h.readFileSync }));
vi.mock('../locks/identity', () => ({
  readIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', coordinationDomain: 'default' }),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-test', ownerLabel: 'su-test', workspaceId: 'default' }),
}));
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
  guardResource: async (_spec: unknown, run: (fence: unknown) => Promise<unknown>) => ({
    acquired: true,
    result: await run({ seq: 7, assertCurrent: async () => ({ current: true }) }),
  }),
}));

import migrateTool from './migrate';

const CTX = { role: 'operator' } as never;
const parse = (res: { content: Array<{ text: string }> }) => JSON.parse(res.content[0].text);
const FILE = '/repo/libs/papercusp/libs/db/sql/999-fake.sql';

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DB_MIGRATE;

beforeEach(() => {
  h.spawnSync.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' });
  h.readFileSync.mockReset().mockReturnValue('CREATE TABLE foo (id int);\n');
  h.checkResourceAction.mockReset().mockResolvedValue({ applied: false });
  h.recordResourceAction.mockReset().mockResolvedValue(undefined);
  delete process.env.PAPERCUSP_ALLOW_DB_MIGRATE;
});

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
