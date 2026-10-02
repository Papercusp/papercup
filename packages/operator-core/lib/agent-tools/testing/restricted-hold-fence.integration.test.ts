/**
 * WI-10005634 acceptance falsifier — an UNRESTRICTED session runs a test file a RESTRICTED session
 * wrote inside its disclosure window, and the run is refused. Real Postgres (the disclosure
 * ledger + edit-attribution ledger), a real git checkout, and the PRODUCTION census reader
 * (`restrictedHoldingsFor` = git-sync's two restricted halves), so "held from commit" and
 * "refused from execution" are proven to read the same thing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { restrictedHoldRefusal } = await import('./restricted-hold-fence');
type OrgTestDb = import('../../../test/_org-test-db').OrgTestDb;

const WS = 'restricted-hold-fence-test';
const RESTRICTED = 'su-fence-restricted';
const UNRESTRICTED = 'su-fence-unrestricted';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;
let root: string;

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

async function ledger(agent: string, file: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.edit_attribution_ledger (repo_root, file, agent_id, work_item_id, ts)
    VALUES (${root}, ${file}, ${agent}, ${null}, now())`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  holder.sql = sql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'restricted-hold-fence-' + Date.now()}, 'restricted hold fence')
    RETURNING id`;
  userId = user.id;

  root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-hold-fence-int-')));
  git('init', '-q');
  git('config', 'user.email', 'fence@example.com');
  git('config', 'user.name', 'fence');
  put('src/base.ts', 'export const base = 1;\n');
  put('tests/base.test.ts', "import { base } from '../src/base';\nexport const value = base;\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  // The restricted session's window opens a minute ago, so every write below falls inside it.
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via, delivered_at)
    VALUES (${WS}, ${userId}, ${RESTRICTED}, gen_random_uuid(), 'email', 'participants',
            ${['alice@example.com']}::text[], 'personal:search', now() - interval '1 minute')`;

  // 1. A test file the restricted session wrote with a native (ledgered) edit.
  put('tests/planted.test.ts', "import { base } from '../src/base';\nexport const value = base;\n");
  await ledger(RESTRICTED, 'tests/planted.test.ts');

  // 2. A source written inside the window with NO ledger row (e.g. a shell redirect), imported by
  //    a test an unrestricted session wrote natively — only the window half of the census sees it.
  put('src/unattributed.ts', 'export const planted = 2;\n');
  put('tests/uses-unattributed.test.ts', "import { planted } from '../src/unattributed';\nexport const value = planted;\n");
  await ledger(UNRESTRICTED, 'tests/uses-unattributed.test.ts');
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  holder.sql = null;
  await org?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('restricted-write fence on the production census (real Postgres + git)', () => {
  it('refuses to run a test file the restricted session wrote inside its window', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/planted.test.ts']);
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toContain('tests/planted.test.ts is itself a held restricted write');
  });

  it('refuses a test whose closure imports an unattributed write made inside the window', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/uses-unattributed.test.ts']);
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toMatch(/imports .*src\/unattributed\.ts/);
  });

  it('admits an unrelated committed test while the hold stands (calibration)', async () => {
    expect(await restrictedHoldRefusal(root, ['tests/base.test.ts'])).toBeNull();
  });

  it('admits both once the disclosure is released', async () => {
    await sql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'fixture-release'
       WHERE workspace_id = ${WS} AND agent_owner_id = ${RESTRICTED}`;
    expect(await restrictedHoldRefusal(root, ['tests/planted.test.ts'])).toBeNull();
    expect(await restrictedHoldRefusal(root, ['tests/uses-unattributed.test.ts'])).toBeNull();
  });
});
