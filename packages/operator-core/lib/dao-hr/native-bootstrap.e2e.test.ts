/** Configures external fixtures BEFORE the owned native host boots. Run with the maintained Documenso sandbox. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { prepareIdentityFixture, installIdentityFixture } from '../../../../scripts/fixtures/dao-workbench-identity.mjs';
import { startDaoHrTestChain } from '../../../../scripts/fixtures/dao-hr-test-chain';
import { startDaoHrWalletBindingFixture } from '../../../../scripts/fixtures/dao-hr-wallet-binding';
import { register, authenticatedAccount, accountToken } from '../../../../scripts/fixtures/dao-hr-documenso-ui';
import { resolveExecutedMapPgUrl } from '../../../../scripts/lib/executed-source-map.mjs';

describe.skipIf(process.env.PAPERCUSP_DAO_HR_NATIVE !== '1')('P012 combined native hire bootstrap', () => {
  it('runs the isolated native hire journey with actual provider accounts, hosted wallet routes and signed V2 chain', async () => {
    expect(Boolean(process.env.DOCUMENSO_TEST_RUNTIME)).toBe(true);
    const runtime = JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME!);
    expect(runtime).toMatchObject({ isolatedDatabase: true, externalMail: false, testCertificate: true });
    const directory = mkdtempSync(join(tmpdir(), 'dao-hr-native-'));
    const root = resolve(import.meta.dirname, '../../../..');
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_VERIFY_TAURI_ISOLATED: '1' };
    const identityPath = prepareIdentityFixture(directory);
    const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    env.DAO_WORKBENCH_IDENTITY_FIXTURE = identityPath;
    const restoreIdentity = installIdentityFixture(identity, env);
    const priorIsolation = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
    process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = '1';
    let chain: Awaited<ReturnType<typeof startDaoHrTestChain>> | undefined;
    let wallet: Awaited<ReturnType<typeof startDaoHrWalletBindingFixture>> | undefined;
    const browser = await chromium.launch({ headless: true });
    try {
      chain = await startDaoHrTestChain(); wallet = await startDaoHrWalletBindingFixture();
      const candidate = await register(browser, { personId: 'PER-native-candidate', name: 'Native candidate', email: identity.actors.candidate.email });
      const company = await register(browser, { personId: 'PER-native-approver', name: 'Native countersigner', email: identity.actors.approver.email });
      await authenticatedAccount(company.page, identity.actors.approver.email);
      env.DOCUMENSO_API_KEY = await accountToken(company.page);
      env.DOCUMENSO_WEBHOOK_SECRET = randomBytes(32).toString('hex');
      env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL = chain.url; env.PAPERCUSP_CUPBOARD_URL = wallet.url;
      const candidateSession = join(directory, 'candidate-provider.json'), companySession = join(directory, 'company-provider.json');
      await candidate.context.storageState({ path: candidateSession }); await company.context.storageState({ path: companySession });
      const configPath = join(directory, 'native-config.json');
      writeFileSync(configPath, JSON.stringify({ rpc: chain.url, accounts: chain.accounts,
        equity: chain.equity.address, governor: chain.governor.address, timelock: chain.timelock.address,
        candidateSession, companySession, resultPath: join(directory, 'result.json') }), { mode: 0o600 });
      env.DAO_HR_NATIVE_CONFIG = configPath;
      env.PAPERCUSP_TEST_RUNS_DB_URL = process.env.PAPERCUSP_TEST_RUNS_DB_URL || resolveExecutedMapPgUrl().url;
      env.PAPERCUSP_TEST_RUN_WORKSPACE = process.env.PAPERCUSP_TEST_RUN_WORKSPACE || process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE!;
      expect(Boolean(env.PAPERCUSP_TEST_RUN_WORKSPACE)).toBe(true);
      const evidenceRoot = '/tmp/pcv/dao-hr-native'; mkdirSync(evidenceRoot, { recursive: true });
      const logPath = process.env.DAO_HR_NATIVE_BOOT_LOG || join(evidenceRoot, 'native-boot-' + Date.now() + '.log');
      const fd = openSync(logPath, 'w', 0o600);
      let code: number | null;
      try {
        const child = spawn('bash', [join(root, 'scripts/verify-tauri-headless.sh'), '--', 'node', '--import', 'tsx',
          join(root, 'scripts/tauri-surface-verify-dao-hr.mts')], { cwd: root,
          env: { ...env, VERIFY_TAURI_ISOLATED_DB: '1', VERIFY_TAURI_ISOLATED_SEED: 'ready', VERIFY_TAURI_WINDOW: '1440x1000',
            VERIFY_TAURI_SOURCE_INPUTS: [
              'packages/operator-core/lib/dao-hr/native-bootstrap.e2e.test.ts',
              'packages/operator-core/lib/dao-hr/native.e2e.test.ts',
              'scripts/tauri-surface-verify-dao-hr.mts', 'scripts/fixtures/dao-hr-documenso-ui.ts',
              'scripts/fixtures/dao-hr-test-chain.ts', 'scripts/fixtures/dao-hr-wallet-binding.ts',
              'scripts/lib/dao-workbench-controls.mts', 'packages/operator-core/lib/dao-finance.ts',
            ].join(','),
            NODE_OPTIONS: (env.NODE_OPTIONS || '') + ' --import=' + join(root, 'scripts/fixtures/dao-workbench-identity.mjs') },
          stdio: ['ignore', fd, fd] });
        code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done); });
      } finally { closeSync(fd); }
      expect(code, 'Native boot/journey log: ' + logPath).toBe(0);
      const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
      expect(result).toMatchObject({ hireExecuted: true, acceptanceVerified: true, memberAdmitted: true, nonBinding: true });
      writeFileSync(logPath + '.result.json', JSON.stringify(result), { mode: 0o600 });
      console.log('DAO_HR_NATIVE_RESULT=' + JSON.stringify(result));
    } finally {
      await browser.close(); await wallet?.stop(); await chain?.stop(); restoreIdentity();
      if (priorIsolation === undefined) delete process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED;
      else process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED = priorIsolation;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 1_200_000);
});
