import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';
import { assertNativeIsolatedWorkspace, assertNativeRuntimeLiveness } from './testing-native-runtime';
import { seedFakeLlmHarness } from '../../../apps/operator/e2e/_fake-llm-fixture';
import { readPlanPtoolReply } from '../test/plan-revision-ptool';

const execute = promisify(execFile);
const definitionRoot = fileURLToPath(new URL('../../../', import.meta.url));
const historicalCommit = '937d9ed054f9406d535a35f8ebaaf0db8df6d023';
const spec = 'apps/operator/e2e/plan-revision-amendment-native.spec.mts';
const authorCase = 'records the native author citation edit and reads the exact saved revision';

function privateApplication() {
  const workspace = assertNativeIsolatedWorkspace();
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  expect(process.env.VERIFY_TAURI_SOURCE_REF).toBe(historicalCommit);
  const root = process.env.OPERATOR_SOURCE_ROOT!;
  const runtime = assertNativeRuntimeLiveness(root, historicalCommit);
  const origin = new URL(process.env.VERIFY_TAURI_DEV_URL!);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(origin.hostname);
  expect(['127.0.0.1', 'localhost']).toContain(database.hostname);
  expect(origin.port).toBe(process.env.VERIFY_TAURI_PORT);
  expect(database.port).toBe(process.env.PAPERCUSP_PG_PORT);
  expect(['', '3070', '3170', '3270', '3271']).not.toContain(origin.port);
  expect(['', '5432']).not.toContain(database.port);
  return { workspace, root, origin, database, runtime };
}

type Save = { slug: string; harness: string; content: string; expectedHash: string; expectedVersion: number };
type Response = { ok?: boolean; code?: string; error?: string; contentHash?: string; raw?: string; version?: number };

