import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { describe, expect, inject, it } from 'vitest';
import { assertNativeIsolatedWorkspace, assertNativeRuntimeLiveness, prepareNativeRuntimeReader } from './testing-native-runtime';
import { seedFakeLlmHarness } from '../../../apps/operator/e2e/_fake-llm-fixture';
import { readPlanPtoolDocument, readPlanPtoolReply } from '../test/plan-revision-ptool';
import { diagnosticCitationCase, nativePlanComparisonTimeoutMs, privatePlanUsername, readPreparedPlanHarness,
  retainNativePlanFailure, retainPlanLivenessProfile,
  type NativePlanEdit } from '../../../apps/operator/e2e/_plan-revision-edits';
import { adapterCoverageCase, assertCompleteComparisonCoverage, readComparisonCoverage } from '../../../scripts/lib/plan-revision-native-comparison.mts';

const execute = promisify(execFile);
const definitionRoot = fileURLToPath(new URL('../../../', import.meta.url));
const historicalCommit = '937d9ed054f9406d535a35f8ebaaf0db8df6d023';
const spec = 'apps/operator/e2e/plan-revision-amendment-native.spec.mts';
const comparisonCase = 'saves a citation in native Plans and correlates author reviewer and worker outcomes';

async function privateApplication(door?: 'api' | 'ptool') {
  const workspace = assertNativeIsolatedWorkspace();
  expect(process.env.VERIFY_TAURI_ISOLATED_DB).toBe('1');
  let applicationCommit = historicalCommit;
  if (process.env.VERIFY_TAURI_TEST_SOURCE_REF) {
    const request = JSON.parse(await readFile(join(process.env.PLAN_REVISION_EVIDENCE!, 'request.json'), 'utf8'));
    expect(request.definitionRef).toBe(process.env.VERIFY_TAURI_TEST_SOURCE_REF);
    expect(request.caseTitle).toBe(request.purpose === 'diagnosis' ? diagnosticCitationCase : comparisonCase);
    expect(request.group).toBe(process.env.PAPERCUSP_TEST_RUN_GROUP);
    expect(request.applicationRef).toMatch(/^[0-9a-f]{40}$/);
    applicationCommit = request.applicationRef;
    if (door === 'ptool' && request.purpose === 'diagnosis') {
      expect(prepareNativeRuntimeReader(process.env.OPERATOR_SOURCE_ROOT!, applicationCommit)?.()).toBeTruthy();
      retainPlanLivenessProfile();
    }
  }
  expect(process.env.VERIFY_TAURI_SOURCE_REF).toBe(applicationCommit);
  const root = process.env.OPERATOR_SOURCE_ROOT!;
  const runtime = assertNativeRuntimeLiveness(root, applicationCommit);
  const origin = new URL(process.env.VERIFY_TAURI_DEV_URL!);
  const database = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
  expect(['127.0.0.1', 'localhost']).toContain(origin.hostname);
  expect(['127.0.0.1', 'localhost']).toContain(database.hostname);
  expect(origin.port).toBe(process.env.VERIFY_TAURI_PORT);
  expect(database.port).toBe(process.env.PAPERCUSP_PG_PORT);
  expect(['', '3070', '3170', '3270', '3271']).not.toContain(origin.port);
  expect(['', '5432']).not.toContain(database.port);
  return { workspace, root, origin, database, runtime, applicationCommit };
}

type Save = { slug: string; harness: string; content: string; expectedHash: string; expectedVersion: number };
type Response = { ok?: boolean; code?: string; error?: string; contentHash?: string; raw?: string; version?: number };

