/**
 * Brief 48 (gym tail) — the GYM-BLUEPRINT CYCLE runnable: drive ONE optimization cycle
 * of the `gym` blueprint THROUGH THE DURABLE PIPELINE (deriveNext over the gym spine,
 * D-022), not the bespoke loop (`gym-loop-run.ts` / `runOptimizationLoop`).
 *
 * What this proves that the bespoke loop + the deterministic gym-pipeline.test.ts
 * cannot: a REGISTERED harness whose `.papercusp/blueprint.yaml` extends `gym` is
 * resolved from disk by `resolveHarnessSpine`, a G- work item binds through the
 * EI-35-broadened id vocabulary, the gym-director's verbs dispatch the gym roles on a
 * real booted operator, and (real mode) the committer lands a commit→reproject edit in
 * the TARGET harness's own git tree.
 *
 * Mirrors `gym-loop-run.ts`'s isolation: a dedicated gym DB (testcontainer PG +
 * provisionGymDatabase, which premints the spawn-signing key) + a dedicated headless
 * gym-operator booted from this checkout with DBOS enabled. Nothing touches the live
 * operator or its DB.
 *
 * Two modes (env GYM_BP_FAKE, DEFAULT fake):
 *   GYM_BP_FAKE=1 (default) → fixtures/fake-gym-agent.mjs walks the spine verbs with
 *                             ZERO LLM spend — the live-boot assembly check.
 *   GYM_BP_FAKE=0           → real AGENT_CMD agents (sonnet by default) actually
 *                             optimize the target; bounded by the spine's own
 *                             terminality + GYM_BP_TIMEOUT_MIN.
 *
 *   cd apps/operator && set -a; . ./.env.local; set +a; \
 *     npx tsx ../../packages/operator-core/lib/gym/blueprint-cycle-run.ts            # fake
 *     GYM_BP_FAKE=0 npx tsx ../../packages/operator-core/lib/gym/blueprint-cycle-run.ts  # real
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { provisionGymDatabase } from './gym-db-init';
import { buildGymOperatorBootSpec } from './boot-spec';

process.env.LLM_TEST_BACKEND = process.env.LLM_TEST_BACKEND ?? 'claude-code';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../../..');
const FAKE_AGENT = join(__dirname, 'fixtures/fake-gym-agent.mjs');
const PORT = Number(process.env.GYM_BP_PORT ?? 3977);
const HEX = randomBytes(4).toString('hex');
const DB_NAME = `papercusp_gym_bp_${HEX}`;
const WS = process.env.GYM_BP_WORKSPACE ?? 'gym-bp-ws';
const GYM_SLUG = process.env.GYM_BP_GYM_SLUG ?? 'g48gym';
const TARGET_SLUG = process.env.GYM_BP_TARGET_SLUG ?? 'g48target';
const FAKE = process.env.GYM_BP_FAKE !== '0';
const TIMEOUT_MIN = Math.max(2, Number(process.env.GYM_BP_TIMEOUT_MIN ?? (FAKE ? 6 : 60)));
const REAL_AGENT_CMD = process.env.GYM_BP_AGENT_CMD ?? 'claude -p --model claude-sonnet-4-6';
const FEATURE_ID = 'G-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[gym-bp] ${m}\n`);
const mask = (s: string) => s.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]*(@)/g, '$1***$2');

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

function gitInitCommit(dir: string, msg: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=gym@local', '-c', 'user.name=gym', 'commit', '-qm', msg], { cwd: dir });
}

/** A registered-harness tree whose blueprint EXTENDS a built-in (loader resolves builtins). */
function writeHarnessTree(dir: string, blueprintId: string, extendsId: string, readme: string): void {
  mkdirSync(join(dir, '.papercusp'), { recursive: true });
  writeFileSync(
    join(dir, '.papercusp', 'blueprint.yaml'),
    `# Brief 48 gym-blueprint e2e — a throwaway instance of the built-in \`${extendsId}\`.\nid: ${blueprintId}\nextends: ${extendsId}\nversion: 0.0.1\n`,
  );
  writeFileSync(join(dir, 'README.md'), readme);
  gitInitCommit(dir, 'seed');
}

