/** P-009: drive the loaded staging park resolver with private, owned fixtures. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { executeOperationalRun, parseOperationalEvidenceArtifact, type OperationalEvidenceArtifact } from '../agent-tools/testing/record-run';
import { updateExternalBlockerHistory } from '../external-blockers';
import { DECISION_REVIEW_CASCADE_FLAVOR } from './decision-review';
import { readPickupHostView } from '../events/await/pickup-sweep';

const root = resolve(import.meta.dirname, '../../../..');
const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
const workspace = 'papercusp-workspace';
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
const flowAssertion = (flow: string, evidence: string): OperationalEvidenceArtifact['assertions'][number] => ({
  id: `loaded-staging-${flow}-clears-blocker-and-records-wake`, passed: true, evidence,
});

function call(name: string, args: Record<string, unknown>, origin: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_CONTEXT_TIER: 'full' };
  delete env.PAPERCUSP_SCRATCH_ROOT;
  const result = spawnSync(process.execPath, [resolve(root, 'apps/operator/scripts/ptool.mjs'),
    'tools:invoke', `--url=${origin}`, '--json', '-'], {
    cwd: root, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    input: JSON.stringify({ name, args: { ...args, payloadTier: 'full' } }),
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value.ok, JSON.stringify(value)).not.toBe(false);
  expect(value.error, JSON.stringify(value)).toBeUndefined();
  return value;
}

function rows(sql: string, origin: string) {
  return call('dev:pg_query', { sql, maxRows: 10, timeoutMs: 15_000,
    allowUnscoped: false, allowUnboundedJsonSearch: false }, origin).rows as Array<Record<string, any>>;
}

function mutate(sql: string, origin: string, expectedRows: number) {
  const value = call('dev:pg_mutate', { sql, expectedRows, maxAffectedRows: 2,
    reason: 'P-009 live acceptance: private fixture owned by the executing session; no routed consult or peer dispatch',
    timeoutMs: 15_000 }, origin);
  expect(value.committed).toBe(true);
  return value;
}

async function recorderPreflight() {
  const measured = await executeOperationalRun({
    filePath: 'packages/operator-core/lib/consult/park.live.e2e.test.ts',
    name: 'Native park recorder preflight (no native subject)', framework: 'operational',
    command: ['native-park-recorder-preflight'], runtimeUnits: [],
    run: async () => ({ exitCode: 0, summary: 'Recorder reached the assertion callback.',
      assertions: [{ id: 'recorder-callback', passed: true, evidence: 'No subject was launched.' }] }),
  }, { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root });
  console.info('CBP_NATIVE_RECORDER_PREFLIGHT', JSON.stringify(measured));
  expect(measured, JSON.stringify(measured)).toMatchObject({ ok: true, status: 'pass' });
}

function requireParkingRuntimeWitnesses(units: string[], apiUnit: string) {
  for (const unit of [apiUnit, 'bg-host']) {
    if (!units.includes(unit)) throw new Error(`Parking acceptance requires a recorder runtime witness for ${unit}`);
  }
}

function requireParkingSourceContainment(
  acceptedSource: { matches?: boolean; runtimeContainment?: Record<string, boolean | null> } | undefined,
  runtimes: string[],
  path: string,
) {
  if (acceptedSource?.matches !== true) throw new Error(`Parking source bytes are unverified: ${path}`);
  for (const runtime of runtimes) {
    if (acceptedSource.runtimeContainment?.[runtime] !== true) {
      throw new Error(`Parking source containment is unverified for ${runtime}: ${path}`);
    }
  }
}

describe('native parking runtime prerequisites', () => {
  it('rejects the historical API-only recorder profile before launching a subject', () => {
    expect(() => requireParkingRuntimeWitnesses(['hono-host:3170'], 'hono-host:3170')).toThrow('bg-host');
    expect(() => requireParkingRuntimeWitnesses(['hono-host:3170', 'bg-host'], 'hono-host:3170')).not.toThrow();
  });

  it.each([null, false, undefined])('rejects API containment when background containment is %s', bg => {
    const source = { matches: true, runtimeContainment: { 'staging-operator': true, 'bg-host': bg } };
    expect(() => requireParkingSourceContainment(source as never, ['bg-host'], 'park-delivery-prod.ts'))
      .toThrow('bg-host');
  });

  it('accepts matching API and background source while rejecting changed bytes', () => {
    const source = { matches: true, runtimeContainment: { 'staging-operator': true, 'bg-host': true } };
    expect(() => requireParkingSourceContainment(source, ['staging-operator', 'bg-host'], 'park-prod.ts'))
      .not.toThrow();
    expect(() => requireParkingSourceContainment({ ...source, matches: false }, ['bg-host'], 'park-prod.ts'))
      .toThrow('source bytes');
  });
});

describe.skipIf(!profilePath)('consult-backed parking on the loaded staging operator', () => {
  it('native recorder preflight writes a receipt before any native subject launches', recorderPreflight, 120_000);

  it('public park door resumes a real native subject after deadline and alternative verdicts', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    const origin = String(profile.origin);
    expect(['http://127.0.0.1:3170', 'http://127.0.0.1:3070']).toContain(origin);
    const runtime = origin.endsWith(':3170') ? 'staging-operator' : 'release-operator';
    requireParkingRuntimeWitnesses(profile.runtimeUnits, `hono-host:${new URL(origin).port}`);
    await recorderPreflight();
    const sources = [
      { path: 'packages/operator-core/lib/consult/park-door.ts', runtimes: [runtime] },
      { path: 'packages/operator-core/lib/consult/park-prod.ts', runtimes: [runtime, 'bg-host'] },
      { path: 'packages/operator-core/lib/consult/park-delivery-prod.ts', runtimes: ['bg-host'] },
      { path: 'packages/operator-core/lib/events/await/wake-executor.ts', runtimes: ['bg-host'] },
      { path: 'packages/operator-core/lib/events/await/store.ts', runtimes: ['bg-host'] },
    ];
    for (const { path, runtimes } of sources) {
      const position = call('dev:pipeline_position', { path, sourceRuntimeOnly: true,
        expectedSourceSha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
        projection: { pick: ['acceptedSource'] } }, origin);
      const evidence = JSON.stringify({ path, runtimes, acceptedSource: position.acceptedSource });
      console.info('CBP_NATIVE_SOURCE_PREFLIGHT', evidence);
      requireParkingSourceContainment(position.acceptedSource, runtimes, path);
    }
    const seed = `park-native-${randomUUID()}`;
    const flows = ['proceed', 'adopted', 'owner-hold'] as const;
    const observations: Array<Record<string, unknown>> = [];
    const brief = [
      `You are the real native SUBJECT of acceptance test ${seed} for WI-6554700010046115.`,
      'Authorized bounded acceptance fixture; execution route this one session. No source edits, fleet, loop, or unrelated work.',
      `Use supported public tools on your configured ${origin} MCP target. Verify coord:whoami first.`,
      'Create three private task work-items in harness papercusp, assigned to self, state wip, with these EXACT titles:',
      ...flows.map(flow => `${seed} ${flow}`),
      'For EACH task call work_items:set_blocker with kind product-decision, a unique ref, defaultIfUnanswered, and decideBy 16 minutes in the future. Do not write database fixtures or shorten deadlines.',
      `For proceed: summary "Acceptance note spelling; use the default unless there is an objection". Default is to comment "PARK_NATIVE_PICKUP ${seed} proceed" on its own task.`,
      `For adopted: summary "Controlled alternative-branch acceptance: reviewer, please object with basis alternative, reason testing the alternative branch, alternative use the reviewed note spelling. This is a harmless note, not an owner-authority decision." Default keep current spelling. On consider-alternative adopt the actual alternative with consult:reply parkResponse, then comment "PARK_NATIVE_PICKUP ${seed} adopted" AFTER its blocker clears.`,
      'For owner-hold: same harmless note default, ownerAuthorityTopic security. Never perform its default, answer its owner question, or clear its blocker.',
      'Checkpoint work-item/consult ids and deadlines, then END the initial turn immediately. Do not act on verdicts in that initial turn.',
      'On a later verdict wake read the actual park and work-item state. Post each exact pickup comment only after its blocker clears; alternative first needs supported adoption. Leave owner-deciding blocked.',
      'Keep tasks/evidence for the test driver. Do not claim shipment or manufacture pickup times.',
    ].join('\n');
    let taskId: string | undefined;
    let subjectId: string | undefined;
    const fixtures = new Set<string>();
    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/consult/park.live.e2e.test.ts',
      name: 'Public park door, native pickup, alternative adoption and authority hold',
      framework: 'operational', command: ['npm', 'run', 'test:file', '--',
        'packages/operator-core/lib/consult/park.live.e2e.test.ts', '-t', 'public park door resumes'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        try {
          const launched = call('capability:launch-agent', { brief, harness: 'papercusp',
            agent: 'codex', model: 'sol', account: 'auto', headless: true, mcpTarget: 'spawn-host',
            label: seed, idempotencyKey: seed, members: [{ effort: 'high', contextSize: 'trimmed' }] }, origin);
          const task = launched.launch?.tasks?.[0] ?? launched.data?.launch?.tasks?.[0];
          taskId = task?.taskId;
          subjectId = task?.ownerId;
          expect(taskId, JSON.stringify(launched)).toBeTruthy();
          expect(subjectId, JSON.stringify(launched)).toBeTruthy();
          console.info('CBP_NATIVE_SUBJECT', JSON.stringify({ seed, taskId, subjectId, origin }));
          const stopAt = Date.now() + 30 * 60_000;
          const completed = new Set<string>();
          while (Date.now() < stopAt && completed.size < flows.length) {
            for (const flow of flows) {
              if (completed.has(flow)) continue;
              const [fixture] = rows(`SELECT feature_id, payload FROM harness_shared.work_items
                WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp'
                  AND title = ${literal(`${seed} ${flow}`)}`, origin);
              if (!fixture) continue;
              fixtures.add(fixture.feature_id);
              const blocker = fixture.payload.externalBlockers?.find((b: { ref: string }) => b.ref?.startsWith('consult:'));
              if (!blocker) continue;
              const consultId = blocker.ref.slice('consult:'.length);
              const [park] = rows(`SELECT routing, park_state FROM harness_shared.consult_state
                WHERE workspace_id = ${literal(workspace)} AND conversation_id = ${literal(consultId)}`, origin);
              const outcomes = park?.park_state?.outcomes ?? [];
              const outcome = outcomes.at(-1);
              if (!outcome) continue;
              expect(park.routing.cascade).toMatchObject({ setterId: subjectId, workItemId: fixture.feature_id });
              if (flow === 'owner-hold') {
                expect(outcome.verdict).toBe('owner-deciding');
                expect(blocker.status).toBe('active');
                observations.push({ flow, consultId, workItemId: fixture.feature_id, outcome, blocker });
                completed.add(flow);
                continue;
              }
              const item = call('work_items:get', { id: fixture.feature_id, harness: 'papercusp', threadLimit: 10 }, origin);
              const pickup = item.results?.[0]?.threadWindow?.posts?.find((p: { author_id: string; body: string }) =>
                p.author_id === subjectId && p.body.includes(`PARK_NATIVE_PICKUP ${seed} ${flow}`));
              if (!pickup) continue;
              expect(outcome.verdict).toBe(flow);
              expect(blocker.status).toBe('cleared');
              const verdict = flow === 'adopted'
                ? outcomes.findLast((o: { verdict: string }) => o.verdict === 'consider-alternative') : outcome;
              expect(verdict).toBeDefined();
              const [delivery] = rows(`SELECT id, payload, delivered_at, turn_proof, turn_started_at
                FROM harness_shared.event_wake_deliveries
                WHERE workspace_id = 'default' AND subscriber_id = ${literal(subjectId!)}
                  AND event_key = ${literal(`consult:park-verdict:${consultId}`)} AND status = 'delivered'
                  AND payload->>'verdict' = ${literal(verdict.verdict)}
                  AND delivered_at >= ${literal(verdict.at)}::timestamptz
                ORDER BY delivered_at DESC LIMIT 1`, origin);
              if (!delivery?.turn_started_at) continue;
              const host = await readPickupHostView(subjectId!);
              const nativeStart = host?.execution?.turnStartedAt;
              const freshObserved = delivery.turn_proof === 'observed' && typeof nativeStart === 'number'
                && nativeStart >= Date.parse(delivery.delivered_at) && nativeStart <= Date.parse(pickup.created_ts);
              expect(delivery.turn_proof === 'host-attested' || freshObserved).toBe(true);
              expect(Date.parse(delivery.turn_started_at)).toBeGreaterThanOrEqual(Date.parse(verdict.at));
              expect(Date.parse(pickup.created_ts)).toBeGreaterThanOrEqual(Date.parse(delivery.turn_started_at));
              observations.push({ flow, consultId, workItemId: fixture.feature_id, verdict, outcome,
                pickup, delivery, nativeStart, taskId, subjectId });
              completed.add(flow);
            }
            console.info('CBP_NATIVE_PARK_PROGRESS', JSON.stringify({ seed, taskId, completed: [...completed] }));
            if (completed.size < flows.length) await new Promise(resolve => setTimeout(resolve, 15_000));
          }
          expect([...completed].sort(), JSON.stringify({ seed, taskId, subjectId, observations })).toEqual([...flows].sort());
          console.info('CBP_NATIVE_PARK_PROOF', JSON.stringify(observations));
          return { exitCode: 0, summary: 'Public parks produced native pickup and adoption while retaining the authority hold',
            assertions: observations.map(o => ({ id: `public-native-${o.flow}`, passed: true,
              evidence: JSON.stringify(o).slice(0, 2000) })) };
        } finally {
          console.info('CBP_NATIVE_FIXTURE_CUSTODY', JSON.stringify({ seed, taskId, subjectId, fixtures: [...fixtures] }));
          // Preserve ledger proof for grading and later disposition; stop only
          // this test's native subject. Its fixture ids remain explicitly named.
          if (taskId) call('processes:kill', { taskId }, origin);
        }
      },
    }, { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root });
    console.info('CBP_NATIVE_PARK_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 2_100_000);

  it('adopts an alternative and proceeds at a silent deadline, clearing blockers and recording verdict wakes', async () => {
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8'));
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toContain('hono-host:3170');
    const origin = profile.origin as string;
    const recordContext = { workspaceId: workspace, harnessSlug: 'papercusp', projectDir: root };
    expect(resolveAgentWorkspaceRoot(recordContext), 'Recorder must measure this committed test tree').toBe(root);
    // Validate the recorder contract before creating any live fixture. The same
    // typed builder produces the final evidence, so a malformed success result
    // fails here rather than after the two production flows have executed.
    const preflightAt = new Date().toISOString();
    parseOperationalEvidenceArtifact(Buffer.from(JSON.stringify({
      schemaVersion: 1, kind: 'operational-test-evidence', name: 'P-009 recorder contract preflight',
      framework: 'operational', command: ['npm', 'run', 'test:file'], exitCode: 0,
      startedAt: preflightAt, finishedAt: preflightAt, summary: 'Validate before live fixture writes',
      assertions: ['adopted', 'proceed'].map(flow => flowAssertion(flow, 'recorder contract preflight')),
    })));
    const owner = call('coord:whoami', {}, origin).ownerId as string;
    expect(owner).toBe(process.env.PAPERCUSP_SID);
    for (const path of ['packages/operator-core/lib/consult/park-adapters.ts',
      'packages/operator-core/lib/consult/park-prod.ts']) {
      const route = call('dev:pipeline_position', { path, testClass: 'operator-api', sourceRuntimeOnly: true,
        expectedSourceSha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
        projection: { pick: ['acceptedSource', 'currentBuildTestRoute'] } }, origin);
      expect(route.currentBuildTestRoute.readiness).toBe('ready');
      const evidence = JSON.stringify({ path, acceptedSource: route.acceptedSource });
      console.info('CBP_LIVE_SOURCE_PREFLIGHT', evidence);
      expect(route.acceptedSource.matches, evidence).toBe(true);
      expect(route.acceptedSource.runtimeContainment['staging-operator'], evidence).toBe(true);
    }

    const measured = await executeOperationalRun({
      filePath: 'packages/operator-core/lib/consult/park.live.e2e.test.ts',
      name: 'Adopt-alternative and silent-proceed through the loaded staging park resolver',
      framework: 'operational',
      command: ['npm', 'run', 'test:file', '--', 'packages/operator-core/lib/consult/park.live.e2e.test.ts'],
      runtimeUnits: profile.runtimeUnits,
      run: async () => {
        const observations: Array<Record<string, unknown>> = [];
        for (const flow of ['adopted', 'proceed'] as const) {
          const workItemId = `WI-P009-LIVE-${randomUUID()}`;
          const opened = call('coord:message-agent', { harness: 'papercusp',
            title: `Private P-009 ${flow} fixture ${workItemId}`,
            body: 'Owned live acceptance fixture. No direct addressee and no expert routing.' }, origin);
          const consultId = opened.conversation_id as string;
          expect(consultId).toBeTruthy();
          const blockerRef = `consult:${consultId}`;
          const eventKey = `consult:park-verdict:${consultId}`;
          const deadlineAt = new Date(Date.now() + (flow === 'proceed' ? -1000 : 3_600_000)).toISOString();
          const { blockers } = updateExternalBlockerHistory({}, { kind: 'human', capability: 'product-decision',
            ref: blockerRef, summary: 'Private live park acceptance', defaultIfUnanswered: 'Keep the existing name',
            decideBy: deadlineAt }, owner);
          const routing = { selection: { selected: [{ ownerId: owner }, { ownerId: `${owner}-fixture` }] },
            cascade: { flavor: DECISION_REVIEW_CASCADE_FLAVOR, workItemId, setterId: owner,
              defaultAction: 'Keep the existing name', deadlineAt, ownerAuthorityTopic: null } };
          const postId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          try {
            mutate(`INSERT INTO harness_shared.work_items
              (workspace_id, harness_slug, feature_id, item_kind, title, status, created_ts, payload, nature)
              VALUES (${literal(workspace)}, 'papercusp', ${literal(workItemId)}, 'task',
                'Private P-009 acceptance fixture', 'open', ${Date.now()},
                ${literal(JSON.stringify({ externalBlockers: blockers }))}::jsonb, 'work')`, origin, 1);
            mutate(`INSERT INTO harness_shared.consult_state
              (workspace_id, conversation_id, requester_id, responder_id, state, question, latency_contract, routing, cascade_cursor)
              VALUES (${literal(workspace)}, ${literal(consultId)}, ${literal(owner)}, NULL, 'active',
                'Private P-009 park', 'proceed', ${literal(JSON.stringify(routing))}::jsonb, 0)`, origin, 1);
            call('events:await', { event: eventKey, timeout_sec: 300, on_timeout: 'wake' }, origin);
            if (flow === 'adopted') {
              mutate(`INSERT INTO harness_shared.consult_post_meta
                (workspace_id, post_id, conversation_id, author_id, kind, stance)
                VALUES (${literal(workspace)}, ${postId}, ${literal(consultId)}, ${literal(`${owner}-fixture`)},
                  'new_fact', '{"position":"object","basis":"alternative","reason":"The old name collides","alternative":"Use the reviewed name"}'::jsonb)`, origin, 1);
            }
            // Requester maintenance triggers the same production resolver as a
            // reply/expiry. The proceed fixture has no reviewer replies at all;
            // the isolated integration suite separately exercises the sweep.
            call('consult:reply', { conversation_id: consultId, kind: 'new_fact',
              body: 'Private live acceptance checkpoint', ...(flow === 'adopted'
                ? { parkResponse: { kind: 'adopt', text: 'Use the reviewed name', objectionId: String(postId) } } : {}) }, origin);
            const [state] = rows(`SELECT park_state FROM harness_shared.consult_state
              WHERE workspace_id = ${literal(workspace)} AND conversation_id = ${literal(consultId)}`, origin);
            expect(state.park_state.outcomes.at(-1).verdict).toBe(flow);
            const [item] = rows(`SELECT payload FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp' AND feature_id = ${literal(workItemId)}`, origin);
            expect(item.payload.externalBlockers.find((b: { ref: string }) => b.ref === blockerRef).status).toBe('cleared');
            const [wake] = rows(`SELECT fired_at, fired_payload FROM harness_shared.event_awaits
              WHERE workspace_id = 'default' AND subscriber_id = ${literal(owner)}
                AND event_key = ${literal(eventKey)} ORDER BY id DESC LIMIT 1`, origin);
            expect(wake, `Verdict await ${eventKey} in the event corpus`).toBeDefined();
            expect(wake.fired_at).toBeTruthy();
            expect(wake.fired_payload).toMatchObject({ verdict: flow, workItemId, recordedAs: 'peer-review' });
            observations.push({ flow, consultId, workItemId, outcome: state.park_state.outcomes.at(-1), wake: wake.fired_payload });
          } finally {
            call('consult:close', { conversation_id: consultId, outcome: 'cant_help',
              reason: 'Private P-009 acceptance fixture finished; observations retained in the native test log' }, origin);
            const owned = rows(`SELECT feature_id FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp'
                AND feature_id = ${literal(workItemId)} AND title = 'Private P-009 acceptance fixture'`, origin);
            if (owned.length === 1) mutate(`DELETE FROM harness_shared.work_items
              WHERE workspace_id = ${literal(workspace)} AND harness_slug = 'papercusp'
                AND feature_id = ${literal(workItemId)} AND title = 'Private P-009 acceptance fixture'`, origin, 1);
          }
        }
        console.info('CBP_LIVE_PARK_PROOF', JSON.stringify(observations));
        return { exitCode: 0, summary: 'Both private park flows resolved through staging and fired the executing session verdict await',
          assertions: observations.map(o => flowAssertion(String(o.flow), JSON.stringify(o).slice(0, 2000))) };
      },
    }, recordContext);
    console.info('CBP_LIVE_PARK_RUN', JSON.stringify(measured));
    expect(measured).toMatchObject({ ok: true, status: 'pass', runtimeEnvironmentMeasured: true });
  }, 900_000);
});
