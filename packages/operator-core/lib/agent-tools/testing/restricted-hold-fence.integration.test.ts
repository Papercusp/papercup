/**
 * WI-10005634 acceptance falsifier — an UNRESTRICTED session runs a test file a RESTRICTED session
 * wrote inside its disclosure window, and the run is refused. Real Postgres (the disclosure
 * ledger + edit-attribution ledger), a real git checkout, and the PRODUCTION census reader
 * (`restrictedHoldingsFor` = git-sync's two restricted halves), so "held from commit" and
 * "refused from execution" are proven to read the same thing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  runRestrictedHoldPreflight,
} from '../../../../../scripts/lib/restricted-hold-preflight.mjs';

/** The real papercusp checkout this suite lives in (the raw router's own REPO_ROOT). */
const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'));
/** A real repo test file the raw-router falsifier marks as a restricted write. */
const HELD_REPO_TEST = 'packages/operator-core/lib/__tests__/restricted-hold-preflight.test.ts';

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

/**
 * An UNRESTRICTED caller's env pointed at this suite's database. The vitest markers and the
 * testing:run admission marker are removed: either would (correctly) skip the router's preflight,
 * and the point of the falsifier is a top-level raw invocation.
 */
function routerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_ADMIN_DATABASE_URL: org.adminDsn,
    DATABASE_URL: org.adminDsn,
    HARNESS_DATABASE_URL: org.appDsn,
    PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
  };
  for (const key of Object.keys(env)) if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
  delete env[RESTRICTED_HOLD_PREFLIGHT_ENV];
  return env;
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

  // 3. A REAL repo test file, ledgered to the restricted session, for the raw-router falsifier.
  await sql`
    INSERT INTO harness_shared.edit_attribution_ledger (repo_root, file, agent_id, work_item_id, ts)
    VALUES (${REPO}, ${HELD_REPO_TEST}, ${RESTRICTED}, ${null}, now())`;
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

  // WI-10005713 acceptance falsifier: the RAW router (`npm run test:file` = scripts/test-files.mjs),
  // spawned as a real unrestricted process, refuses a held restricted write BEFORE any test group
  // launches. The held file is a real repo test, ledgered to the restricted session in this
  // throwaway database, which the router's census child reaches through the env DSNs.
  it('the raw test:file router refuses a held restricted write before vitest starts', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/test-files.mjs'), HELD_REPO_TEST], {
      cwd: REPO,
      env: routerEnv(),
      encoding: 'utf8',
      timeout: 110_000,
    });
    expect(result.stderr).toContain('TEST_FILE_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none');
    expect(result.status).toBe(2); // TEST_FILE_EXIT_NOT_MEASURED
    // Every test group prints `ROUTE cwd=` before it starts a test process; none may appear.
    expect(result.stdout).not.toContain('ROUTE cwd=');
  }, 120_000);

  it('admits both once the disclosure is released', async () => {
    await sql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'fixture-release'
       WHERE workspace_id = ${WS} AND agent_owner_id = ${RESTRICTED}`;
    expect(await restrictedHoldRefusal(root, ['tests/planted.test.ts'])).toBeNull();
    expect(await restrictedHoldRefusal(root, ['tests/uses-unattributed.test.ts'])).toBeNull();
  });

  // Calibration for the router falsifier: the SAME census child, same env, admits once released —
  // so the refusal above was the hold, not a broken spawn, tsx load, or DSN.
  it('the raw-router preflight admits the same repo test once the disclosure is released', () => {
    expect(runRestrictedHoldPreflight({ repoRoot: REPO, files: [join(REPO, HELD_REPO_TEST)], env: routerEnv() })).toEqual({
      verdict: 'admit',
    });
  }, 120_000);
});