async function main(): Promise<void> {
  let pgContainer: StartedPostgreSqlContainer | undefined;
  let operator: ChildProcess | undefined;
  let logFd: number | undefined;
  const scratch = mkdtempSync(join(tmpdir(), 'gym-bp-'));
  const opLogPath = join(tmpdir(), `gym-bp-op-${HEX}.log`);
  let gymSql: postgres.Sql | undefined;
  let ok = false;
  const report: Record<string, unknown> = { mode: FAKE ? 'fake (zero-LLM)' : 'real', gymSlug: GYM_SLUG, targetSlug: TARGET_SLUG, featureId: FEATURE_ID };

  try {
    // 1. Dedicated gym DB (full migration baseline + preminted spawn-signing key).
    log('provisioning gym DB …');
    pgContainer = await new PostgreSqlContainer('pgvector/pgvector:pg16').withDatabase('papercusp_bp').start();
    const { databaseUri: gymUri } = await provisionGymDatabase({ maintenanceUri: pgContainer.getConnectionUri(), dbName: DB_NAME });
    gymSql = postgres(gymUri, { max: 4, onnotice: () => {}, prepare: false });

    // 2. The two harness trees: the TARGET (extends research — repo-less pipeline, its
    //    .papercusp tree is the commit→reproject surface) and the GYM (extends gym).
    const targetDir = join(scratch, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeHarnessTree(targetDir, TARGET_SLUG, 'research', '# g48 target\nThe throwaway research harness the gym optimizes.\n');
    const targetSeedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim();

    const gymDir = join(scratch, 'gym');
    mkdirSync(gymDir, { recursive: true });
    writeHarnessTree(gymDir, GYM_SLUG, 'gym', '# g48 gym\nThe throwaway gym harness (improves the target).\n');

    // 3. Boot the dedicated gym-operator from THIS checkout (DBOS on, manual dispatch).
    const harnessCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    report.harnessCommit = harnessCommit;
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: REPO_ROOT,
      harnessCommit,
      gymDatabaseUrl: gymUri,
      honoPort: PORT,
      workspaceId: WS,
      agentCmd: FAKE ? `node ${FAKE_AGENT}` : REAL_AGENT_CMD,
    });
    logFd = openSync(opLogPath, 'w');
    log(`booting gym-operator on :${PORT} (mode=${FAKE ? 'fake' : 'real'}, log → ${opLogPath}) …`);
    operator = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env, PAPERCUSP_FLEET_SANDBOX: '0', PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0', NODE_ENV: 'production', PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none' },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    });
    if (!(await waitForHttp(`http://127.0.0.1:${PORT}/llms.txt`, 120_000))) throw new Error(`gym-operator did not come up on :${PORT} (see ${opLogPath})`);
    log('operator up; giving DBOS a moment …');
    await sleep(4000);

    // 4. Register both harnesses (the same public route the gym runner uses).
    for (const [slug, path] of [[TARGET_SLUG, targetDir], [GYM_SLUG, gymDir]] as const) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/harness/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, path }),
      });
      if (!res.ok) throw new Error(`register ${slug} → ${res.status}: ${await res.text()}`);
      const body = (await res.json().catch(() => ({}))) as { provisioning?: { ok?: boolean; error?: string } };
      if (body.provisioning && body.provisioning.ok === false) throw new Error(`register ${slug}: scaffold failed: ${body.provisioning.error ?? 'unknown'}`);
      log(`registered ${slug} ← ${path}`);
    }

    // 5. File the gym-task (G- id, kind gym-task, target recorded on the row — the
    //    gym-director reads the target slug + matrix from here).
    const spec1 = [
      `Optimize the TARGET harness \`${TARGET_SLUG}\` (a registered research-blueprint harness; its tree is at ${targetDir}).`,
      `Eval matrix (bounded, D-019): variants = baseline + ONE candidate (prompts-only, researcher role) × 1 train task × 1 repeat.`,
      `Mechanics available on this operator (loopback): register a throwaway sub-harness via POST http://127.0.0.1:${PORT}/api/harness/projects {slug,path}; file its work item via the work_items tools (or SQL); start its pipeline via POST http://127.0.0.1:${PORT}/api/admin/dbos/pipeline/start?superuser=1 with the bearer from ~/.papercusp/superuser-token; judge runs with the gym:judge tool (the target's rubric: work-item-output trace).`,
      `The proposer records its proposed prompt edit + rationale + numbers on this work item (work_items comment / output).`,
      `A/B-gate for THIS bounded cycle: autoloop AUTO-ACCEPT (the gym-director persona's auto-accept arm) — if the candidate's judged composite beats the baseline and no deterministic signal regresses, proceed to ACCEPT; otherwise ESCALATE with the numbers. No human review row is required.`,
      `On ACCEPT the committer applies the edit to ${targetDir}/.papercusp/prompts/researcher.md (create it), commits IN THE TARGET TREE (one commit, message names the role + rationale), and reports the new content hash.`,
    ].join('\n');
    await gymSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, workspace_id, title, status, summary, kind, payload)
      VALUES (${GYM_SLUG}, ${FEATURE_ID}, ${WS}, ${'Gym cycle: optimize ' + TARGET_SLUG}, ${'todo'}, ${spec1}, ${'gym-task'},
              ${gymSql.json({ targetSlug: TARGET_SLUG, targetDir, matrix: { variants: 2, tasks: 1, repeats: 1 } })})
      ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    log(`filed ${FEATURE_ID} (kind=gym-task, target=${TARGET_SLUG})`);

    // 6. Start the durable pipeline (manual dispatch — the P-018 mechanism). The route
    //    resolves the gym spine from the registered harness's .papercusp/blueprint.yaml.
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    const suToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
    const startRes = await fetch(`http://127.0.0.1:${PORT}/api/admin/dbos/pipeline/start?superuser=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${suToken}` },
      body: JSON.stringify({ harnessSlug: GYM_SLUG, featureId: FEATURE_ID }),
    });
    if (!startRes.ok) throw new Error(`pipeline/start → ${startRes.status}: ${await startRes.text()}`);
    const { workflowID } = (await startRes.json()) as { workflowID?: string };
    if (!workflowID) throw new Error('pipeline/start returned no workflowID');
    report.workflowID = workflowID;
    log(`pipeline started: ${workflowID}`);

    // 7. Poll to terminal. In real mode, auto-accept a pending proposal the moment it
    //    appears (exercising the human side of the A/B-gate via the gym control route).
    const deadline = Date.now() + TIMEOUT_MIN * 60_000;
    let wfStatus = 'PENDING';
    let accepted = false;
    while (Date.now() < deadline) {
      const wf = await gymSql<{ status: string }[]>`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowID} LIMIT 1`;
      wfStatus = wf[0]?.status ?? 'PENDING';
      if (wfStatus === 'SUCCESS' || wfStatus === 'ERROR' || wfStatus === 'CANCELLED') break;
      if (!FAKE && !accepted) {
        const pending = await gymSql<{ id: string }[]>`
          SELECT id::text AS id FROM harness_shared.gym_proposals
           WHERE workspace_id = ${WS} AND status = 'pending' LIMIT 1`.catch(() => [] as { id: string }[]);
        if (pending.length > 0) {
          const acc = await fetch(`http://127.0.0.1:${PORT}/api/gym/${TARGET_SLUG}/accept`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: pending[0].id }),
          });
          log(`accepted proposal ${pending[0].id} → ${acc.status}`);
          accepted = acc.ok;
        }
      }
      await sleep(5000);
    }
    report.workflowStatus = wfStatus;

    // 8. Evidence: the dispatch sequence, the work-item terminal state, and (real mode)
    //    the committer's commit in the TARGET tree.
    const runs = await gymSql<{ role: string; run_id: string; exit_code: number | null }[]>`
      SELECT role, run_id, exit_code FROM harness_shared.harness_run_output
       WHERE harness_slug = ${GYM_SLUG} ORDER BY started_at ASC`;
    report.dispatchSequence = runs.map((r) => `${r.role}(rc=${r.exit_code})`);
    const feat = await gymSql<{ status: string }[]>`
      SELECT status FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${GYM_SLUG} AND feature_id = ${FEATURE_ID} LIMIT 1`;
    report.featureStatus = feat[0]?.status ?? null;

    const targetLog = execFileSync('git', ['log', '--oneline'], { cwd: targetDir, encoding: 'utf8' }).trim().split('\n');
    report.targetGitLog = targetLog;
    const targetCommitted = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim() !== targetSeedCommit;

    const roleSeq = runs.map((r) => r.role);
    const spineWalked = ['gym-director', 'task-generator', 'variant-runner', 'judge', 'proposer', 'committer'].every((r) => roleSeq.includes(r));
    report.spineWalked = spineWalked;
    report.targetCommitted = targetCommitted;
    ok = wfStatus === 'SUCCESS' && spineWalked && (FAKE || targetCommitted);
  } catch (err) {
    report.error = String(err);
  } finally {
    if (gymSql) { try { await gymSql.end({ timeout: 5 }); } catch { /* ignore */ } }
    if (operator?.pid) {
      try { process.kill(-operator.pid, 'SIGTERM'); } catch { /* ignore */ }
      await sleep(2500);
      try { process.kill(-operator.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (logFd !== undefined) { try { (report as Record<string, unknown>).operatorLogTail = mask(readFileSync(opLogPath, 'utf8').split('\n').slice(-25).join('\n')); } catch { /* ignore */ } }
    if (process.env.GYM_BP_KEEP !== '1') { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
    else log(`kept scratch at ${scratch}`);
    try { if (pgContainer) await pgContainer.stop(); } catch { /* ignore */ }
  }

  process.stdout.write('\n===== GYM BLUEPRINT CYCLE (Brief 48) REPORT =====\n' + mask(JSON.stringify(report, null, 2)) + '\n');
  process.stdout.write(ok ? '\nGYM-BP-CYCLE: OK\n' : '\nGYM-BP-CYCLE: FAIL\n');
  process.exit(ok ? 0 : 1);
}

void main();
