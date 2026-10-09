/** Native request journey. Only launched by the canonical disposable-runtime integration test. */
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { publishReport, getReport } from '../lib/report-library';
import { indexReport } from '../lib/search/report-index';
import { readProcessIdentity } from '../lib/process-identity';

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
    const core = await import('../../../apps/operator/scripts/hooks/inject/core.mjs');
    const adapter = await import('../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs');
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
  } finally { await stopHost(); await sql.end(); }
}
main().catch(error => {
  console.error('KNOWLEDGE_NATIVE_FAILURE ' + JSON.stringify({ message: error.message, stack: error.stack }));
  process.exitCode = 1;
});
