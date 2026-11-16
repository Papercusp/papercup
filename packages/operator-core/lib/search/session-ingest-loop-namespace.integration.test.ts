import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const sources = [
  'packages/operator-core/lib/search/session-ingest.ts',
  'packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts',
  'packages/operator-core/lib/agent-tools/activity/lifecycle-markers.ts',
];

it('binds scoped enrollment through current-build ingest and both typed completion readers in a private runtime', () => {
  const hashes = Object.fromEntries(sources.map(path => [path,
    createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { createHash } from 'node:crypto';
    import { spawnSync } from 'node:child_process';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { runWithWorkspace } from './packages/operator-core/lib/workspace-als.ts';
    import { recordAdvSession, recordSuLaunchSpec } from './packages/operator-core/lib/adv-sessions.ts';
    import { insertTurns, ingestFileNow } from './packages/operator-core/lib/search/session-ingest.ts';
    import { reconcileIndexedLoopTurnStarts } from './packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts';
    import { LOOP_TURN_START_MARKER, LOOP_TURN_START_SCAN_MARKER } from './packages/operator-core/lib/agent-tools/activity/lifecycle-markers.ts';
    import { getLoopStatus } from './packages/operator-core/lib/harness/routines/loop.ts';
    import { reconcileLoopRoutines } from './packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts';
    import { tagTurnForInjection, readLedgerRows, appendLedgerRow, TURN_PROVENANCE_DIR } from './packages/operator-core/lib/turn-provenance/turn-provenance.ts';
    const hashes = JSON.parse(process.argv[1]);
    for (const [path, expected] of Object.entries(hashes))
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
    const hostDir = join(process.env.HOME, 'host-global', 'turn-provenance');
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = hostDir;
    console.log('LOOP_NAMESPACE_RUNTIME ' + JSON.stringify({ home: process.env.HOME, workspace, hashes }));
    const sql = getOrgPg().sql;
    const completed = [], rejected = [];
    const validLabels = ['valid-a', 'valid-b', 'legacy-current', 'resumed-legacy', 'resumed-pinned'];
    async function fixture(label, ws = workspace) {
      const owner = 'su-namespace-' + label, session = 'native-' + label, routine = 'routine-' + label;
      const legacy = ['legacy-current', 'resumed-legacy'].includes(label);
      const resumed = label.startsWith('resumed-') || label === 'foreign-history';
      const dir = legacy ? TURN_PROVENANCE_DIR : join(process.env.HOME, ws, label, 'turn-provenance');
      const fire = new Date();
      await sql.unsafe('INSERT INTO harness_shared.routines ' +
        '(id,install_slug,name,trigger_kind,trigger_config,target_role,active,workspace_id,last_fired_at,next_fire_at,reschedule_interval_sec,target_owner_id,metadata) ' +
        "VALUES ($1,'papercusp',$1,'cron','{}','su',true,$2,$3,'infinity',60,$4,$5::jsonb)",
        [routine, ws, fire, owner, JSON.stringify({ fire_count: 3, armed_at: fire.toISOString() })]);
      const launchId = await recordAdvSession({ workspaceId: ws, agent: 'codex', mode: 'omp',
        coordOwnerId: label === 'wrong-owner' ? owner + '-foreign' : owner,
        sessionId: label === 'wrong-session' ? session + '-foreign' : session });
      assert.ok(launchId);
      const spec = { v: 1, agent: 'codex', workspaceId: label === 'wrong-workspace' ? ws + '-foreign' : ws,
        ...(label === 'missing-pin' || legacy ? {} : { turnProvenanceDir: label === 'wrong-directory' ? dir + '-foreign' : dir }) };
      assert.equal(await recordSuLaunchSpec(launchId, label === 'wrong-owner' ? owner + '-foreign' : owner, spec), true);
      if (resumed) {
        await sql.unsafe('INSERT INTO harness_shared.session_identity_activation_events ' +
          '(workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,' +
          'transition_id,control_generation,phase,source,specification_revision,state_revision,recorded_at) ' +
          "VALUES ($1,$2,$2,$2,$2,$3,$4,$4,1,'applied','reanchor',$5,'fixture',$6)",
          [ws, label === 'foreign-history' ? owner + '-foreign' : owner, launchId, session, 'a'.repeat(64), fire]);
        await sql.unsafe('UPDATE harness_shared.adv_sessions SET session_id=$1 WHERE id=$2',
          [session + '-successor', launchId]);
      }
      const tagged = await tagTurnForInjection({ sid: owner, origin: 'loop-fire', text: 'Finish the private namespace fixture.',
        dir, loopFire: { routineId: routine, wakeCount: 3 } });
      assert.equal(tagged.ledgerWritten, true);
      // A valid nonce in the ingest host's unrelated directory must never
      // compensate for an absent or mismatched target launch receipt.
      if (![...validLabels, 'rollback'].includes(label)) {
        const enrollment = readLedgerRows(owner, { dir })[0];
        assert.ok(enrollment);
        assert.equal(await appendLedgerRow(enrollment, { dir: hostDir }), true);
      }
      const user = { workspace_id: 'default', source_kind: 'codex', session_id: session, turn_idx: 7,
        ts: new Date().toISOString(), owner, harness_slug: null, cwd: '/untrusted/transcript/cwd',
        speaker: 'user', text: tagged.taggedText };
      const reply = { ...user, turn_idx: 8, ts: new Date().toISOString(), speaker: 'assistant', text: 'Private fixture completed.' };
      return { owner, session, routine, user, reply, ws, dir };
    }
    async function indexedPath(c) {
      const dir = join(process.env.HOME, '.codex', 'sessions', '2026', '11', '06');
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'rollout-' + c.session + '.jsonl');
      const text = '{}\n';
      await writeFile(path, text);
      await sql.unsafe('INSERT INTO harness_shared.session_ingest_state ' +
        '(source_kind,file_path,byte_offset,turn_count,session_id) VALUES ($1,$2,$3,$4,$5) ' +
        'ON CONFLICT (source_kind,file_path) DO NOTHING', ['codex', path, Buffer.byteLength(text), 9, c.session]);
      return path;
    }
    async function refreshIndexed(c) {
      return ingestFileNow(await indexedPath(c), { owner: c.owner, sessionId: c.session });
    }
    async function proofs(c) {
      return sql.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1 AND summary=$2',
        [c.owner, LOOP_TURN_START_MARKER]);
    }
    async function scan(c) {
      const rows = await sql.unsafe('SELECT detail FROM harness_shared.agent_activity ' +
        'WHERE workspace_id=$1 AND owner_id=$2 AND session_id=$3 AND summary=$4 ORDER BY id DESC LIMIT 1',
        [c.ws, c.owner, c.session, LOOP_TURN_START_SCAN_MARKER]);
      return rows[0]?.detail;
    }
    async function seedScan(label, count, reverse = false) {
      const c = await fixture(label);
      await insertTurns(sql, [c.user, c.reply]);
      await sql.unsafe('DELETE FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner]);
      // Persist invalid candidates without passing through the current producer,
      // exactly as an older index or missing enrollment can leave them.
      const indices = Array.from({ length: count - 1 }, (_, i) => i + 9);
      if (reverse) indices.reverse();
      for (const idx of indices) await sql.unsafe('INSERT INTO harness_shared.session_turns ' +
        '(workspace_id,source_kind,session_id,turn_idx,ts,owner,speaker,text,turn_origin,turn_origin_verdict,turn_origin_classifier_version) ' +
        "VALUES ('default','codex',$1,$2,$3,$4,'user',$5,'loop-fire','agent-injected',1)",
        [c.session, idx, c.user.ts, c.owner, '⟦turn-origin:loop-fire nonce:' + idx.toString(16).padStart(16, '0') + '⟧\nUnenrolled.']);
      return c;
    }
    async function restartRefresh(c) {
      const path = await indexedPath(c);
      // Recreate the whole process, not just a SQL handle: the production
      // consumer must recover the cursor solely from committed database state.
      const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { getOrgPg } from '@papercusp/db-org';" +
        "import { ingestFileNow } from './packages/operator-core/lib/search/session-ingest.ts';" +
        "const c=JSON.parse(process.argv[1]); const sql=getOrgPg().sql;" +
        "try { await ingestFileNow(c.path,{owner:c.owner,sessionId:c.session}); } finally { await sql.end(); }",
        JSON.stringify({ path, owner: c.owner, session: c.session })],
        { encoding: 'utf8', timeout: 30000, env: process.env });
      assert.equal(run.status, 0, run.error?.message ?? run.stderr);
    }
    try {
      for (const [label, ws] of [['valid-a', workspace], ['valid-b', workspace + '-b'],
        ...['legacy-current','resumed-legacy','resumed-pinned',
          'wrong-owner','wrong-session','wrong-workspace','missing-pin','wrong-directory','foreign-history'].map(label => [label, workspace])]) {
        await runWithWorkspace(ws, async () => {
          const c = await fixture(label, ws);
          assert.equal(await insertTurns(sql, [c.user, c.reply]), 2);
          const stamps = await sql.unsafe('SELECT created_at, workspace_id, detail FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner]);
          const valid = validLabels.includes(label);
          assert.equal(stamps.length, valid ? 1 : 0, label);
          const status = await getLoopStatus(c.owner, { sql });
          assert.equal(status.lastLoopTurnAt, valid ? c.reply.ts : null, label);
          if (valid) {
            assert.equal(stamps[0].workspace_id, 'default');
            assert.ok(new Date(stamps[0].created_at).getTime() >= Date.parse(c.user.ts));
            assert.deepEqual(stamps[0].detail.loopFire, { routineId: c.routine, wakeCount: 3 });
            assert.deepEqual(stamps[0].detail.indexedTurn, { workspaceId: 'default', sourceKind: 'codex', sessionId: c.session, turnIdx: 7 });
            assert.equal(stamps[0].detail.provenanceWorkspaceId, ws);
            assert.equal(await insertTurns(sql, [c.user, c.reply]), 0);
            assert.equal((await sql.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 1);
            const reconciled = await reconcileLoopRoutines({ sql, nowMs: Date.now() + 10000,
              recordFire: async () => {}, readFireState: async () => null,
              countAgentToolCallsInWindow: async () => null });
            const result = reconciled.loops.find(row => row.id === c.routine);
            assert.equal(result.via, 'loop-turn');
            assert.equal(result.completedAt, Date.parse(c.reply.ts));
            if (label === 'valid-a') {
              // Model a native turn indexed before the producer was installed.
              // Its unchanged source must repair the marker without a new turn.
              await sql.unsafe('DELETE FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner]);
              assert.equal((await getLoopStatus(c.owner, { sql })).lastLoopTurnAt, null);
              assert.equal((await refreshIndexed(c)).inserted, 0);
              assert.equal((await getLoopStatus(c.owner, { sql })).lastLoopTurnAt, c.reply.ts,
                'no-new-bytes refresh repairs an already indexed authenticated turn');
              await Promise.all([refreshIndexed(c), refreshIndexed(c)]);
              assert.equal((await proofs(c)).length, 1);
            }
            completed.push({ label, routineId: c.routine, wakeCount: 3, turnIdx: 7, via: result.via });
          } else {
            assert.equal((await refreshIndexed(c)).inserted, 0);
            assert.equal((await proofs(c)).length, 0);
            rejected.push(label);
          }
        });
      }
      const boundary = [];
      for (const count of [63, 64, 65]) {
        const c = await seedScan('boundary-' + count, count);
        assert.equal((await refreshIndexed(c)).inserted, 0);
        assert.deepEqual(await scan(c), { schemaVersion: 1, inspected: Math.min(count, 64),
          hasMore: count > 64, resumeBefore: count > 64 ? { turnIdx: 9, workspaceId: 'default' } : null });
        assert.equal((await proofs(c)).length, count > 64 ? 0 : 1);
        if (count > 64) await restartRefresh(c);
        assert.equal((await proofs(c)).length, 1);
        assert.equal((await getLoopStatus(c.owner, { sql })).lastLoopTurnAt, c.reply.ts);
        boundary.push(count);
      }
      // More than three pages, either insertion order, with new head candidates
      // appearing between process restarts. Neither new heads nor rejected rows
      // may prevent the old authentic turn from reaching the completion reader.
      for (const reverse of [false, true]) {
        const c = await seedScan('fair-' + reverse, 194, reverse);
        for (let pass = 0; pass < 3; pass++) {
          await restartRefresh(c);
          assert.equal((await scan(c)).hasMore, true);
          assert.equal((await proofs(c)).length, 0);
          await sql.unsafe('INSERT INTO harness_shared.session_turns ' +
            '(workspace_id,source_kind,session_id,turn_idx,ts,owner,speaker,text,turn_origin) ' +
            "VALUES ('default','codex',$1,$2,$3,$4,'user','invalid envelope','loop-fire')",
            [c.session, 1000 + pass, c.user.ts, c.owner]);
        }
        await restartRefresh(c);
        assert.equal((await scan(c)).hasMore, false);
        assert.equal((await proofs(c)).length, 1);
        assert.equal((await getLoopStatus(c.owner, { sql })).lastLoopTurnAt, c.reply.ts);
        // A concurrent pair consumes one durable position and cannot duplicate
        // the same authenticated marker.
        await Promise.all([refreshIndexed(c), refreshIndexed(c)]);
        assert.equal((await proofs(c)).length, 1);
      }
      const late = await seedScan('late-enrollment', 65);
      await sql.unsafe('UPDATE harness_shared.adv_sessions SET launch_spec=launch_spec-$1 WHERE coord_owner_id=$2',
        ['turnProvenanceDir', late.owner]);
      // The host canonical directory has no enrollment for this private owner.
      await refreshIndexed(late);
      await refreshIndexed(late);
      assert.equal((await proofs(late)).length, 0);
      assert.equal((await scan(late)).resumeBefore, null);
      await sql.unsafe('UPDATE harness_shared.adv_sessions SET launch_spec=jsonb_set(launch_spec,\'{turnProvenanceDir}\',to_jsonb($1::text)) WHERE coord_owner_id=$2',
        [late.dir, late.owner]);
      await refreshIndexed(late);
      await refreshIndexed(late);
      assert.equal((await proofs(late)).length, 1, 'wrap retries late launch evidence');
      const rollbackScan = await seedScan('rollback-scan', 65);
      await assert.rejects(sql.begin(async tx => {
        await reconcileIndexedLoopTurnStarts(tx, { owner: rollbackScan.owner, sourceKind: 'codex', sessionId: rollbackScan.session });
        throw new Error('scan rollback');
      }), /scan rollback/);
      assert.equal(await scan(rollbackScan), undefined);
      await refreshIndexed(rollbackScan);
      assert.equal((await scan(rollbackScan)).resumeBefore.turnIdx, 9);
      await refreshIndexed(rollbackScan);
      assert.equal((await proofs(rollbackScan)).length, 1);
      const c = await fixture('rollback');
      await assert.rejects(sql.begin(async tx => {
        await insertTurns(tx, [c.user, c.reply]);
        assert.equal((await tx.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 1);
        throw new Error('private namespace rollback');
      }), /private namespace rollback/);
      assert.equal((await sql.unsafe('SELECT turn_idx FROM harness_shared.session_turns WHERE owner=$1', [c.owner])).length, 0);
      assert.equal((await sql.unsafe('SELECT id FROM harness_shared.agent_activity WHERE owner_id=$1', [c.owner])).length, 0);
      for (const [path, expected] of Object.entries(hashes))
        assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
      console.log('LOOP_NAMESPACE_RESULT ' + JSON.stringify({ completed, rejected, rollback: true, idempotent: true,
        boundary, restartFairness: true, lateEvidence: true, cursorRollback: true }));
    } finally { await sql.end(); }
  `;
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe, JSON.stringify(hashes)], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const childError = result.stderr.match(/(?:AssertionError|Error:|SyntaxError:)[\s\S]{0,2000}/)?.[0];
  const runtimeText = result.stdout.match(/^LOOP_NAMESPACE_RUNTIME (.+)$/m)?.[1];
  expect(runtimeText, childError ?? result.error?.message ??
    (result.stdout.slice(-2000) + result.stderr.slice(-2000))).toBeTruthy();
  const runtime = JSON.parse(runtimeText!);
  expect(existsSync(runtime.home)).toBe(false);
  // Cleanup can append more than 5KB after the assertion. Keep the originating
  // error first so a failed probe reports its cause rather than PG shutdown.
  expect(result.status, childError ?? result.error?.message ??
    (result.stdout.slice(-2000) + result.stderr.slice(-2000))).toBe(0);
  const evidenceText = result.stdout.match(/^LOOP_NAMESPACE_RESULT (.+)$/m)?.[1];
  expect(evidenceText).toBeTruthy();
  const evidence = JSON.parse(evidenceText!);
  expect(evidence.completed).toHaveLength(5);
  expect(evidence.rejected).toHaveLength(6);
  expect(evidence).toMatchObject({ rollback: true, idempotent: true, boundary: [63, 64, 65],
    restartFairness: true, lateEvidence: true, cursorRollback: true });
  console.log('LOOP_NAMESPACE_VERIFIED ' + JSON.stringify({ ...evidence, hashes, cleanup: true }));
}, 200000);
