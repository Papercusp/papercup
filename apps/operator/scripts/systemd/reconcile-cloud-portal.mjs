#!/usr/bin/env node
/** Rebuild the portal when any compiled source, including linked packages, moves. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
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

async function publicLinksSnapshot(path, inherited) {
  const keys = ['NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL', 'NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL'];
  let values = {};
  try {
    values = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (Object.keys(values).some((key) => !keys.includes(key))) throw new Error('portal_public_links_unknown_key');
  const env = { ...inherited, ...values };
  const links = Object.fromEntries(keys.map((key) => [key, env[key] ?? '']));
  for (const value of Object.values(links)) {
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error('portal_public_links_invalid_url'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('portal_public_links_invalid_url');
  }
  return { env, digest: createHash('sha256').update(JSON.stringify(links)).digest('hex') };
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
  const readPublicLinks = () => publicLinksSnapshot(publicLinksEnv, config.env);
  const getPublicLinksDigest = deps.publicLinksDigest ?? (async () => (await readPublicLinks()).digest);
  const checkHealth = deps.healthy ?? healthy;
  const runCommand = deps.run ?? run;
  const withHandoffLock = deps.withHandoffLock ?? withPortalHandoffLock;
  await mkdir(runtimeRoot, { recursive: true });

  const publicLinksEnv = resolve(config.publicLinksEnv
    ?? join(homedir(), '.config/papercusp/portal-public-links.env'));
  const before = await getFingerprint(portalRoot);
  const publicLinks = await readPublicLinks();
  const beforePublicLinksDigest = deps.publicLinksDigest ? await getPublicLinksDigest(publicLinksEnv) : publicLinks.digest;
  const current = await getRelease(runtimeRoot);
  const receipt = await getReceipt(receiptPath);
  const sameRelease = receipt?.releasePath === current.path;
  const sameSource = receipt?.sourceDigest === before.digest
    && receipt?.sourceRootDigest === before.rootDigest;
  const samePublicLinks = receipt?.publicLinksDigest === beforePublicLinksDigest;
  if (sameRelease && sameSource && samePublicLinks) {
    if (await checkHealth(config.port)) return { status: 'fresh', releasePath: current.path };
    await withHandoffLock(async () => {
      await runCommand('bash', [config.deployScript, '--handoff'], config.integrationRoot, config.env);
      if (!(await checkHealth(config.port))) throw new Error('portal_handoff_health_failed');
    });
    return { status: 'recovered', releasePath: current.path };
  }

  await runCommand(config.npm, ['run', 'build'], portalRoot, publicLinks.env);
  const afterBuild = await getFingerprint(portalRoot);
  const afterBuildPublicLinksDigest = await getPublicLinksDigest(publicLinksEnv);
  if (before.rootDigest !== afterBuild.rootDigest) {
    throw new Error('portal_linked_source_changed_during_build');
  }
  if (before.digest !== afterBuild.digest) {
    console.warn('cloud-portal-reconcile: linked sources changed during build; handing off the completed release and retaining the earlier digest for the next reconciliation');
  }
  if (beforePublicLinksDigest !== afterBuildPublicLinksDigest) {
    throw new Error('portal_public_links_changed_during_build');
  }
  return withHandoffLock(async () => {
    await runCommand('bash', [config.deployScript, '--handoff'], config.integrationRoot, config.env);
    if (!(await checkHealth(config.port))) throw new Error('portal_handoff_health_failed');
    const deployed = await getRelease(runtimeRoot);
    const afterHandoff = await getFingerprint(portalRoot);
    const afterHandoffPublicLinksDigest = await getPublicLinksDigest(publicLinksEnv);
    if (afterHandoff.rootDigest !== before.rootDigest) {
      throw new Error('portal_linked_source_changed_during_handoff');
    }
    if (resolve(deployed.manifest.sourceRoot ?? '') !== portalRoot
      || deployed.manifest.sourceRootDigest !== before.rootDigest) {
      throw new Error('portal_release_source_mismatch');
    }
    if (afterHandoffPublicLinksDigest !== beforePublicLinksDigest) {
      throw new Error('portal_public_links_changed_during_handoff');
    }
    await saveReceipt(receiptPath, {
      schemaVersion: 2,
      releasePath: deployed.path,
      sourceDigest: before.digest,
      sourceRootDigest: before.rootDigest,
      publicLinksDigest: beforePublicLinksDigest,
    });
    return { status: 'deployed', releasePath: deployed.path };
  });
}

/** A one-shot service must terminate after its lock/DB work, even if the pool keeps handles open. */
export async function settleReconcileProcess(task) {
  let code = 0;
  let message;
  try {
    const result = await task;
    message = `cloud-portal-reconcile: ${result.status} ${result.releasePath}`;
  } catch (error) {
    code = 1;
    message = `cloud-portal-reconcile: ${error instanceof Error ? error.message : String(error)}`;
  }
  const stream = code === 0 ? process.stdout : process.stderr;
  await new Promise((resolveWrite) => stream.write(`${message}\n`, resolveWrite));
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portalRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_ROOT
    ?? join(homedir(), '.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal'));
  const runtimeRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT
    ?? join(dirname(portalRoot), '.portal-runtime', 'portal'));
  const integrationRoot = resolve(process.env.PAPERCUSP_CLOUD_PORTAL_INTEGRATION_ROOT
    ?? join(scriptDir, '../../../..'));
  settleReconcileProcess(reconcilePortal({
    portalRoot,
    runtimeRoot,
    integrationRoot,
    publicLinksEnv: resolve(process.env.PAPERCUSP_CLOUD_PORTAL_PUBLIC_LINKS_ENV
      ?? join(homedir(), '.config/papercusp/portal-public-links.env')),
    deployScript: process.env.PAPERCUSP_CLOUD_PORTAL_DEPLOY_SCRIPT
      ?? join(scriptDir, 'deploy-cloud-portal.sh'),
    npm: process.env.PAPERCUSP_CLOUD_PORTAL_NPM ?? 'npm',
    port: Number(process.env.PAPERCUSP_CLOUD_PORTAL_PORT ?? 3801),
    env: process.env,
  }));
}
