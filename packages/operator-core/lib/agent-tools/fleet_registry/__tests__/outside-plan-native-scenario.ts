/** Real fleet launcher + installed Codex clients; only inference is scripted. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrgPg, _resetForTests } from '@papercusp/db-org';
import { decode } from '@papercusp/result-encoding';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { eventLogPathForOwner } from '../../../../../../apps/operator/scripts/psu-pty-host.mjs';
import { createWorkItem, getWorkItem } from '../../../work-items';
import { getFleet } from '../../../agent-fleets-store';
import { preflightFleetWorkItems } from '../../../scheduler/fleet-work-items';
import { loadHarnessRegistry, saveHarnessRegistry } from '../../../harness-registry';
import { resolveHarnessPlansDir } from '../../plans/source';
import { readSuperuserToken } from '../../../superuser-token';
import { readBlockerResolution } from '../../../blocker-resolution-decision';
import { psuLaunchLogPath } from '../../../psu-launch-log.mjs';
import { codexCliResponsesBody, codexCliResponsesCompletionSse } from '../../../inference-gateway/codex-cli-bridge';
import { privateBundleRuntimeEnv, waitForPrivateOperator,
  stopPrivateOperatorHost } from '../../../../test/private-http-workspace-preflight';
import { prepareCurrentSuNativeScenario } from '../../../../test/current-su-native-http-scenario';
import { serveCurrentSuNativeModelDiscovery } from '../../../../test/current-su-native-http-protocol';
import { retainIsolatedNativeTaskDiagnostics } from '../../../../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../../../../..');
const evidenceDir = process.argv[2];
const bundle = { path: process.argv[3], sha256: process.argv[4] };
const workspace = process.env.PAPERCUSP_WORKSPACE_ID!;
const base = process.env.PAPERCUSP_OPERATOR_URL!;
const fleet = 'outside-native';
const leader = 'su-private-outside-native-leader';
const reference = '  tracker:physical fleet "quoted"\n😀  ';
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const { sql } = getOrgPg();
let host: ReturnType<typeof spawn> | undefined;
let client: Client | undefined;
const modelRequests: Array<{ owner: string; round: number; tool: string | null; body: unknown }> = [];
const rounds = new Map<string, number>();
const callLog: Array<{ owner: string; tool: string; args: unknown }> = [];
const leaderCalls: Array<{ tool: string; args: Record<string, unknown>; result: unknown }> = [];
const workEvents: Array<{ sequence: number; type: 'claim-observed' | 'completion-observed'; id: string; owner: string | null }> = [];
const stateObservations: Array<{ observer: string; states: unknown }> = [];
const tasks: string[] = [];
let ids: string[] = [];

async function retainNativeDiagnostics() {
  const sessionRows = await sql`SELECT id, coord_owner_id, session_id, outside_plan_ref, ended_at
    FROM harness_shared.adv_sessions WHERE workspace_id=${workspace} AND coord_owner_id<>${leader}`;
  const taskRows = await sql`SELECT * FROM harness_shared.task_ledger WHERE workspace_id=${workspace}`;
  writeFileSync(join(evidenceDir, 'outside-native-runtime-state.json'), JSON.stringify({ sessionRows, taskRows }));
  const fleetLogs = join(homedir(), '.papercusp', 'fleet-logs');
  if (existsSync(fleetLogs)) cpSync(fleetLogs, join(evidenceDir, 'native-fleet-logs'), { recursive: true });
  const owners = new Set<string>(sessionRows.map(row => String(row.coord_owner_id)));
  for (const row of taskRows) if (typeof row.detail?.coordOwnerId === 'string') owners.add(row.detail.coordOwnerId);
  for (const owner of owners) {
    assert.match(owner, /^su-[a-zA-Z0-9-]+$/);
    const directory = join(evidenceDir, 'native-' + owner);
    mkdirSync(directory, { recursive: true });
    const session = sessionRows.find(row => row.coord_owner_id === owner);
    const task = taskRows.find(row => row.detail?.coordOwnerId === owner);
    retainIsolatedNativeTaskDiagnostics(directory, { ownerId: owner, session, task }, {
      boot: psuLaunchLogPath(owner, { home: process.env.HOME }) ?? undefined,
      'host-events': eventLogPathForOwner(owner),
    }, session ? codexHomeForSessionKey(session.id) : undefined);
  }
}

async function observeWorkStates(observer: string) {
  const states = await sql<{ feature_id: string; status: string; assignee: string | null }[]>`
    SELECT feature_id, status, taken_by AS assignee FROM harness_shared.work_items
    WHERE workspace_id=${workspace} AND feature_id=ANY(${ids})`;
  assert.equal(states.length, ids.length);
  stateObservations.push({ observer, states });
  for (const row of states) {
    if (['done','resolved','passed'].includes(row.status)
      && !workEvents.some(event => event.type === 'completion-observed' && event.id === row.feature_id)) {
      workEvents.push({ sequence: workEvents.length, type: 'completion-observed', id: row.feature_id, owner: row.assignee });
    }
  }
  for (const row of states) {
    if (row.status !== 'wip' || !row.assignee
      || workEvents.some(event => event.type === 'claim-observed' && event.id === row.feature_id)) continue;
    if (row.feature_id === ids[2]) {
      assert.ok(states.some(first => first.feature_id === ids[0] && ['done','resolved','passed'].includes(first.status)),
        'Dependent task was claimed before its blocker completed: ' + JSON.stringify(states));
    }
    workEvents.push({ sequence: workEvents.length, type: 'claim-observed', id: row.feature_id, owner: row.assignee });
  }
  writeFileSync(join(evidenceDir, 'outside-native-work-order.json'), JSON.stringify({ workEvents, stateObservations }));
  return states;
}

async function leaderCall(name: string, args: Record<string, unknown>) {
  assert.ok(client);
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  leaderCalls.push({ tool: name, args, result });
  writeFileSync(join(evidenceDir, 'outside-native-leader-calls.json'), JSON.stringify(leaderCalls));
  assert.notEqual(result.isError, true, JSON.stringify(result));
  for (const content of Array.isArray(result.content) ? result.content : []) {
    const value = content.type === 'text' ? decoded(content.text) : null;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value) {
      assert.notEqual(value.ok, false, JSON.stringify(result));
    }
  }
  return result;
}

async function createLeaderWorkItem(title: string) {
  await leaderCall('work_items:create', { kind: 'task', title, harness: workspace,
    assign_to: 'self', state: 'wip', changeKinds: ['no-code-change'] });
  const rows = await sql<{ feature_id: string; plan_ref: string | null; assignee: string | null; status: string }[]>`
    SELECT feature_id, payload->>'externalPlanRef' AS plan_ref, taken_by AS assignee, status
    FROM harness_shared.work_items WHERE workspace_id=${workspace} AND harness_slug=${workspace} AND title=${title}`;
  assert.equal(rows.length, 1, 'Leader create must produce exactly one canonical row: ' + title);
  assert.equal(rows[0].plan_ref, reference, 'Leader-created work must inherit the session reference without an explicit argument');
  assert.equal(rows[0].assignee, leader);
  assert.equal(rows[0].status, 'wip');
  return rows[0].feature_id;
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { /* Retain plain text. */ }
  if (value.startsWith('format: toon\n')) {
    try { return decode(value.slice('format: toon\n'.length), 'toon'); } catch { /* Retain exact bytes. */ }
  }
  return value;
}

