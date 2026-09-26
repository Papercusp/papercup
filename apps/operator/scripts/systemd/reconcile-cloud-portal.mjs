#!/usr/bin/env node
/** Rebuild the portal when any compiled source, including linked packages, moves. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withPortalHandoffLock } from './portal-reconcile-lock.mts';

const scriptDir = dirname(fileURLToPath(import.meta.url));

async function run(command, args, cwd, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}

async function fingerprint(portalRoot) {
  const source = pathToFileURL(join(portalRoot, 'scripts/source-integrity.mjs')).href;
  const { fingerprintReleaseSource } = await import(source);
  const result = await fingerprintReleaseSource(portalRoot);
  if (!result.digest || !result.rootDigest) throw new Error('portal_source_digest_unavailable');
  return result;
}

async function releaseAt(runtimeRoot) {
  const path = await realpath(join(runtimeRoot, 'current'));
  const manifest = JSON.parse(await readFile(join(path, '.papercusp-release.json'), 'utf8'));
  return { path, manifest };
}

async function receiptAt(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeReceipt(path, receipt) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function reconcilePortal(config, deps = {}) {
  const portalRoot = resolve(config.portalRoot);
  const runtimeRoot = resolve(config.runtimeRoot);
  const receiptPath = join(runtimeRoot, '.papercusp-reconcile.json');
  const getFingerprint = deps.fingerprint ?? fingerprint;
  const getRelease = deps.releaseAt ?? releaseAt;
  const getReceipt = deps.receiptAt ?? receiptAt;
  const saveReceipt = deps.writeReceipt ?? writeReceipt;
  const checkHealth = deps.healthy ?? healthy;
  const runCommand = deps.run ?? run;
  const withHandoffLock = deps.withHandoffLock ?? withPortalHandoffLock;
  await mkdir(runtimeRoot, { recursive: true });

  const before = await getFingerprint(portalRoot);
  const current = await getRelease(runtimeRoot);
  const receipt = await getReceipt(receiptPath);
  const sameRelease = receipt?.releasePath === current.path;
  const sameSource = receipt?.sourceDigest === before.digest
    && receipt?.sourceRootDigest === before.rootDigest;
  if (sameRelease && sameSource) {
    if (await checkHealth(config.port)) return { status: 'fresh', releasePath: current.path };
    await withHandoffLock(async () => {
      await runCommand('bash', [config.deployScript, '--handoff'], config.integrationRoot, config.env);
      if (!(await checkHealth(config.port))) throw new Error('portal_handoff_health_failed');
    });
    return { status: 'recovered', releasePath: current.path };
  }

  await runCommand(config.npm, ['run', 'build'], portalRoot, config.env);
  const afterBuild = await getFingerprint(portalRoot);
  if (before.digest !== afterBuild.digest) {
    throw new Error('portal_linked_source_changed_during_build');
  }
  return withHandoffLock(async () => {
    await runCommand('bash', [config.deployScript, '--handoff'], config.integrationRoot, config.env);
    if (!(await checkHealth(config.port))) throw new Error('portal_handoff_health_failed');
    const deployed = await getRelease(runtimeRoot);
    const afterHandoff = await getFingerprint(portalRoot);
    if (afterHandoff.digest !== before.digest) {
      throw new Error('portal_linked_source_changed_during_handoff');
    }
    if (resolve(deployed.manifest.sourceRoot ?? '') !== portalRoot
      || deployed.manifest.sourceRootDigest !== before.rootDigest) {
      throw new Error('portal_release_source_mismatch');
    }
    await saveReceipt(receiptPath, {
      schemaVersion: 1,
      releasePath: deployed.path,
      sourceDigest: before.digest,
      sourceRootDigest: before.rootDigest,
    });
    return { status: 'deployed', releasePath: deployed.path };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portalRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_ROOT
    ?? join(homedir(), '.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal'));
  const runtimeRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT
    ?? join(dirname(portalRoot), '.portal-runtime', 'portal'));
  const integrationRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT
    ?? join(scriptDir, '../../../..'));
  reconcilePortal({
    portalRoot,
    runtimeRoot,
    integrationRoot,
    deployScript: process.env.PAPERCUSP_CLOUD_PORTAL_DEPLOY_SCRIPT
      ?? join(scriptDir, 'deploy-cloud-portal.sh'),
    npm: process.env.PAPERCUSP_CLOUD_PORTAL_NPM ?? 'npm',
    port: Number(process.env.PAPERCUSP_CLOUD_PORTAL_PORT ?? 3801),
    env: process.env,
  }).then(
    (result) => console.log(`cloud-portal-reconcile: ${result.status} ${result.releasePath}`),
    (error) => {
      console.error(`cloud-portal-reconcile: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
