/**
 * Hermetic-runner SMOKE (P-001 end-to-end validation, zero LLM spend).
 *
 * Boots a dedicated headless gym-operator against a freshly-provisioned gym DB and
 * runs ONE fake-agent pipeline to terminal, then captures the trace + diff — proving
 * the runner→capture plumbing without a model. Run on demand:
 *   cd apps/operator && set -a; . ./.env.local; set +a; npx tsx lib/gym/smoke.ts
 *
 * Careful by construction: separate DB + free port + separate workspace (never the
 * live :3070), and teardown (kill operator, drop DB, rm scratch) runs in `finally`.
 * Bounded: the fake agent is instant, so the whole run is seconds.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
// Import the PG-container helpers DIRECTLY (the package index pulls in msw→vitest,
// which can't load outside a vitest runner; pg-container.ts only needs testcontainers).
// eslint-disable-next-line import/no-relative-packages
import { getTestPg, teardownTestPg } from '../../../../libs/test-config/src/pg-container.ts';
import { provisionGymDatabase } from './gym-db-init';
import { buildGymOperatorBootSpec } from './boot-spec';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-agent.mjs');
const PORT = Number(process.env.GYM_SMOKE_PORT ?? 3971);
const HEX = randomBytes(4).toString('hex');
const DB_NAME = `papercusp_gym_smoke_${HEX}`;
const SLUG = `gymsmoke${HEX}`; // hyphen-free → valid unquoted PG schema harness_<slug>
const WS = 'gym-smoke-ws';
const FEATURE = 'F-GYM-SMOKE';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[smoke] ${m}\n`);
/** Mask passwords in any postgres DSN so the report never leaks a secret. */
const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true; // any HTTP response = server listening
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  return false;
}

