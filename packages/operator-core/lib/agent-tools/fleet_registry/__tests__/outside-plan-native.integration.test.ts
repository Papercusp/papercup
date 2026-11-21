import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readlinkSync } from 'node:fs';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerFailureDetail } from '../../../../test/isolated-integration-proof';
import { preparePrivateWorkerSources, buildPrivateOperatorApiBundle,
  privateOperatorApiBuildBudget } from '../../../../test/private-http-workspace-preflight';
import { resolveFsMutexLockRoot } from '../../../../../../scripts/lib/fs-mutex.mjs';

const root = resolve(import.meta.dirname, '../../../../../..');
const scenario = 'packages/operator-core/lib/agent-tools/fleet_registry/__tests__/outside-plan-native-scenario.ts';
// This route has no parent IPC phase receipts. Its whole-run contract covers
// private PG + the maintained API build budget + native assertions + teardown.
const options = { timeoutMs: 900_000, killGraceMs: 45_000, drainGraceMs: 5_000 };

it.runIf(process.platform === 'linux')('launches two native members and drains only the outside assignment offline', async () => {
      preparePrivateWorkerSources(root, [scenario]);
      const artifacts = join(homedir(), '.papercusp', 'test-artifacts');
      await mkdir(artifacts, { recursive: true });
      const evidenceDir = await mkdtemp(join(artifacts, 'outside-fleet-native-'));
      await symlink(join(root, 'node_modules'), join(evidenceDir, 'node_modules'), 'dir');
      const ownedDbDir = join(evidenceDir, 'owned-databases');
      await mkdir(ownedDbDir);
      // Dependency readers coordinate with the account-wide installer. Keep
      // that canonical lock domain; private lock roots would split protection.
      const mutexRoot = resolveFsMutexLockRoot(process.env);
      await mkdir(mutexRoot, { recursive: true });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), LANG: 'C.UTF-8',
        PC_ISOLATED_RUNTIME_PROOF: '0', OUTSIDE_FLEET_EVIDENCE: evidenceDir, TMPDIR: '/tmp',
        PAPERCUSP_TEST_ARTIFACT_DIR: evidenceDir, PAPERCUSP_TEST_OWNED_DB_DIR: ownedDbDir,
        PAPERCUSP_FS_MUTEX_LOCK_DIR: mutexRoot,
        PAPERCUSP_EXPECTED_PID_NAMESPACE: readlinkSync('/proc/self/ns/pid'),
        PAPERCUSP_TEST_RUN_GROUP: process.env.PAPERCUSP_TEST_RUN_GROUP };
      const boundary = ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/',
        '--bind', evidenceDir, evidenceDir, '--bind', mutexRoot, mutexRoot,
        '--tmpfs', '/tmp', '--tmpfs', '/run', '--dev', '/dev', '--proc', '/proc'];
      // Fail cheaply on the two previously observed wrapper defects. This
      // exact mount/environment is also used for the expensive scenario.
      const preflight = spawnSync('bwrap', [...boundary, '--', process.execPath, '-e',
        "const a=require('node:assert/strict'),f=require('node:fs'),p=require('node:path'),o=require('node:os');" +
        "a.equal(process.env.PC_ISOLATED_RUNTIME_PROOF,'0');a.equal(process.connected,undefined);" +
        "a.equal(f.readlinkSync('/proc/self/ns/pid'),process.env.PAPERCUSP_EXPECTED_PID_NAMESPACE);" +
        "a.ok(o.networkInterfaces().lo.every(x=>x.internal));" +
        "for(const key of ['PAPERCUSP_TEST_ARTIFACT_DIR','PAPERCUSP_TEST_OWNED_DB_DIR']){" +
        "a.ok(process.env[key].startsWith(process.env.OUTSIDE_FLEET_EVIDENCE));" +
        "const q=p.join(process.env[key],'write-preflight');f.writeFileSync(q,'ok');f.unlinkSync(q);}" +
        "const lease=f.mkdtempSync(p.join(process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR,'native-preflight-'));f.rmdirSync(lease);" +
        "a.equal(process.env.PAPERCUSP_TEST_RUNS_DB_URL,undefined);console.log('OUTSIDE_FLEET_PREFLIGHT_PASS');"],
      { cwd: root, env, encoding: 'utf8', timeout: 10_000 });
      expect(preflight.status, preflight.stderr + preflight.stdout).toBe(0);
      expect(preflight.stdout).toContain('OUTSIDE_FLEET_PREFLIGHT_PASS');
      // The maintained working-tree route mints and fences a snapshot commit.
      // Prepare it before mounting the repository read-only; never relabel a
      // HEAD+dirty bundle or loosen the native serving-identity gate.
      const bundle = await buildPrivateOperatorApiBundle(root, evidenceDir, {
        ...privateOperatorApiBuildBudget(), env: { ...process.env, PAPERCUSP_BUNDLE_SNAPSHOT_DIRTY: '1' },
        onProgress: progress => console.info('OUTSIDE_NATIVE_BUILD_PROGRESS ' + JSON.stringify(progress)),
      });
      // PostgreSQL, operator and clients share the same private network. Keep
      // host PIDs for the canonical dependency leases; managed tasks own cleanup.
      const child = spawn('bwrap', [...boundary, '--', process.execPath, join(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime=operator-api', '--',
        process.execPath, '--import', 'tsx', join(root, scenario), evidenceDir, bundle.path, bundle.sha256], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        // This is the ordinary isolated-runtime CLI contract. Bubblewrap closes
        // inherited IPC; do not claim an IPC-attested runtime lifecycle here.
        env,
      });
      const result = await captureIsolatedWorker(child, evidenceDir, options);
      expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({ code: 0, signal: null,
        timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output, isolatedWorkerFailureDetail(result.output)).toContain('OUTSIDE_FLEET_NATIVE_VERIFIED ');
      console.info('OUTSIDE_FLEET_NATIVE_EVIDENCE ' + evidenceDir);
}, privateOperatorApiBuildBudget().maxMs + options.timeoutMs + options.killGraceMs + options.drainGraceMs + 20_000);