function leaves(value: unknown): string[] {
  const parsed = decoded(value);
  if (typeof parsed === 'string') return [parsed];
  if (Array.isArray(parsed)) return parsed.flatMap(leaves);
  return parsed && typeof parsed === 'object' ? Object.values(parsed).flatMap(leaves) : [];
}

function hasReference(value: unknown): boolean {
  const parsed = decoded(value);
  if (Array.isArray(parsed)) return parsed.some(hasReference);
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.entries(parsed).some(([key, entry]) =>
    (['planRef','outsidePlanRef'].includes(key) && entry === reference) || hasReference(entry));
}

function scriptedCall(body: Record<string, any>, owner: string, round: number, name: string, args: unknown) {
  const offered: any[] = [];
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace') offered.push(...(tool.tools ?? []).map((t: any) => ({ ...t, namespace: tool.name })));
    else offered.push(tool);
  }
  const direct = offered.find(t => t.type === 'function' && /(?:^|__)tools_invoke$/.test(t.name));
  const exec = offered.find(t => t.type === 'custom' && t.name === 'exec' && t.namespace === 'functions');
  const tool = direct ?? exec;
  assert.ok(tool, 'Native client did not offer the real MCP invocation tool');
  const input = { name, args };
  const call = { type: tool.type === 'custom' ? 'custom_tool_call' : 'function_call',
    id: 'fc_outside_' + round, call_id: 'call_outside_' + round, name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}), status: 'completed',
    ...(tool === exec ? { input: `text(await tools.mcp__papercusp_su__tools_invoke(${JSON.stringify(input)}));` }
      : { arguments: JSON.stringify(input) }) };
  callLog.push({ owner, tool: name, args });
  const response = { ...codexCliResponsesBody({ model: body.model, text: '', inputTokens: 100, outputTokens: 10 }), output: [call] };
  return ['response.output_item.added', 'response.output_item.done', 'response.completed'].map(type =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(type === 'response.completed'
      ? { response } : { output_index: 0, item: call }) })}\n\n`).join('') + 'data: [DONE]\n\n';
}

const listener = createServer((req, res) => {
  void (async () => {
    if (serveCurrentSuNativeModelDiscovery(req, res)) return;
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthyAccounts: 2, dispatchBudget: 2, models: [] })); return;
    }
    assert.ok(req.url?.endsWith('/responses'), 'Unexpected local model request: ' + req.url);
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes);
    const owner = String(req.headers['x-papercusp-owner'] ?? '');
    assert.match(owner, /^su-/);
    const round = rounds.get(owner) ?? 0;
    rounds.set(owner, round + 1);
    assert.ok(round < 50, 'Native tool loop exceeded its finite acceptance budget');
    const states = await observeWorkStates(owner);
    let name: string | null = null, args: Record<string, unknown> = {};
    if (round === 0) name = 'coord:whoami';
    else {
      const held = states.filter(row => row.assignee === owner && row.status === 'wip');
      if (held.length) {
        const id = String(held[0].feature_id);
        assert.ok(ids.includes(id), 'Native client claimed unrelated work');
        name = 'work_items:complete';
        args = { id, harness: workspace, state: 'done', assumptions: 'none', completion: {
          summary: 'Verified this disposable outside assignment record.', testsRun: 'Read the canonical item and verify custody.',
          testResult: 'The assigned item retained its exact outside reference.', verifiedHow: 'manual', filesChanged: [],
          verification: { workOutcome: 'verified-existing' },
        } };
        const item = await getWorkItem(id, workspace);
        const blocker = readBlockerResolution(item?.payload);
        if (blocker.status === 'recorded') {
          assert.equal((await getWorkItem(ids[0], workspace))?.state, 'done');
          const evidenceRefs = [{ kind: 'work-item', ref: workspace + '#' + ids[0] },
            { kind: 'event', ref: 'work-item:done:' + ids[0] }];
          args.blockerDecision = { schemaVersion: 1, idempotencyKey: 'outside-native-dependency-resolved',
            priorRevision: blocker.current.revision, disposition: 'self_resolve',
            symptom: 'The dependent piece required the first piece to complete.',
            investigation: [{ action: 'Read the canonical prerequisite after native execution.',
              outcome: 'Its state is done, so the authored dependency is satisfied.', evidenceRefs }],
            attempts: [], evidenceRefs, verification: { outcome: 'The first piece completed before this piece was claimed.', evidenceRefs } };
        }
      } else {
        const complete = await sql`SELECT feature_id FROM harness_shared.work_items
          WHERE workspace_id=${workspace} AND feature_id=ANY(${ids}) AND status IN ('done','resolved','closed','passed')`;
        if (complete.length < ids.length) { name = 'scheduler:get_next'; args = { harness: workspace }; }
      }
    }
    modelRequests.push({ owner, round, tool: name, body });
    writeFileSync(join(evidenceDir, 'outside-native-model-requests.json'), JSON.stringify(modelRequests));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(name ? scriptedCall(body, owner, round, name, args)
      : codexCliResponsesCompletionSse(codexCliResponsesBody({ model: body.model,
        text: 'The assigned outside work is complete.', inputTokens: 100, outputTokens: 10 })));
  })().catch(error => { console.error('OUTSIDE_NATIVE_PROTOCOL_ERROR', error); res.writeHead(500); res.end(String(error)); });
});

async function main() {
  assert.ok(Object.values(networkInterfaces()).flat().every(address => address?.internal), 'Private network namespace required');
  assert.match(workspace, /^test-runtime-/);
  assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(process.env.PAPERCUSP_DBOS_ENABLE, '0');
  // PostgreSQL, this worker and the API share one loopback-only namespace.
  const pgHost = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!).hostname;
  const addresses = await lookup(pgHost, { all: true });
  assert.ok(addresses.length && addresses.every(row => row.address === '127.0.0.1' || row.address === '::1'),
    'Private PostgreSQL must resolve only to loopback: ' + JSON.stringify(addresses));
  assert.ok(evidenceDir, 'Retained evidence directory must reach the private child');
  assert.ok(isAbsolute(bundle.path) && basename(bundle.path) === 'hono-host.mjs', 'Prepared API must have its canonical artifact path');
  const sourceFence = JSON.parse(readFileSync(bundle.path + '.snapshot-fence.json', 'utf8'));
  assert.match(sourceFence.sha, /^[a-f0-9]{7,64}$/);
  assert.ok(sourceFence.checked > 0);
  assert.deepEqual(sourceFence.mismatches, [], 'Prepared API must retain its passing source-snapshot fence');
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
  const verifyBundle = () => assert.equal(createHash('sha256').update(readFileSync(bundle.path)).digest('hex'), bundle.sha256,
    'Prepared API bytes changed after snapshot preparation');
  verifyBundle();
  mkdirSync(evidenceDir, { recursive: true });
  await listener.listen(0, '127.0.0.1');
  await new Promise<void>(done => listener.listening ? done() : listener.once('listening', done));
  const port = (listener.address() as { port: number }).port;
  process.env.PAPERCUSP_GATEWAY_PORT = String(port);
  process.env.PAPERCUSP_MCP_PROXY = '0';
  await prepareCurrentSuNativeScenario(workspace);
  const registry = await loadHarnessRegistry(workspace, { fresh: true });
  assert.ok(registry.projects.some(project => project.slug === workspace), 'Private home harness is missing');
  await saveHarnessRegistry({ ...registry, projects: registry.projects.map(project =>
    project.slug === workspace ? { ...project, path: root } : project) }, workspace);
  const scope = await resolveHarnessPlansDir(workspace, { workspaceId: workspace });
  assert.equal(scope.harnessSlug, workspace);
  assert.equal(scope.workspaceId, workspace);
  console.log('OUTSIDE_FLEET_RUNTIME_PREFLIGHT_PASS ' + JSON.stringify({ pgHost, addresses, workspace }));
  await sql`DELETE FROM harness_shared.harness_plans WHERE template='rubric'`;
  assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans`).length, 0);
  const stray = await createWorkItem({ workspaceId: workspace, harness: workspace, kind: 'task', title: 'Unrelated fourth item' });
  const env = privateBundleRuntimeEnv(process.env);
  host = spawn(process.execPath, [bundle.path], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let hostOutput = '';
  for (const stream of [host.stdout!, host.stderr!]) stream.on('data', chunk => {
    hostOutput += chunk; writeFileSync(join(evidenceDir, 'outside-native-host.log'), hostOutput);
  });
  const headers = { origin: base, authorization: 'Bearer ' + readSuperuserToken() };
  const health = await waitForPrivateOperator({ host, base, headers, evidenceDir, environment: env, requireBuildIdentity: true });
  verifyBundle();
  assert.equal(health.sha, sourceFence.sha, 'Running API must report the retained source snapshot identity');
  writeFileSync(join(evidenceDir, 'outside-native-prepared-api.json'), JSON.stringify({ bundle, sourceFence, health }));
  const bootstrap = await fetch(base + '/api/agent-mcp/console/bootstrap-su', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ agent: 'codex', workspace, owner_id: leader, plan_ref: reference,
      model: 'gpt-6-luna:max', model_source: 'explicit', account: 'auto', cwd: root,
      context_size: 'trimmed', bootstrap_idempotency_key: 'outside-native-leader' }) });
  const bootstrapped = await bootstrap.json() as Record<string, any>;
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrapped));
  assert.equal(bootstrapped.outsidePlanRef, reference);
  client = new Client({ name: 'outside-native-acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/api/mcp?superuser=1&client=' + leader
    + '&workspace=' + workspace + '&harness=' + workspace, base), { requestInit: { headers } }));
  await client.listTools();
  const leaderItem = await createLeaderWorkItem('Leader coordinates the physical outside assignment');
  for (const title of ['First independent item', 'Second independent item', 'Dependent third item']) {
    ids.push(await createLeaderWorkItem(title));
  }
  // The real leader uses the maintained link door: tasks are issue-family rows
  // with bare IDs, not feature-family harness-qualified references.
  const dependencyEvidence = [{ kind: 'work-item', ref: workspace + '#' + ids[0] }];
  assert.equal((await getWorkItem(ids[0], workspace))?.assignee, leader);
  const dependencyDecision = { schemaVersion: 1, idempotencyKey: 'outside-native-authored-dependency', disposition: 'defer',
      symptom: 'The third piece requires the first piece completion in acceptance section 7.3.',
      investigation: [{ action: 'Read the newly registered prerequisite before linking the dependent piece.',
        outcome: 'The first piece is held for delegation and its completion is a genuine prerequisite of the third piece.',
        evidenceRefs: dependencyEvidence }], attempts: [], evidenceRefs: dependencyEvidence,
      deferral: { reason: 'external-dependency', reasonEvidenceRefs: dependencyEvidence,
        responsibleParty: leader, nextAction: 'Launch the two native members and complete the first piece before the dependent piece.',
        recheckRef: { kind: 'event', ref: 'work-item:done:' + ids[0] } } };
  await leaderCall('work_items:link', { id: ids[0], rel: 'blocks', target_id: ids[2], harness: workspace,
    blockerDecision: dependencyDecision });
  // Release the dependent while its prerequisite still has the leader as its
  // accountable custodian; only then delegate the independent prerequisites.
  for (const id of [...ids].reverse()) {
    const blocker = readBlockerResolution((await getWorkItem(id, workspace))?.payload);
    // Explicit assignment registers admission; the leader authors the edge
    // while holding its dependent, then releases that exact set for members.
    await leaderCall('work_items:release', { id, harness: workspace,
      reason: 'Delegate this explicitly registered piece to the exact outside-plan fleet.',
      ...(blocker.status === 'recorded' ? { blockerDecision: { ...dependencyDecision,
        priorRevision: blocker.current.revision, idempotencyKey: 'outside-native-dependency-delegated' } } : {}) });
    assert.equal((await getWorkItem(id, workspace))?.assignee, null);
  }
  const frontier = await preflightFleetWorkItems({ workspaceId: workspace, harness: workspace,
    fleetSlug: fleet, workItems: ids, requestedSeats: 3 });
  writeFileSync(join(evidenceDir, 'outside-native-frontier.json'), JSON.stringify(frontier));
  assert.equal(frontier.executableWidth, 2, 'Fixture must expose two ready tasks before any member process opens');
  assert.equal(frontier.ready, false);
  assert.equal(frontier.reason, 'insufficient-executable-width');
  const launchArgs = { name: fleet, workItems: ids, harness: workspace, count: 2, agent: 'codex', model: 'gpt-6-luna',
    effort: 'max', account: 'auto', headless: true, leader: 'caller', supervise: false, overrideCapacityClamp: true };
  // This request inherits the leader's persisted opaque label. Its dependency
  // frontier has only two ready rows, despite containing three IDs.
  const refused = await client.callTool({ name: 'fleet:launch-on-plan', arguments: { ...launchArgs, count: 3 } });
  writeFileSync(join(evidenceDir, 'outside-native-refusal.json'), JSON.stringify(refused));
  assert.ok(JSON.stringify(refused).includes('admission_refused'), JSON.stringify(refused));
  assert.equal(await getFleet(workspace, fleet), null);
  assert.equal((await sql`SELECT 1 FROM harness_shared.adv_sessions WHERE workspace_id=${workspace}`).length, 1);
  const launch = await client.callTool({ name: 'fleet:launch-on-plan', arguments: launchArgs }, undefined,
  { timeout: 240_000 });
  writeFileSync(join(evidenceDir, 'outside-native-launch.json'), JSON.stringify(launch));
  assert.notEqual(launch.isError, true, JSON.stringify(launch));
  const started = Date.now();
  const diagnosticStages = [10_000, 30_000, 60_000];
  let nextDiagnostic = 0;
  while (Date.now() - started < 180_000) {
    if (nextDiagnostic < diagnosticStages.length && Date.now() - started >= diagnosticStages[nextDiagnostic]) {
      await retainNativeDiagnostics();
      nextDiagnostic++;
    }
    if ((await Promise.all(ids.map(id => getWorkItem(id, workspace)))).every(item => item?.state === 'done')) break;
    await delay(250);
  }
  assert.deepEqual((await Promise.all(ids.map(id => getWorkItem(id, workspace)))).map(item => item?.state), ['done','done','done'],
    JSON.stringify({ launch, rounds: [...rounds], callLog, hostOutput }));
  await observeWorkStates('final-piece-verification');
  assert.deepEqual(new Set(workEvents.filter(event => event.type === 'claim-observed').map(event => event.id)), new Set(ids));
  assert.deepEqual(new Set(workEvents.filter(event => event.type === 'completion-observed').map(event => event.id)), new Set(ids));
  assert.ok(workEvents.find(event => event.type === 'completion-observed' && event.id === ids[0])!.sequence
    < workEvents.find(event => event.type === 'claim-observed' && event.id === ids[2])!.sequence);
  assert.equal((await getWorkItem(leaderItem, workspace))?.assignee, leader, 'Leader must retain its own item through piece execution');
  await leaderCall('work_items:complete', { id: leaderItem, harness: workspace, state: 'done', assumptions: 'none',
    completion: { summary: 'Coordinated the three disposable outside assignment pieces.',
      testsRun: 'Read canonical piece state and the observed native claim/completion sequence.',
      testResult: 'PASS: three pieces completed with the dependent claim after its blocker completion.',
      verifiedHow: 'manual', filesChanged: [], verification: { workOutcome: 'verified-existing' } } });
  assert.equal((await getWorkItem(leaderItem, workspace))?.state, 'done', 'Leader completion must be terminal');
  const sessions = await sql`SELECT coord_owner_id, outside_plan_ref, launch_argv FROM harness_shared.adv_sessions
    WHERE workspace_id=${workspace} AND coord_owner_id<>${leader}`;
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session.outside_plan_ref, reference);
    assert.ok(rounds.has(session.coord_owner_id));
  }
  assert.ok(!(await getWorkItem(stray.id, workspace))?.assignee);
  assert.equal((await sql`SELECT 1 FROM harness_shared.harness_plans`).length, 0);
  assert.ok(callLog.every(call => !call.tool.startsWith('plans:')));
  for (const session of sessions) assert.ok(callLog.some(call => call.owner === session.coord_owner_id && call.tool === 'scheduler:get_next'));
  const briefs: Record<string, unknown> = {};
  for (const name of ['fleet:status', 'fleet:leader-brief', 'fleet:assignments']) {
    briefs[name] = await client.callTool({ name, arguments: { fleet } });
    assert.ok(hasReference(briefs[name]), name + ' lost the full outside reference');
  }
  const invocations = await sql`SELECT tool_name, args_json, status, coord_owner_id FROM harness_shared.tool_invocations
    WHERE workspace_id=${workspace} AND coord_owner_id=ANY(${[leader, ...sessions.map(row => row.coord_owner_id)]})`;
  const planCalls = invocations.filter(row => /^plans:/.test(row.tool_name));
  assert.deepEqual(planCalls, [], 'A native member invoked an internal-plan tool');
  const ownerRequests = invocations.filter(row => ['coord:ask-owner','chat:ask_choice'].includes(row.tool_name)
    || (row.tool_name === 'coord:send' && leaves(row.args_json).includes('human')));
  const traffic: Array<{ surface: string; owner?: string; text: string }> = [];
  for (const request of modelRequests) {
    const input = (request.body as Record<string, any>).input;
    for (const item of Array.isArray(input) ? input : []) {
      if (item.role === 'user' || /(?:function|custom_tool)_call_output/.test(item.type ?? '')) {
        traffic.push(...leaves(item.content ?? item.output ?? item).map(text => ({
          surface: item.role === 'user' ? 'delivered-user-input' : 'delivered-tool-output', owner: request.owner, text,
        })));
      }
    }
  }
  traffic.push(...leaderCalls.flatMap(call => leaves(call.result).map(text => ({
    surface: 'delivered-leader-tool-output', owner: leader, text,
  }))));
  traffic.push(...leaves(briefs).map(text => ({ surface: 'post-drain-fleet-brief', text })));
  const planNudge = /(?:^|\n)\s*(?:[-*]\s*)?(?:(?:please|you must|you need to)\s+)?(?:create|register|bind|activate|start)\s+(?:an?\s+)?(?:(?:internal|papercusp|native)\s+)?plan\b/i;
  assert.ok(planNudge.test('Please create an internal plan before continuing.'));
  assert.ok(!planNudge.test('Do not create an internal plan.'));
  const nudges = traffic.filter(row => planNudge.test(row.text));
  assert.deepEqual(nudges, [], 'Member-facing traffic requested an internal plan');
  assert.deepEqual(ownerRequests, [], 'A native member requested an owner action');
  assert.ok(traffic.some(row => row.surface === 'delivered-user-input'));
  assert.ok(traffic.some(row => row.surface === 'delivered-tool-output'));
  const measuredTraffic = { observed: ['native kickoff/user input including delivered injections', 'native returned tool output',
    'member tool invocation ledger', 'post-drain status/leader brief/assignments'],
    notObserved: ['an independently forced mid-task wake', 'an owner-authored follow-up conversation'],
    traffic, invocations, ownerRequests, planNudges: nudges };
  writeFileSync(join(evidenceDir, 'outside-native-traffic.json'), JSON.stringify(measuredTraffic));
  const ledger = await sql`SELECT task_id FROM harness_shared.task_ledger WHERE workspace_id=${workspace}
    AND detail->>'coordOwnerId'=ANY(${sessions.map(row => row.coord_owner_id)}) AND ended_at IS NULL`;
  tasks.push(...ledger.map(row => String(row.task_id)));
  const receipt = { ids, leaderItem, leaderItemState: (await getWorkItem(leaderItem, workspace))?.state,
    workEvents, leaderCallsEvidence: 'outside-native-leader-calls.json', workOrderEvidence: 'outside-native-work-order.json',
    stray: stray.id, planRef: reference, members: sessions.map(row => row.coord_owner_id),
    build: health, bundleSha256: bundle.sha256, modelRequests: modelRequests.length,
    toolCalls: callLog, providerForwarding: false, networkInterfaces: Object.keys(networkInterfaces()),
    observedTrafficEntries: traffic.length, requestedOwnerActions: ownerRequests.length,
    planNudges: nudges.length, trafficEvidence: 'outside-native-traffic.json' };
  writeFileSync(join(evidenceDir, 'outside-native-receipt.json'), JSON.stringify(receipt));
  console.log('OUTSIDE_FLEET_NATIVE_VERIFIED ' + JSON.stringify(receipt));
}

main().finally(async () => {
  // Native startup can fail before session registration or a first model call.
  // Preserve its own boot/config evidence before with-test-pg removes the home.
  let retentionFailure: unknown;
  try { await retainNativeDiagnostics(); }
  catch (error) {
    retentionFailure = error;
    writeFileSync(join(evidenceDir, 'outside-native-retention-error.txt'), String(error));
  }
  const active = await sql`SELECT task_id FROM harness_shared.task_ledger WHERE workspace_id=${workspace}
    AND detail->>'coordOwnerId'<>${leader} AND ended_at IS NULL`.catch(() => []);
  tasks.push(...active.map(row => String(row.task_id)));
  if (client) for (const taskId of tasks) await client.callTool({ name: 'processes:kill', arguments: { taskId } }).catch(console.error);
  await client?.close();
  if (host) await stopPrivateOperatorHost(host);
  listener.closeAllConnections(); await new Promise<void>(done => listener.close(() => done()));
  await _resetForTests();
  if (retentionFailure) throw retentionFailure;
}).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
