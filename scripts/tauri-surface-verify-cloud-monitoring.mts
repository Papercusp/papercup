/** Ledger-recorded local usage and disclosure acceptance in the maintained native rig. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,PAPERCUSP_TEST_RUN_GROUP
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { checkNativeLedger, runNativeE2e } from './tauri-surface-verify-reports.mts';

if (process.argv.includes('--check-ledger')) {
  checkNativeLedger();
  console.info('CLOUD_MONITORING_NATIVE_LEDGER_PREFLIGHT_OK');
} else {
  const selection = parseSelectionArgs(process.argv.slice(2));
  const result = await runHarness({
    contract: { name: 'cloud-monitoring-native',
      phases: [{ id: 'native', description: 'Customer-local per-call usage and disclosure reader' }] },
    evidenceRoot: defaultEvidenceRoot('cloud-monitoring-native'), selection, reuseFrom: selection.reuse,
    async runPhase(ctx) {
      ctx.markStep('isolated-native-cloud-monitoring');
      await runNativeE2e(['packages/operator-core/lib/cloud-monitoring-native.e2e.test.ts'],
        { runtimeUnit: 'cloud-monitoring-native-desktop' });
      return { ok: true };
    },
  });
  console.info(`CLOUD_MONITORING_NATIVE_${result.verdict.toUpperCase()} evidence=${result.evidenceDir}`);
  process.exitCode = result.verdict === 'pass' ? 0 : 1;
}
