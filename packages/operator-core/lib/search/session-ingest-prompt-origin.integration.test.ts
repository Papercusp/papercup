import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { classifyRecordedTurn } from '../turn-provenance/turn-ref';

const root = resolve(__dirname, '../../../..');
const source = resolve(root, 'packages/operator-core/lib/search/session-ingest.ts');

it('persists exact authenticated source stamps through the real ingest SQL without promoting mismatches', () => {
  // Check the negative control against the actual catalogue before starting PG.
  const machineText = '[SYSTEM NOTIFICATION: NOT USER INPUT]\nMachine-authored status';
  expect(classifyRecordedTurn(machineText).verdict).toBe('machine-surface');
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const probe = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { getOrgPg } from '@papercusp/db-org';
    import { activeWorkspaceId } from './packages/operator-core/lib/workspace-registry.ts';
    import { insertTurns, promptOriginHash, parseClaudeLine, parseCodexLine, parseOmpLine, backfillTurnProvenanceOnce } from './packages/operator-core/lib/search/session-ingest.ts';
    import { MACHINE_SURFACE_CATALOGUE_VERSION } from './packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts';
    const workspace = activeWorkspaceId();
    assert.ok(workspace.startsWith('test-runtime-'));
    assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
    assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
    const sourceHash = createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex');
    assert.equal(sourceHash, process.env.TEST_PROMPT_ORIGIN_SOURCE_HASH);
    console.log('PROMPT_ORIGIN_RUNTIME ' + JSON.stringify({ home: process.env.HOME, sourceHash }));
    const sql = getOrgPg().sql;
    const now = new Date(), cases = [];
    function candidate(label, sourceKind = 'codex', overrides = {}) {
      const text = overrides.text ?? 'measure the unchanged frozen cohort\r\n' + 'original prompt bytes '.repeat(500);
      const line = overrides.history
        ? { session_id: 'origin-' + label, ts: now.getTime() / 1000, text }
        : sourceKind === 'codex'
          ? { timestamp: now.toISOString(), type: 'response_item', payload: {
              type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
          : { timestamp: now.toISOString(), type: sourceKind === 'omp' ? 'message' : 'user',
              message: { role: 'user', content: [{ type: 'text', text }] } };
      const parser = sourceKind === 'claude' ? parseClaudeLine : sourceKind === 'omp' ? parseOmpLine : parseCodexLine;
      const parsed = parser(JSON.stringify(line));
      assert.ok(parsed);
      const row = { workspace_id: workspace, source_kind: sourceKind, session_id: 'origin-' + label,
        turn_idx: 0, ts: parsed.ts.toISOString(), owner: 'synthetic-owner', harness_slug: 'synthetic', cwd: null,
        speaker: parsed.speaker, text: parsed.text, prompt_hash: parsed.promptHash ?? null };
      cases.push({ label, row, rawPromptHash: promptOriginHash(text) });
      return row;
    }
    async function stamp(row, overrides = {}) {
      const s = { source_kind: row.source_kind, session_id: row.session_id,
        prompt_hash: cases.find(c => c.row === row).rawPromptHash,
        submitted_at: now, expires_at: new Date(now.getTime() + 600000), ...overrides };
      await sql\`INSERT INTO harness_shared.session_prompt_origin_stamps
        (workspace_id, source_kind, session_id, prompt_hash, submitted_at, expires_at)
        VALUES (\${workspace}, \${s.source_kind}, \${s.session_id}, \${s.prompt_hash}, \${s.submitted_at}, \${s.expires_at})\`;
    }
    try {
      // Fixture rows stand in for already authenticated hook receipts; the
      // model-facing hook writer is never called or impersonated by this test.
      for (const kind of ['claude', 'codex', 'omp']) await stamp(candidate(kind, kind));
      await stamp(candidate('codex-history', 'codex', { history: true }));
      await stamp(candidate('wrong-source'), { source_kind: 'claude' });
      await stamp(candidate('wrong-session'), { session_id: 'other-session' });
      await stamp(candidate('wrong-hash'), { prompt_hash: promptOriginHash('different directive') });
      await stamp(candidate('outside-window'), { submitted_at: new Date(now.getTime() - 120001) });
      await stamp(candidate('expired'), { expires_at: new Date(now.getTime() - 1) });
      await stamp(candidate('injected', 'codex', { text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nkeep going' }));
      candidate('legacy-residual');
      candidate('new-machine-rule', 'codex', { text: process.env.TEST_PROMPT_ORIGIN_MACHINE_TEXT });
      candidate('assistant');
      await insertTurns(sql, cases.map(c => c.row));
      const rows = await sql\`SELECT source_kind, session_id, turn_origin_verdict
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      console.log('PROMPT_ORIGIN_RESULT ' + JSON.stringify(rows));
      assert.equal(rows.length, cases.length);
      for (const c of cases) {
        const stored = rows.find(row => row.session_id === c.row.session_id);
        const expected = ['claude', 'codex', 'omp', 'codex-history'].includes(c.label) ? 'owner-typed'
          : c.label === 'injected' ? 'agent-injected'
          : c.label === 'new-machine-rule' ? 'machine-surface' : 'unenrolled-origin';
        assert.equal(stored.turn_origin_verdict, expected, c.label);
      }
      // A classifier upgrade outlives the ephemeral receipt. Re-derive the
      // actual stored rows after removing it, rather than trusting a mock.
      await sql\`DELETE FROM harness_shared.session_prompt_origin_stamps WHERE workspace_id = \${workspace}\`;
      await sql\`UPDATE harness_shared.session_turns
        SET turn_origin_classifier_version = \${MACHINE_SURFACE_CATALOGUE_VERSION - 1}
        WHERE workspace_id = \${workspace}\`;
      // Old text-only owner residuals have no authenticated tag. A formerly
      // positive tag must also lose to a current machine/speaker veto.
      await sql\`UPDATE harness_shared.session_turns SET turn_origin_verdict = 'owner-typed'
        WHERE workspace_id = \${workspace} AND session_id = 'origin-legacy-residual'\`;
      await sql\`UPDATE harness_shared.session_turns
        SET turn_origin = 'hook-authenticated-prompt', turn_origin_verdict = 'owner-typed'
        WHERE workspace_id = \${workspace} AND session_id IN ('origin-new-machine-rule', 'origin-assistant')\`;
      await sql\`UPDATE harness_shared.session_turns SET speaker = 'assistant'
        WHERE workspace_id = \${workspace} AND session_id = 'origin-assistant'\`;
      const repaired = await backfillTurnProvenanceOnce(sql, 100);
      assert.equal(repaired.scanned, cases.length);
      assert.equal(repaired.updated, cases.length);
      const after = await sql\`SELECT session_id, turn_origin, turn_origin_verdict, turn_origin_classifier_version
        FROM harness_shared.session_turns WHERE workspace_id = \${workspace} ORDER BY session_id\`;
      console.log('PROMPT_ORIGIN_BACKFILL_RESULT ' + JSON.stringify(after));
      for (const c of cases) {
        const stored = after.find(row => row.session_id === c.row.session_id);
        const positive = ['claude', 'codex', 'omp', 'codex-history'].includes(c.label);
        const expected = positive ? 'owner-typed' : c.label === 'injected' ? 'agent-injected'
          : c.label === 'new-machine-rule' ? 'machine-surface'
          : c.label === 'assistant' ? 'not-user-turn' : 'unenrolled-origin';
        assert.equal(stored.turn_origin_verdict, expected, c.label);
        assert.equal(stored.turn_origin_classifier_version, MACHINE_SURFACE_CATALOGUE_VERSION);
        if (positive) assert.equal(stored.turn_origin, 'hook-authenticated-prompt', c.label);
      }
      assert.equal((await backfillTurnProvenanceOnce(sql, 100)).scanned, 0);
      assert.equal(sourceHash, createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex'));
    } finally { await sql.end(); }
  `.replaceAll('\\`', '`').replaceAll('\\${', '${');
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: probe, encoding: 'utf8', timeout: 10000 });
  expect(syntax.status, syntax.stderr).toBe(0);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
    process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, TEST_PROMPT_ORIGIN_SOURCE_HASH: sourceHash, TEST_PROMPT_ORIGIN_MACHINE_TEXT: machineText },
  });
  const environment = result.stdout.match(/^PROMPT_ORIGIN_RUNTIME (.+)$/m)?.[1];
  if (result.status !== 0) process.stderr.write(result.stdout.slice(-5000) + '\n' + result.stderr.slice(-2000));
  expect(environment, result.stdout.slice(-2000)).toBeTruthy();
  expect(existsSync(JSON.parse(environment!).home)).toBe(false);
  expect(result.status, result.stdout.slice(-5000) + '\n' + result.stderr.slice(-5000)).toBe(0);
  expect(result.stdout).toContain('PROMPT_ORIGIN_RESULT');
}, 200000);
