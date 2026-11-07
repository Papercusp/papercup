import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launchManagedTestProcess } from '../../lib/agent-tools/testing/run';

// Invoked by with-test-pg-provenance.integration.test.ts. This process owns
// the launcher's platform clients and exits only after checking the real task.
async function verifyConfinedCleanup(): Promise<void> {
  const root = resolve(import.meta.dirname, '../../../..');
  const admissionCommand = join(root, 'scripts/testing-run-probe-overlay.sh');
  const sourceProof = {
    admissionCommand,
    admissionShellSha256: createHash('sha256').update(readFileSync(admissionCommand)).digest('hex'),
    fixtureSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  };
  const evidenceDir = mkdtempSync(join(tmpdir(), 'private-pg-confined-cleanup-'));
  const registry = join(evidenceDir, 'owned-databases');
  const outputPath = join(evidenceDir, 'wrapper.log');
  const name = 'confined_cleanup_0123456789ab';
  const childSource = `
    import postgres from 'postgres';
    import { registerOwnedTestDatabase } from './libs/test-config/src/owned-test-db-cleanup.ts';
    const adminUri = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    if (!adminUri) throw new Error('missing owned PostgreSQL endpoint');
    const sql = postgres(adminUri, { max: 1 });
    try {
      await sql.unsafe('CREATE DATABASE "${name}"');
      registerOwnedTestDatabase('${name}', adminUri)('deferred');
    } finally { await sql.end(); }
    console.log('CONFINED_DB_READY=' + JSON.stringify(process.env.PAPERCUSP_TEST_OWNED_DB_DIR));
    setInterval(() => {}, 1000);
  `;
  const deadline = Date.now() + 180_000;
  let resolveClosed!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    resolveClosed = done; rejectClosed = fail;
  });
  void closed.catch(() => {});
  const launched = await launchManagedTestProcess({
    // Exercise the production admission shell too: targeting the PG owner
    // directly cannot detect a shell/flock ancestor that drops cooperative TERM.
    command: admissionCommand,
    args: [root, '--', process.execPath, join(root, 'scripts/with-test-pg.mjs'), '--', process.execPath,
      '--import', 'tsx', '--input-type=module', '-e', childSource],
    cwd: root,
    env: { ...process.env, PAPERCUSP_TEST_OWNED_DB_DIR: registry,
      PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT: join(evidenceDir, 'admission'),
      PAPERCUSP_TEST_TASK_DEADLINE_AT_MS: String(deadline) },
    timeoutMs: 180_000, cooperativeTermination: true,
    runGroup: 'private-pg-confined-cleanup-regression',
    workspaceId: process.env.PAPERCUSP_WORKSPACE_ID!, outputPath,
    onSpawn: child => {
      child.once('error', rejectClosed);
      child.once('close', (code, signal) => resolveClosed({ code, signal }));
    },
  });
  let verified = false;
  try {
    assert.equal(launched.confined, true, 'real task confinement is required');
    assert.match(launched.scopeUnit ?? '', /^pc-.+\.scope$/);
    let output = '';
    while (Date.now() < deadline - 30_000) {
      output = readFileSync(outputPath, 'utf8');
      if (output.includes('CONFINED_DB_READY=')) break;
      if (launched.child.exitCode !== null || launched.child.signalCode !== null) break;
      await new Promise(done => setTimeout(done, 100));
    }
    assert.ok(output.includes('CONFINED_DB_READY='), output.slice(-6000));
    launched.terminate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([closed, new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error('Confined cleanup did not close: ' + outputPath)), 30_000);
    })]).finally(() => clearTimeout(timer));
    assert.ok(result.code === 143 || result.signal === 'SIGTERM');
    assert.equal((await launched.waitForCompletion()).status, 'recorded');
    output = readFileSync(outputPath, 'utf8');
    const line = output.split('\n').find(value => value.startsWith('CONFINED_DB_READY='));
    const ownedScope = JSON.parse(line!.slice('CONFINED_DB_READY='.length));
    assert.equal(dirname(ownedScope), registry);
    assert.equal(JSON.parse(readFileSync(join(ownedScope, `${name}.json`), 'utf8')).outcome, 'dropped');
    const receipts = readFileSync(join(ownedScope, 'cleanup.jsonl'), 'utf8');
    assert.doesNotMatch(receipts, /ECONNREFUSED|database-drop-error|database system is shutting down/);
    const stages = output.split('\n').filter(value => value.startsWith('[with-test-pg] cleanup '))
      .map(value => JSON.parse(value.slice('[with-test-pg] cleanup '.length)));
    assert.equal(stages.at(-1)?.stage, 'complete', output.slice(-6000));
    assert.equal(stages.at(-1)?.pgDataRemoved, true);
    const droppedAt = output.indexOf('[with-test-pg] owned database cleanup {"complete":true');
    const stoppingAt = output.indexOf('[with-test-pg] pg stopping postgres');
    assert.ok(droppedAt >= 0 && stoppingAt >= 0 && droppedAt < stoppingAt,
      'owned database cleanup must finish before the actual PostgreSQL stop');
    assert.equal(existsSync(stages.at(-1).dataDir), false);
    verified = true;
  } finally {
    launched.terminate();
    // Failed evidence remains available for diagnosis.
    if (verified) rmSync(evidenceDir, { recursive: true, force: true });
  }
  assert.equal(createHash('sha256').update(readFileSync(admissionCommand)).digest('hex'),
    sourceProof.admissionShellSha256, 'admission shell changed during the proof');
  console.log('CONFINED_PG_CLEANUP_VERIFIED ' + JSON.stringify(sourceProof));
}

// Platform notification clients are deliberately scoped to this fixture
// process. Terminate them only after every task and cleanup assertion above.
verifyConfinedCleanup().then(() => process.exit(0), error => {
  console.error(error);
  process.exit(1);
});
