/** Native request journey. Only launched by the canonical disposable-runtime integration test. */
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { publishReport, getReport } from '../lib/report-library';
import { indexReport } from '../lib/search/report-index';
import { createReportSearchSource } from '../lib/agent-tools/search/report-source';
import { readProcessIdentity } from '../lib/process-identity';
import { buildMemoryContextBlock } from '../lib/memory/injection';

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    const timer = setTimeout(() => host?.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timer);
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'owned private host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271, 3278].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.KNOWLEDGE_NATIVE_EVIDENCE_DIR!;
  assert.ok(evidenceDir);
  const { sql } = getOrgPg();
  try {
    const owner = 'su-private-knowledge-reader';
    const reports = [];
    for (const token of ['zephyrquartz', 'cobaltquartz']) {
      const report = await publishReport(sql, { workspaceId: workspace, visibility: 'owner',
        title: 'Dated diagnostic evidence', bodyMd: 'Ordinary observations.\n'.repeat(600)
          + `\n## Diagnostic recovery\n${token} diagnostic snapshot recovery evidence. Retain the snapshot before restarting the diagnostic worker.` },
      { authorOwnerId: owner, harnessSlug: workspace });
      // This journey measures lexical native delivery; real vector/profile behavior
      // is separately covered by the migrated-PG source tests. No fake embedder.
      await indexReport(sql, report, null);
      const stored = await getReport(sql, workspace, report.reportId, { ownerId: owner });
      assert.ok(stored?.bodyMd.includes(token), 'canonical report readback must retain the full tail');
      reports.push(report);
    }
    const source = createReportSearchSource({ ownerId: owner, potSlug: workspace },
      { harnessSlugs: [workspace], automatic: true });
    const control = await source.lexical!({ sql, workspaceId: workspace, scopeFilter: null, limit: 20,
      query: 'zephyrquartz diagnostic snapshot recovery evidence' });
    assert.deepEqual(control.map(hit => hit.row.source_id), [reports[0].reportId], 'known fixture must reach the real search source');
    const warmReport = await publishReport(sql, { workspaceId: workspace, visibility: 'workspace',
      title: 'Warm corpus control', bodyMd: 'warmquartz diagnostic snapshot recovery evidence. Retain the snapshot.' },
    { authorOwnerId: 'su-private-knowledge-warmup', harnessSlug: workspace });
    await indexReport(sql, warmReport, null);
    const sourceBlock = await buildMemoryContextBlock({ workspaceId: workspace, harnessSlugs: [workspace],
      userId: null, queryContext: 'warmquartz diagnostic snapshot recovery evidence',
      session: { sessionId: 'su-private-source-control', port: 'turn-start', client: 'codex' } });
    writeFileSync(join(evidenceDir, 'source-control.json'), JSON.stringify({ payload: sourceBlock }));
    assert.ok(sourceBlock?.includes(warmReport.reportId), 'source memory builder failed known corpus control; see source-control.json');
    if (e.KNOWLEDGE_NATIVE_SOURCE_ONLY === '1') {
      console.log('KNOWLEDGE_NATIVE_SOURCE_READY ' + JSON.stringify({ workspace, reportId: warmReport.reportId }));
      return;
    }
    console.log('KNOWLEDGE_NATIVE_PHASE fixtures-ready');
    const bundle = join(evidenceDir, 'hono-host.mjs');
    console.log('KNOWLEDGE_NATIVE_PHASE bundle-start');
    try {
      const output = execFileSync('bash', [join(root, 'apps/operator/bin/bundle-host.sh'), 'bin/hono-host.ts', bundle],
        { cwd: root, env: e, encoding: 'utf8', timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
      writeFileSync(join(evidenceDir, 'build.log'), output);
    } catch (error: any) {
      writeFileSync(join(evidenceDir, 'build.log'), String(error.stdout ?? '') + String(error.stderr ?? ''));
      throw error;
    }
    const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    host = spawn(process.execPath, [bundle], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity);
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      assert.equal(host.exitCode, null, 'private host exited before readiness');
      try { healthy = (await fetch(base + '/api/health', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
      if (!healthy) await new Promise(done => setTimeout(done, 250));
    }
    assert.ok(healthy, 'private request host never became ready');
    console.log('KNOWLEDGE_NATIVE_PHASE host-ready');
    // Import the real native adapter and transport, preserving their actual walls.
    // @ts-ignore -- maintained native hook transport is a JavaScript module.
    const core = await import('../../../apps/operator/scripts/hooks/inject/core.mjs');
    // @ts-ignore -- maintained native Codex adapter is a JavaScript module.
    const adapter = await import('../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs');
    // Readiness is measured through the real port and its unchanged wall. Use a
    // separate owner so warming never consumes the reader's epoch/dedup state.
    const warmups = [];
    let ready = false;
    for (let attempt = 0; attempt < 6 && !ready; attempt++) {
      const began = Date.now();
      const payload = await core.runInjection({ adapter, nativeEvent: 'UserPromptSubmit',
        event: { prompt: 'warmquartz diagnostic snapshot recovery evidence', cwd: e.HOME },
        env: { ...e, PAPERCUSP_SID: `su-private-knowledge-warmup-${attempt}`, PAPERCUSP_HARNESS_SLUG: workspace } });
      ready = Boolean(payload?.includes(warmReport.reportId));
      warmups.push({ attempt, durationMs: Date.now() - began, ready, payload });
      writeFileSync(join(evidenceDir, 'warmup.json'), JSON.stringify(warmups));
      if (!ready) await new Promise(done => setTimeout(done, 250));
    }
    assert.ok(ready, 'actual native knowledge port never met its warm readiness precondition; see warmup.json');
    console.log('KNOWLEDGE_NATIVE_PHASE knowledge-ready');
    const requests: Array<{ url: string; status: number }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      requests.push({ url: String(url), status: response.status });
      return response;
    };
    const env = { ...e, PAPERCUSP_SID: owner, PAPERCUSP_HARNESS_SLUG: workspace };
    const turnStart = await core.runInjection({ adapter, nativeEvent: 'UserPromptSubmit',
      event: { prompt: 'zephyrquartz diagnostic snapshot recovery evidence', cwd: e.HOME }, env, fetchImpl });
    writeFileSync(join(evidenceDir, 'turn-start.json'), JSON.stringify({ requests, payload: turnStart }));
    assert.ok(turnStart?.includes(reports[0].reportId), 'native turn-start omitted the report reference');
    assert.ok(turnStart.includes('Retain the snapshot'), 'native turn-start omitted the matching tail excerpt');
    assert.equal(JSON.parse(turnStart).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    console.log('KNOWLEDGE_NATIVE_PHASE turn-start-delivered');
    const midTurn = await core.runInjection({ adapter, nativeEvent: 'PostToolUse',
      event: { tool_name: 'exec_command', tool_input: { cmd: 'rg cobaltquartz diagnostic snapshot recovery evidence' },
        tool_response: 'Investigating diagnostic snapshot recovery evidence', cwd: e.HOME }, env, fetchImpl });
    writeFileSync(join(evidenceDir, 'mid-turn.json'), JSON.stringify({ requests, payload: midTurn }));
    assert.ok(midTurn?.includes(reports[1].reportId), 'native mid-turn omitted novel report reference');
    assert.ok(midTurn.includes('Retain the snapshot'), 'native mid-turn omitted matching tail excerpt');
    assert.ok(!midTurn.includes(reports[0].reportId), 'native mid-turn repeated the paid turn-start reference');
    assert.equal(JSON.parse(midTurn).hookSpecificOutput.hookEventName, 'PostToolUse');
    await stopHost();
    console.log('KNOWLEDGE_NATIVE_RECEIPT ' + JSON.stringify({ workspace, requests, reportIds: reports.map(r => r.reportId),
      nativeClient: 'codex', turnStart: true, midTurn: true, hostPid: host.pid, hostStopped: true, bundleSha256 }));
  } finally {
    // Capture original pipeline receipts before private data is disposed.
    try {
      const rows = await sql`SELECT to_jsonb(r) AS receipt FROM harness_shared.memory_recall_stats r
        WHERE workspace_id = ${workspace} ORDER BY created_at DESC LIMIT 12`;
      writeFileSync(join(evidenceDir, 'recall-receipts.json'), JSON.stringify(rows));
    } catch (error: any) {
      writeFileSync(join(evidenceDir, 'recall-receipts.json'), JSON.stringify({ captureError: error.message }));
    }
    await stopHost(); await sql.end();
  }
}
main().catch(error => {
  console.error('KNOWLEDGE_NATIVE_FAILURE ' + JSON.stringify({ message: error.message, stack: error.stack }));
  process.exitCode = 1;
});