/** Ordinary cookie-authenticated clients of the disposable application. */
async function createPrivatePlanClient(role: 'author' | 'reviewer' | 'worker', origin: URL, workspace: string) {
  const options = { baseURL: origin.origin, extraHTTPHeaders: { 'x-papercusp-workspace': workspace }, timeout: 45_000 };
  let client = await playwrightRequest.newContext(options);
  const username = privatePlanUsername(role);
  const password = randomUUID();
  async function signIn(context: APIRequestContext, id: string) {
    const login = await context.post('/api/auth/login', { maxRedirects: 0, data: { username, password } });
    expect(login.ok()).toBe(true);
    expect((await login.json()).user.id).toBe(id);
    const me = await context.get('/api/auth/me', { maxRedirects: 0 });
    expect(me.ok()).toBe(true);
    expect(await me.json()).toMatchObject({ autoLogin: false, user: { id, workspace_id: workspace } });
  }
  try {
    const created = await client.post('/api/auth/signup', { maxRedirects: 0,
      data: { username, display_name: username, password, auto_login: false } });
    expect(created.ok()).toBe(true);
    const id: string = (await created.json()).user.id;
    expect(typeof id).toBe('string');
    expect(id).toBeTruthy();
    await signIn(client, id);
    return {
      get client() { return client; },
      id,
      async reconnect() {
        const next = await playwrightRequest.newContext(options);
        try {
          await signIn(next, id);
          await client.dispose();
          client = next;
        } catch (error) {
          await next.dispose();
          throw error;
        }
      },
    };
  } catch (error) {
    await client.dispose();
    throw error;
  }
}

async function preparePrivatePlanClient(door: 'api' | 'ptool') {
  const started = Date.now();
  let stage = 'native liveness and private origin';
  try {
    const app = await privateApplication(door);
    stage = 'private harness registration';
    const harness = process.env.VERIFY_TAURI_TEST_SOURCE_REF ? readPreparedPlanHarness(app.workspace, app.runtime.fingerprint)
      : await seedFakeLlmHarness({ hive: true });
    return { app, harness };
  } catch (error) {
    retainNativePlanFailure(door, 'preflight', stage, error, Date.now() - started);
    throw error;
  }
}