describe.skipIf(inject('papercuspTestLayer') !== 'e2e')('historical private Plans clients', () => {
  it.each(['api', 'ptool'] as const)('records old author payloads across edits, retry and resumption on %s', async door => {
    const app = privateApplication();
    const harness = await seedFakeLlmHarness({ hive: true });
    const admin = postgres(app.database.href, { max: 1, onnotice: () => {} });
    const headers = { 'content-type': 'application/json', 'x-papercusp-workspace': app.workspace };
    const archive = process.env.PLAN_REVISION_EVIDENCE ?? await mkdtemp(join(tmpdir(), 'native-plan-api-'));
    const observations: object[] = [];
    const completed = new Set<string>();
    async function api(verb: string, payload: Record<string, unknown>, read = false): Promise<Response> {
      const url = new URL('/api/admin/plans/' + verb, app.origin);
      if (read) for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, String(value));
      const result = await fetch(url, { method: read ? 'GET' : 'POST', headers, redirect: 'error',
        body: read ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(45_000) });
      const reply = await result.json() as Response;
      if (!result.ok && reply.code !== 'stale' && reply.error !== 'stale')
        throw new Error('Private Plans API refused ' + verb + ' with HTTP ' + result.status);
      return reply;
    }
    try {
      const privateHome = await realpath(process.env.PAPERCUSP_HOME!);
      const launchDirectory = dirname(await realpath(process.env.VERIFY_TAURI_LIVENESS_CHECK!));
      expect(privateHome).toBe(join(launchDirectory, 'papercusp-home'));
      const tokenFile = join(privateHome, 'superuser-token');
      expect(await realpath(tokenFile)).toBe(tokenFile);
      // Use only the private runner's configured credential and this session's real identity.
      const ptool = (verb: string, args: object, retry?: Save) => {
        const command = execute(process.execPath, [join(app.root, 'apps/operator/scripts/ptool.mjs'),
          verb, '--url=' + app.origin.origin, '--token-file=' + tokenFile, '--workspace=' + app.workspace,
          '--harness=' + harness, '--raw', '--json', JSON.stringify(args)], { cwd: app.root,
          env: { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' }, maxBuffer: 2_000_000, timeout: 90_000 });
        return readPlanPtoolReply(command, retry);
      };
      const identity = door === 'ptool' ? await ptool('coord:whoami', {}) : null;
      if (identity) {
        expect(identity.workspaceId).toBe(app.workspace);
        expect(identity.ownerId).toBe(process.env.PAPERCUSP_SID);
        expect(identity.ownerId).toBeTruthy();
      }
      const slug = 'draft-revision-' + randomUUID() + '-' + new Date().toISOString().slice(0, 10);
      const created = await api('new', { slug, harness, title: 'Amendment measurement', status: 'draft' });
      expect(created.ok).toBe(true);
      const read = async () => {
        const args = { slug, harness, mode: 'full', includeEnrichments: false };
        const doc = door === 'api' ? await api('get', args, true) : await ptool('plans:get', args);
        if (doc.ok !== true || typeof doc.raw !== 'string' || typeof doc.version !== 'number'
          || typeof doc.contentHash !== 'string') throw new Error('Incomplete old-client document from ' + door);
        return { content: doc.raw, expectedVersion: doc.version, expectedHash: doc.contentHash, slug, harness };
      };
      const save = (payload: Save, retry = false) => door === 'api'
        ? api('set-content', payload) : ptool('plans:set-content', payload, retry ? payload : undefined);
      const first = await read();
      const initial = first.content.trimEnd() + '\n\n## Comparison fixture\n\nCitation text.\nSource file: plan-efficiency.ts:1\nExpected duration: one minute.\n';
      expect((await save({ ...first, content: initial })).ok).toBe(true);
      let last: Save | undefined;
      for (const [scenario, previous, replacement] of [
        ['cosmetic', 'Citation text.', '*Citation text.*'],
        ['citation', 'plan-efficiency.ts:1', 'plan-efficiency.ts:2'],
        ['retry', '', ''],
        ['resumed', 'plan-efficiency.ts:2', 'plan-efficiency.ts:3'],
        ['material', 'Expected duration: one minute.', 'Expected duration: five minutes.'],
      ] as const) {
        // A resumed client obtains its new CAS baseline from the saved document. An exact retry resubmits the original bytes.
        let payload: Save;
        if (scenario === 'retry') {
          if (!last) throw new Error('An exact retry requires its prior submission');
          payload = last;
        } else {
          const doc = await read();
          expect(doc.content.split(previous)).toHaveLength(2);
          payload = { ...doc, content: doc.content.replace(previous, replacement) };
        }
        const reply = await save(payload, scenario === 'retry');
        if (scenario === 'retry' && reply.ok !== true) expect(reply.error ?? reply.code).toBe('stale');
        else expect(reply.ok).toBe(true);
        const expectedHash = createHash('sha256').update(payload.content).digest('hex');
        const saved = await admin`SELECT id::text, seq, author_kind, author_id, session_id, content_hash
          FROM harness_shared.plan_revisions WHERE workspace_id=${app.workspace} AND harness_slug=${harness}
          AND plan_slug=${slug} AND content_hash=${expectedHash} ORDER BY seq`;
        expect(saved.length).toBeGreaterThan(0);
        if (identity) expect(saved.every(row => row.author_id === identity.ownerId || row.session_id === identity.ownerId)).toBe(true);
        const invocations = await admin`SELECT id::text, status, role, coord_owner_id FROM harness_shared.tool_invocations
          WHERE workspace_id=${app.workspace} AND harness_slug=${harness} AND args_json->>'slug'=${slug}
          AND args_json->>'expectedHash'=${payload.expectedHash} AND tool_name IN ('plans:set-content','plans_set_content') ORDER BY id`;
        observations.push({ scenario, door, slug, submittedFields: Object.keys(payload).sort(), submissions: 1,
          clientDocumentReads: scenario === 'retry' ? 0 : 1, payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
          expectedHash: payload.expectedHash, savedHash: expectedHash, outcome: reply.ok === true ? 'accepted' : 'stale',
          revisions: saved, matchingInvocationRows: invocations });
        completed.add(scenario);
        last = payload;
      }
      expect(observations).toHaveLength(5);
      expect(assertNativeRuntimeLiveness(app.root, historicalCommit).fingerprint).toBe(app.runtime.fingerprint);
    } finally {
      try {
        const path = join(archive, 'draft-author-' + randomUUID() + '.json');
        await writeFile(path, JSON.stringify({ workspace: app.workspace, historicalCommit, runtime: app.runtime, door,
          observations, unmeasured: ['cosmetic', 'citation', 'retry', 'resumed', 'material'].filter(scenario => !completed.has(scenario)),
          coverage: 'Author requests on this client. Reviewer, worker and model effort need separate observations.' }), { flag: 'wx' });
        console.info('Original draft author observations', path);
      } finally { await admin.end({ timeout: 5 }); }
    }
  }, 360_000);

  it('correlates the native author control with its independently recorded Playwright case', async () => {
    const app = privateApplication();
    const group = 'revision-native-author-' + randomUUID();
    const output = await mkdtemp(join(process.env.PLAN_REVISION_EVIDENCE ?? tmpdir(), 'native-plan-pw-'));
    const ledgerUrl = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    expect(ledgerUrl).toBeTruthy();
    expect(ledgerUrl).not.toBe(app.database.href);
    const ledger = postgres(ledgerUrl!, { max: 1, onnotice: () => {} });
    try {
      await execute(process.execPath, [resolve(definitionRoot, 'node_modules/@playwright/test/cli.js'), 'test',
        '--config', resolve(definitionRoot, 'apps/operator/playwright.config.mts'), spec.split('/').at(-1)!,
        '--grep', authorCase + '$', '--workers=1', '--retries=0', '--output=' + output], {
        cwd: definitionRoot, env: { ...process.env, PAPERCUSP_TEST_RUN_GROUP: group },
        timeout: 300_000, maxBuffer: 2_000_000,
      });
      const rows = await ledger`SELECT id::text, commit_sha, status, worktree_dirty, finished_at, execution_details
        FROM harness_shared.test_runs WHERE workspace_id=${process.env.PAPERCUSP_TEST_RUN_WORKSPACE!}
        AND harness_slug=${process.env.PAPERCUSP_TEST_RUN_HARNESS!} AND framework='playwright'
        AND run_group_id=${group} AND file_path=${spec}`;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe('pass');
      expect(row.finished_at).toBeTruthy();
      expect(row.worktree_dirty).toBe(false);
      expect(row.commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(row.commit_sha).toBe(process.env.VERIFY_TAURI_TEST_SOURCE_REF);
      const runtimeAfter = assertNativeRuntimeLiveness(app.root, historicalCommit);
      expect(runtimeAfter.fingerprint).toBe(app.runtime.fingerprint);
      expect(row.execution_details).toMatchObject({ testLayer: 'e2e', passed: 1, failed: 0, skipped: 0,
        collectionFailed: false, passedCaseTitles: [authorCase], runtimeEnvironmentBefore: { fingerprint: app.runtime.fingerprint },
        runtimeEnvironmentAfter: { fingerprint: runtimeAfter.fingerprint } });
      console.info('Original desktop author observation', JSON.stringify({ group, testRunId: row.id, verifierCommit: row.commit_sha,
        applicationCommit: historicalCommit, runtime: runtimeAfter.fingerprint, output }));
    } finally { await ledger.end({ timeout: 5 }); }
  }, 350_000);
});
