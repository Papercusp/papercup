import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

export function fixtureChildFailure(error: unknown): Error {
  const child = error as { message?: string; code?: unknown; signal?: unknown; killed?: boolean; stdout?: string; stderr?: string };
  return new Error(`Isolated fixture child failed: ${JSON.stringify({
    message: child.message, code: child.code, signal: child.signal, killed: child.killed,
    stdout: child.stdout, stderr: child.stderr,
  })}`, { cause: error });
}

// Register a real harness only in the maintained disposable rig. The chat
// tools resolve their project before entering the fake model seam.
export async function seedFakeLlmHarness(options: { hive?: boolean } = {}): Promise<string> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return 'main';
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated chat fixture context');
  const database = new URL(admin);
  const slug = options.hive ? 'e2e-fake-plan' : 'e2e-fake-chat';
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared chat fixture database');
  await promisify(execFile)(process.execPath, [
    '--import', resolve(root, 'scripts/lib/committed-source-loader.mjs'),
    '--import', 'tsx', '--input-type=module', '-e',
    `const { loadHarnessRegistry } = await import('./packages/operator-core/lib/harness-registry.ts');
     const ws = process.env.PAPERCUSP_WORKSPACE_ID;
     const reg = await loadHarnessRegistry(ws);
     const { getOrgPg } = await import('@papercusp/db-org');
     const { sql } = getOrgPg();
     try {
       // Fixture writes use the existing registry storage contract and its PG
       // invalidation trigger. The product save path also imports the live
       // notification graph, which took 42s in a fresh isolated child.
       const slug = ${JSON.stringify(slug)};
       const project = { slug, path: process.cwd(), ...${JSON.stringify(options.hive ? { harness_kind: 'hive', self_repo: true } : {})} };
       const payload = { ...reg, projects: [...reg.projects.filter(p => p.slug !== slug), project] };
       await sql.unsafe('INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at', [ws, JSON.stringify(payload), Date.now()]);
       const rows = await sql.unsafe('SELECT payload FROM harness_shared.harness_registry WHERE workspace_id = $1', [ws]);
       if (!rows[0]?.payload?.projects?.some(p => p.slug === slug && p.path === process.cwd() && (!${Boolean(options.hive)} || p.harness_kind === 'hive'))) throw new Error('Chat fixture registry write was not retained');
     } finally { await sql.end(); }`,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 }).catch(error => { throw fixtureChildFailure(error); });
  return slug;
}

// Use the maintained transactional BAR writer, then the actual launch gate.
// This fixture is deliberately confined to the disposable database; it never
// changes admission policy or fabricates a successful gate verdict.
export async function seedFakeLlmPlanAcceptance(harnessSlug: string, planSlug: string): Promise<void> {
  if (process.env.VERIFY_TAURI_ISOLATED_DB !== '1') return;
  const root = process.env.OPERATOR_SOURCE_ROOT;
  const workspace = process.env.PAPERCUSP_WORKSPACE_ID;
  const admin = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!root || !workspace?.startsWith('verify-tauri-isolated-') || !admin) throw new Error('Missing isolated plan fixture context');
  const database = new URL(admin);
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || !database.port || database.port === '5432') throw new Error('Refusing shared plan fixture database');
  await promisify(execFile)(process.execPath, [
    '--import', resolve(root, 'scripts/lib/committed-source-loader.mjs'),
    '--import', 'tsx', '--input-type=module', '-e',
    `console.error('plan-fixture stage=migration-import:start');
     const { runAcceptanceBarMigrationInDatabase } = await import('./packages/operator-core/lib/acceptance-bar-migration.ts');
     console.error('plan-fixture stage=migration-import:done gate-import:start');
     const { checkPlanStartable } = await import('./packages/operator-core/lib/agent-tools/plans/plan-start-gate.ts');
     console.error('plan-fixture stage=gate-import:done db-import:start');
     const { getOrgPg } = await import('@papercusp/db-org');
     const { sql } = getOrgPg();
     try {
       const harnessSlug = ${JSON.stringify(harnessSlug)};
       const planSlug = ${JSON.stringify(planSlug)};
       console.error('plan-fixture stage=migration:start');
       const result = await runAcceptanceBarMigrationInDatabase({ workspaceId: process.env.PAPERCUSP_WORKSPACE_ID, harnessSlug, planSlug, actorId: 'e2e-plan-fixture', dryRun: false });
       console.error('plan-fixture stage=migration:done gate:start');
       const gate = await checkPlanStartable(planSlug, { workspaceId: process.env.PAPERCUSP_WORKSPACE_ID, harnessSlug }, null, 'start');
       console.error('plan-fixture stage=gate:done');
       if (!gate.ok) throw new Error('Plan fixture launch precondition failed: ' + JSON.stringify({ result, gate }));
     } finally { await sql.end(); }`,
  ], { cwd: root, env: { ...process.env, DATABASE_URL: admin }, timeout: 30_000 }).catch(error => { throw fixtureChildFailure(error); });
}
