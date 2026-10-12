/** Maintained ledger-recorded DAO HR native acceptance leg. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,DAO_HR_NATIVE_CONFIG,DAO_WORKBENCH_IDENTITY_FIXTURE,DOCUMENSO_URL,DOCUMENSO_TEST_MAIL_URL,DOCUMENSO_TEST_RUNTIME,DOCUMENSO_API_KEY,DOCUMENSO_WEBHOOK_SECRET,PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL,PAPERCUSP_CUPBOARD_URL
import { runNativeE2e } from './tauri-surface-verify-reports.mts';
await runNativeE2e(['packages/operator-core/lib/dao-hr/native.e2e.test.ts'], { runtimeUnit: 'dao-hr-native-desktop' });
