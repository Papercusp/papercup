/** P004: populated owner snapshot -> HTTP health -> compiled native diagnostic. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,PAPERCUSP_TEST_RUN_GROUP,PAPERCUSP_P2P_JOIN_NATIVE_LIVE,PAPERCUSP_P2P_JOIN_NATIVE_EVIDENCE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';
import { verifyVerifierSourceSync } from '../packages/operator-core/lib/verifier-source';
import { checkNativeLedger, nativeLedgerEnvironment, nativeTestDatabaseEnvironment } from './tauri-surface-verify-reports.mts';

export async function runP2pJoinProgressNativeAcceptance() {
  assert.equal(process.env.PAPERCUSP_P2P_JOIN_NATIVE_LIVE, '1');
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1');
  const root = realpathSync(process.env.OPERATOR_SOURCE_ROOT!);
  const receipt = JSON.parse(readFileSync(process.env.VERIFY_TAURI_SOURCE_RECEIPT!, 'utf8'));
  assert.equal(receipt.schemaVersion, 'verifier-source-v1');
  assert.equal(receipt.sourceCommit, process.env.VERIFY_TAURI_SOURCE_REF);
  const test = 'packages/operator-core/lib/p2p-join-progress-native.e2e.test.ts';
  assert.ok(receipt.files.some((entry: { path: string }) => entry.path === test));
  verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
  checkNativeLedger(root);
  const profile = {
    tauriPID: Number(process.env.VERIFY_TAURI_PID), nativeTmpDir: tmpdir(),
    workspaceId: process.env.PAPERCUSP_WORKSPACE_ID!,
  };
  // Reuse the native verifier's postmaster/port/data-directory identity guard.
  const privateEnv = nativeTestDatabaseEnvironment(profile);
  const dir = mkdtempSync(join(tmpdir(), 'p2p-join-native-profile-'));
  const profilePath = join(dir, 'profile.json');
  writeFileSync(profilePath, JSON.stringify({ ...profile,
    privateAdminUrl: privateEnv.PAPERCUSP_TEST_PG_ADMIN_URL,
    evidencePath: process.env.PAPERCUSP_P2P_JOIN_NATIVE_EVIDENCE,
    runtimeUnits: [`verify-tauri-headless:${profile.tauriPID}`],
    requiredEnv: ['PAPERCUSP_P2P_JOIN_NATIVE_LIVE', 'PAPERCUSP_P2P_JOIN_NATIVE_EVIDENCE'],
  }), { mode: 0o600 });
  try {
    execFileSync('npm', ['run', 'test:file', '--', test, '--', '--reporter=default', '--reporter=hanging-process'], {
      cwd: root, stdio: 'inherit', env: { ...nativeLedgerEnvironment(),
        PAPERCUSP_TEST_RUN_COMMIT: receipt.sourceCommit,
        PAPERCUSP_APP_OPERATION_LIVE_PROFILE: profilePath },
    });
    verifyVerifierSourceSync(root, receipt, { runtimeArtifacts: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (isCliEntry(import.meta.url)) await runP2pJoinProgressNativeAcceptance();