async function main(): Promise<void> {
  // The gym needs a PG where it can CREATE EXTENSION (superuser) — the dev box's
  // harness_admin is not superuser, so the smoke provisions its gym DB in a dedicated
  // superuser testcontainer (the ship target uses embedded-pg's superuser). This also
  // keeps the smoke fully self-contained: zero dev-box PG involvement.
  const maintenanceUri = await getTestPg();

  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-smoke-'));
  // basename(cloneDir) MUST equal the slug: invoke-once derives the harness slug from
  // basename(PROJECT_DIR) when HARNESS_SLUG doesn't take, and the slug picks the PG
  // search_path schema (harness_<slug>). The real gym runner already does this
  // (cloneDirName === harnessSlug); the smoke must too.
  const cloneDir = join(scratch, SLUG);
  // Persist OUTSIDE scratch (which teardown rm's) so the operator log can be grepped
  // afterward to diagnose the worker's PG connection / search_path.
  const opLogPath = join(tmpdir(), `gym-smoke-op-${HEX}.log`);
  let gymUri = '';
  let ok = false;
  const report: Record<string, unknown> = {};

  try {
    // 1. Provision the dedicated gym DB.
    log(`provisioning gym DB ${DB_NAME} …`);
    ({ databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri, dbName: DB_NAME }));

    // 2. Throwaway substrate repo (a tiny git repo + .harness/config.json).
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(cloneDir, 'README.md'), '# gym smoke substrate\n');
    mkdirSync(join(cloneDir, '.harness'), { recursive: true });
    // chunk-loop OFF so the fake worker runs as a single invoke().
    writeFileSync(join(cloneDir, '.harness', 'config.json'), JSON.stringify({ worktrees: { enabled: false } }));
    execFileSync('git', ['init', '-q'], { cwd: cloneDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: cloneDir });
    execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', 'seed'], { cwd: cloneDir });
    const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    report.baseCommit = baseCommit;

    // 3. Boot the headless gym-operator.
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      agentCmd: `node ${FAKE_AGENT}`,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (log → ${opLogPath}) …`);
    operator = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...spec.env,
        PAPERCUSP_FLEET_SANDBOX: '0',
        PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0',
        NODE_ENV: 'production',
        // Autoloop OFF — the smoke starts the pipeline EXPLICITLY (deterministic) via
        // the admin route + superuser token (the real gym wiring), not the 30s tick.
        PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none',
      },
      stdio: ['ignore', logFd, logFd],
      detached: true, // own process group → teardown kills the whole npx→node tree
    });

    const up = await waitForHttp(`http://127.0.0.1:${PORT}/llms.txt`, 90_000);
    if (!up) throw new Error(`gym-operator did not come up on :${PORT} within 90s (see ${opLogPath})`);
    log('operator responding; giving DBOS a moment to launch …');
    await sleep(4000);

    // 4. Register the harness (scaffolds harness_<slug> + registry).
    const reg = await fetch(`http://127.0.0.1:${PORT}/api/harness/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, path: cloneDir }),
    });
    report.register = { status: reg.status, body: await reg.text() };
    log(`register → ${reg.status}`);

    // DIAGNOSTIC: did scaffold create the harness schema + the harness_features view?
    {
      const diag = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
      try {
        const sch = await diag<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ${'harness_' + SLUG}`;
        report.harnessSchemaExists = sch[0].n > 0;
        const vw = await diag<{ x: boolean }[]>`SELECT to_regclass(${'harness_' + SLUG + '.harness_features'}) IS NOT NULL AS x`;
        report.harnessFeaturesViewExists = vw[0].x;
        const tbls = await diag<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = ${'harness_' + SLUG} ORDER BY table_name`;
        report.harnessSchemaObjects = tbls.map((t) => t.table_name);
      } finally {
        await diag.end({ timeout: 5 });
      }
    }

    // 5. File the feature — DIRECT PG insert into the consolidated table (the HTTP
    //    /features/import path goes through legacy SQLite which isn't scaffolded here).
    {
      const w = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
      try {
        await w`
          INSERT INTO harness_shared.harness_features_consolidated (harness_slug, feature_id, workspace_id, title, status)
          VALUES (${SLUG}, ${FEATURE}, ${WS}, ${'Smoke feature'}, ${'todo'})
          ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
        report.fileFeature = 'inserted (direct PG)';
        log('file feature → inserted (direct PG)');
      } finally {
        await w.end({ timeout: 5 });
      }
    }

    // 6. Start the pipeline EXPLICITLY (deterministic) via the admin route + the
    //    superuser bearer (elevates trust past the loopback allowlist). Token read
    //    from disk, never logged.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    report.superuserTokenPresent = suToken.length > 0;
    const start = await fetch(`http://127.0.0.1:${PORT}/api/admin/dbos/pipeline/start?superuser=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${suToken}` },
      body: JSON.stringify({ harnessSlug: SLUG, featureId: FEATURE }),
    });
    report.startPipeline = { status: start.status, body: (await start.text()).slice(0, 200) };
    log(`start pipeline → ${start.status}`);

    // 7. Poll the workflow status from the gym DB.
    const gym = postgres(gymUri, { max: 1, onnotice: () => {}, prepare: false });
    try {
      const wfPrefix = `pipeline:${SLUG}:${FEATURE}:e`;
      let status = 'PENDING';
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const rows = await gym<{ status: string }[]>`
          SELECT status FROM dbos.workflow_status WHERE workflow_uuid LIKE ${wfPrefix + '%'} ORDER BY created_at DESC LIMIT 1`;
        status = rows[0]?.status ?? 'PENDING';
        if (status === 'SUCCESS' || status === 'ERROR' || status === 'RETRIES_EXCEEDED') break;
        await sleep(2000);
      }
      report.workflowStatus = status;
      log(`workflow status → ${status}`);

      // 8. Capture: feature status, run_output transcript rows, git diff in the clone.
      const feat = await gym<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${SLUG} AND feature_id = ${FEATURE}`;
      report.featureStatus = feat[0]?.status ?? null;
      const runs = await gym<{ run_id: string; role: string }[]>`
        SELECT run_id, role FROM harness_shared.harness_run_output WHERE harness_slug = ${SLUG} ORDER BY started_at`;
      report.runOutputRows = runs.length;
      report.roles = runs.map((r) => r.role);
    } finally {
      await gym.end({ timeout: 5 });
    }

    // git: did the worker commit (a diff to capture)?
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    report.workerCommitted = head !== baseCommit;
    if (head !== baseCommit) {
      report.diffStat = execFileSync('git', ['diff', '--stat', baseCommit, head], { cwd: cloneDir, encoding: 'utf8' }).trim();
    }

    ok = report.workflowStatus === 'SUCCESS';
  } catch (err) {
    report.error = String(err);
  } finally {
    // Teardown — always.
    if (operator && operator.pid) {
      // detached → operator.pid is the group leader; negative pid kills the whole tree.
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) {
      try {
        report.operatorLogTail = mask(readFileSync(opLogPath, 'utf8').split('\n').slice(-25).join('\n'));
      } catch {
        /* ignore */
      }
    }
    // DIAGNOSTIC (in finally so a poll flake can't lose it): capture the worker
    // invoke's pg-bootstrap line (search_path / DB) to pin why harness_features
    // isn't resolved. Read both candidate log homes.
    try {
      let blob = '';
      const logsDir = join(cloneDir, '.harness', 'logs');
      if (existsSync(logsDir)) {
        report.harnessLogFiles = readdirSync(logsDir);
        for (const f of report.harnessLogFiles as string[]) {
          try { blob += readFileSync(join(logsDir, f), 'utf8') + '\n'; } catch { /* ignore */ }
        }
      }
      for (const p of [join(tmpdir(), `harness-${SLUG}.log`), `/tmp/harness-${SLUG}.log`]) {
        try { blob += readFileSync(p, 'utf8') + '\n'; } catch { /* ignore */ }
      }
      report.workerPgDiag = mask(
        blob.split('\n').filter((l) => /PG bootstrap|DATABASE_URL|embedded-pg|search_path|harness_features|getHarnessAdminUrl|USE_PG_STATE|connected|opted-out|verification/i.test(l)).slice(-30).join('\n'),
      ) || '(no worker run-log lines found)';
    } catch (e) {
      report.workerPgDiag = `capture err: ${String(e)}`;
    }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
    // Stop the dedicated gym testcontainer (drops the gym DB with it).
    try { await teardownTestPg(); } catch { /* ignore */ }
  }

  process.stdout.write('\n===== GYM SMOKE REPORT =====\n' + mask(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nSMOKE: PASS\n' : '\nSMOKE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