describe.skipIf(inject('papercuspTestLayer') !== 'e2e')('historical private Plans clients', () => {
  it.each(['api', 'ptool'] as const)('records old author payloads across edits, retry and resumption on %s', async door => {
    const { app, harness } = await preparePrivatePlanClient(door);
    const started = Date.now();
    let activeScenario: NativePlanEdit['scenario'] | 'preflight' = 'preflight';
    let stage = 'client preparation';
    const admin = postgres(app.database.href, { max: 1, onnotice: () => {} });
    const archive = process.env.PLAN_REVISION_EVIDENCE ?? await mkdtemp(join(tmpdir(), 'native-plan-api-'));
    const observations: object[] = [];
    const roles: Record<string, Awaited<ReturnType<typeof createPrivatePlanClient>>> = {};
    const roleReads: object[] = [];
    const completed = new Set<string>();
    async function api(verb: string, payload: Record<string, unknown>, read = false): Promise<Response> {
      stage = 'Plans API ' + verb;
      const url = new URL('/api/admin/plans/' + verb, app.origin);
      if (read) for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, String(value));
      const client = roles.author!.client;
      const result = read ? await client.get(url.href, { maxRedirects: 0 })
        : await client.post(url.href, { headers: { 'content-type': 'application/json' }, data: JSON.stringify(payload), maxRedirects: 0 });
      const reply = await result.json() as Response;
      if (!result.ok() && reply.code !== 'stale' && reply.error !== 'stale')
        throw new Error('Private Plans API refused ' + verb + ' with HTTP ' + result.status());
      return reply;
    }
    try {
      // Use only the private runner's configured credential and this session's real identity.
      const ptool = async (verb: string, args: object, retry?: Save) => {
        stage = 'CLI ' + verb;
        const privateHome = await realpath(process.env.PAPERCUSP_HOME!);
        const launchDirectory = dirname(await realpath(process.env.VERIFY_TAURI_LIVENESS_CHECK!));
        expect(privateHome).toBe(join(launchDirectory, 'papercusp-home'));
        const tokenFile = join(privateHome, 'superuser-token');
        expect(await realpath(tokenFile)).toBe(tokenFile);
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
      if (door === 'api') {
        for (const role of ['author', 'reviewer', 'worker'] as const)
          roles[role] = await createPrivatePlanClient(role, app.origin, app.workspace);
        expect(new Set(Object.values(roles).map(role => role.id)).size).toBe(3);
      }
      const clientActor = { kind: door === 'api' ? 'signed-in-user' : 'cli-session',
        id: door === 'api' ? roles.author!.id : identity!.ownerId, workspace: app.workspace };
      const draft = { slug, harness, title: 'Amendment measurement', status: 'draft' };
      const created = door === 'api' ? await api('new', draft) : await ptool('plans:new', draft);
      expect(created.ok).toBe(true);
      const read = async () => {
        if (door === 'ptool') return readPlanPtoolDocument(slug, harness, ptool);
        const args = { slug, harness, mode: 'full', includeEnrichments: false };
        const doc = await api('get', args, true);
        if (doc.ok !== true || typeof doc.raw !== 'string' || typeof doc.version !== 'number'
          || typeof doc.contentHash !== 'string') throw new Error('Incomplete old-client document from ' + door);
        return { content: doc.raw, expectedVersion: doc.version, expectedHash: doc.contentHash, slug, harness };
      };
      const save = (payload: Save, retry = false) => door === 'api'
        ? api('set-content', payload) : ptool('plans:set-content', payload, retry ? payload : undefined);
      const first = await read();
      const responsibility = roles.worker
        ? '\nReviewer ' + roles.reviewer!.id + ' checks the saved diff. Worker ' + roles.worker.id + ' uses the current reference.\n' : '';
      const initial = first.content.trimEnd() + '\n\n## Comparison fixture\n\nCitation text.\nSource file: plan-efficiency.ts:1\nExpected duration: one minute.\n' + responsibility;
      expect((await save({ ...first, content: initial })).ok).toBe(true);
      let last: Save | undefined;
      for (const [scenario, previous, replacement] of [
        ['cosmetic', 'Citation text.', '*Citation text.*'],
        ['citation', 'plan-efficiency.ts:1', 'plan-efficiency.ts:2'],
        ['retry', '', ''],
        ['resumed', 'plan-efficiency.ts:2', 'plan-efficiency.ts:3'],
        ['material', 'Expected duration: one minute.', 'Expected duration: five minutes.'],
      ] as const) {
        activeScenario = scenario;
        let resumedFrom: string | undefined;
        if (scenario === 'resumed') {
          if (!last) throw new Error('The resumed client needs a previously submitted document');
          resumedFrom = createHash('sha256').update(last.content).digest('hex');
          if (door === 'api') await roles.author!.reconnect();
          else expect(await ptool('coord:whoami', {})).toMatchObject({ ownerId: clientActor.id, workspaceId: app.workspace });
        }
        // The resumed client reads its previous commit. An exact retry resubmits the original bytes.
        let payload: Save;
        if (scenario === 'retry') {
          if (!last) throw new Error('An exact retry requires its prior submission');
          payload = last;
        } else {
          const doc = await read();
          if (resumedFrom) expect(doc.expectedHash).toBe(resumedFrom);
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
        observations.push({ scenario, door, slug, clientActor, ...(resumedFrom ? { resumedFrom } : {}),
          submittedFields: Object.keys(payload).sort(), submissions: 1,
          clientDocumentReads: scenario === 'retry' ? 0 : 1, payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
          expectedHash: payload.expectedHash, savedHash: expectedHash, outcome: reply.ok === true ? 'accepted' : 'stale',
          revisions: saved, matchingInvocationRows: invocations });
        if (door === 'api') {
          const edition = saved.at(-1)!;
          const review = await roles.reviewer!.client.get('/api/admin/plans/revision-diff', {
            params: { harness, revisionId: String(edition.id) }, maxRedirects: 0 });
          expect(review.ok()).toBe(true);
          const diff = await review.json();
          expect(diff).toMatchObject({ slug, seq: edition.seq });
          expect(typeof diff.diff).toBe('string');
          roleReads.push({ role: 'reviewer', actorId: roles.reviewer!.id, scenario, revisionId: String(edition.id),
            savedHash: expectedHash, action: 'read revision diff', responseSha256: createHash('sha256').update(diff.diff).digest('hex') });
          const continuation = await roles.worker!.client.get('/api/admin/plans/get', {
            params: { slug, harness, mode: 'full', includeEnrichments: 'false' }, maxRedirects: 0 });
          expect(continuation.ok()).toBe(true);
          const current = await continuation.json();
          expect(current).toMatchObject({ slug, raw: payload.content, contentHash: expectedHash });
          expect(current.raw).toContain('Worker ' + roles.worker!.id);
          roleReads.push({ role: 'worker', actorId: roles.worker!.id, scenario, revisionId: String(edition.id),
            savedHash: expectedHash, action: 'read current reference', responseSha256: current.contentHash });
        }
        completed.add(scenario);
        last = payload;
      }
      expect(observations).toHaveLength(5);
      stage = 'final native liveness';
      expect(assertNativeRuntimeLiveness(app.root, app.applicationCommit).fingerprint).toBe(app.runtime.fingerprint);
    } catch (error) {
      retainNativePlanFailure(door, activeScenario, stage, error, Date.now() - started);
      throw error;
    } finally {
      try {
        const path = join(archive, 'draft-author-' + randomUUID() + '.json');
        await writeFile(path, JSON.stringify({ workspace: app.workspace, applicationCommit: app.applicationCommit,
          definitionCommit: process.env.VERIFY_TAURI_TEST_SOURCE_REF, group: process.env.PAPERCUSP_TEST_RUN_GROUP,
          runtime: app.runtime, door, observations, roleReads,
          unmeasured: ['cosmetic', 'citation', 'retry', 'resumed', 'material'].filter(scenario => !completed.has(scenario)),
          coverage: 'Original client operations and authenticated role reads. Model work and required judgments need their own source records.' }),
        { flag: 'wx', mode: 0o600 });
        console.info('Original draft author observations', path);
      } finally {
        try { await Promise.all(Object.values(roles).map(role => role.client.dispose())); }
        finally { await admin.end({ timeout: 5 }); }
      }
    }
  }, 360_000);

  it(adapterCoverageCase, async () => {
    const app = await privateApplication();
    const group = process.env.PAPERCUSP_TEST_RUN_GROUP;
    if (!group?.trim() || !process.env.VERIFY_TAURI_TEST_SOURCE_REF) throw new Error('Missing original comparison group or definition');
    const output = await mkdtemp(join(process.env.PLAN_REVISION_EVIDENCE ?? tmpdir(), 'native-plan-pw-'));
    const ledgerUrl = process.env.PAPERCUSP_TEST_RUNS_DB_URL;
    expect(ledgerUrl).toBeTruthy();
    expect(ledgerUrl).not.toBe(app.database.href);
    const ledger = postgres(ledgerUrl!, { max: 1, onnotice: () => {} });
    try {
      await execute(process.execPath, [resolve(definitionRoot, 'node_modules/@playwright/test/cli.js'), 'test',
        '--config', resolve(definitionRoot, 'apps/operator/playwright.config.mts'), spec.split('/').at(-1)!,
        '--grep', comparisonCase + '$', '--workers=1', '--retries=0', '--output=' + output], {
        cwd: definitionRoot, env: { ...process.env, PAPERCUSP_TEST_RUN_GROUP: group },
        timeout: nativePlanComparisonTimeoutMs + 60_000, maxBuffer: 2_000_000,
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
      const runtimeAfter = assertNativeRuntimeLiveness(app.root, app.applicationCommit);
      expect(runtimeAfter.fingerprint).toBe(app.runtime.fingerprint);
      expect(row.execution_details).toMatchObject({ testLayer: 'e2e', passed: 1, failed: 0, skipped: 0,
        collectionFailed: false, passedCaseTitles: [comparisonCase], runtimeEnvironmentBefore: { fingerprint: app.runtime.fingerprint },
        runtimeEnvironmentAfter: { fingerprint: runtimeAfter.fingerprint } });
      console.info('Original desktop citation observations', JSON.stringify({ group, testRunId: row.id, verifierCommit: row.commit_sha,
        applicationCommit: app.applicationCommit, runtime: runtimeAfter.fingerprint, output }));
      const coverage = readComparisonCoverage(process.env.PLAN_REVISION_EVIDENCE!, {
        group, workspace: process.env.PAPERCUSP_TEST_RUN_WORKSPACE!, privateWorkspace: app.workspace,
        harness: process.env.PAPERCUSP_TEST_RUN_HARNESS!,
        applicationRef: app.applicationCommit, definitionRef: process.env.VERIFY_TAURI_TEST_SOURCE_REF,
      }, app.runtime);
      assertCompleteComparisonCoverage(coverage.unmeasured);
    } finally { await ledger.end({ timeout: 5 }); }
  }, nativePlanComparisonTimeoutMs + 90_000);
});
