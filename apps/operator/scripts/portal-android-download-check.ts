import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type PhaseReceipt = { phase: string; outcome: 'passed' | 'failed' };
// The executable runs under tsx already. A second tsImport namespace corrupts
// import.meta.url in the fixture's own tsImport calls (path?namespace=...).
export async function loadPortalModule(path: string) {
  const mod = await import(pathToFileURL(path).href);
  return { ...mod.default, ...mod };
}
export async function assertAuthenticatedArtifact(oracle: any, response: any, options: any, root: string, expectedRelease: string) {
  const release = oracle.resolveServedRelease({ ...options, html: await response.text() });
  if (release.release !== expectedRelease) throw new Error('authenticated_artifact_changed');
  oracle.assertTutorialSourceCustody(release, root);
}
export async function enterSupportedAccountShell(page: any) {
  if (await page.getByRole('heading', { name: 'Welcome to Papercusp', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Manage your account and preferences', exact: true }).click();
    await page.getByRole('link', { name: 'Open account', exact: true }).click();
    await page.waitForURL((url: URL) => url.searchParams.get('firstRun') === 'deferred');
  }
}
export async function runDownloadPhases(
  steps: Array<{ phase: string; run: () => Promise<void> }>,
  cleanup: () => Promise<void>,
  observe: () => Promise<Record<string, boolean | number | null>>,
) {
  const receipt: { phases: PhaseReceipt[]; failedPhase?: string; diagnostics?: Record<string, boolean | number | null>; cleanup: boolean; passed: boolean } = { phases: [], cleanup: false, passed: false };
  try {
    for (const step of steps) {
      try { await step.run(); receipt.phases.push({ phase: step.phase, outcome: 'passed' }); }
      catch { receipt.failedPhase = step.phase; receipt.phases.push({ phase: step.phase, outcome: 'failed' }); break; }
    }
    if (receipt.failedPhase) receipt.diagnostics = await observe().catch(() => ({ observationFailed: true }));
  } finally {
    try { await cleanup(); receipt.cleanup = true; } catch { receipt.cleanup = false; }
  }
  receipt.passed = !receipt.failedPhase && receipt.cleanup;
  return receipt;
}

// Reuses the Portal's maintained admission and immutable serving oracle.
// This executable creates a genuine TEST identity only with explicit opt-in.
export async function main() {
  if (process.env.PORTAL_ANDROID_CLICK_TEST !== '1') throw new Error('explicit_test_admission_required');
  if (!process.env.PORTAL_ANDROID_ROOT) throw new Error('explicit_portal_root_required');
  const root = resolve(process.env.PORTAL_ANDROID_ROOT);
  const origin = process.env.PORTAL_ANDROID_ORIGIN;
  const expectedRelease = process.env.PORTAL_ANDROID_RELEASE;
  const expectedHash = process.env.PORTAL_ANDROID_APK_SHA256;
  const output = process.env.PORTAL_ANDROID_EVIDENCE_DIR;
  const envFile = process.env.PORTAL_ANDROID_DOWNLOAD_ENV;
  if (!origin || !expectedRelease || !expectedHash || !output || !envFile) throw new Error('explicit_candidate_inputs_required');
  const load = async (path: string) => {
    return loadPortalModule(join(root, path));
  };
  const admission = await load('e2e/hosted-test-user.ts');
  const oracle = await load('e2e/served-artifact.ts');
  const runtime = await load('scripts/standalone-runtime.mjs');
  const playwright = await load('node_modules/@playwright/test/index.mjs');
  let user: any, browser: any, page: any, kit: any;
  let navigationStatus: number | null = null;
  let navigationResponse: any;
  let downloadedHash: string | undefined;
  const receipt = await runDownloadPhases([
    { phase: 'artifact-custody', run: async () => {
      const release = oracle.resolveServedRelease({ html: await (await fetch(origin)).text(), releasesDir: runtime.standaloneRuntimePaths(root).releasesRoot, journeyStartedAt: new Date(), expectedBuildId: expectedRelease.split('-2026')[0] });
      if (release.release !== expectedRelease) throw new Error('artifact_changed');
      oracle.assertTutorialSourceCustody(release, root);
    } },
    { phase: 'fixture-preflight', run: async () => { kit = await admission.loadHostedTestUserKit(root); } },
    { phase: 'test-admission', run: async () => {
      const nonce = randomUUID();
      user = await kit.create({ email: `android-click-${nonce}@example.test`, attemptId: `android-click-${nonce}`, firstName: 'Android TEST', lastName: 'Download', displayName: 'Android download TEST' });
    } },
    { phase: 'browser-launch', run: async () => { browser = await playwright.chromium.launch({ channel: 'chrome', headless: true }); } },
    { phase: 'session-cookie', run: async () => { const context = await browser.newContext({ acceptDownloads: true }); context.setDefaultTimeout(10000); await context.addCookies([user.cookie(origin)]); page = await context.newPage(); } },
    { phase: 'navigation', run: async () => { navigationResponse = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 }); navigationStatus = navigationResponse?.status() ?? null; if (navigationStatus !== 200) throw new Error('navigation_refused'); } },
    { phase: 'authenticated-artifact-custody', run: async () => {
      await assertAuthenticatedArtifact(oracle, navigationResponse, { releasesDir: runtime.standaloneRuntimePaths(root).releasesRoot, journeyStartedAt: new Date(), expectedBuildId: expectedRelease.split('-2026')[0] }, root, expectedRelease);
    } },
    { phase: 'supported-onboarding', run: async () => { await enterSupportedAccountShell(page); } },
    { phase: 'android-toolbar', run: async () => {
      const link = page.getByRole('link', { name: 'Download Android app', exact: true });
      await link.waitFor({ state: 'visible', timeout: 20000 });
      const line = readFileSync(envFile, 'utf8').split('\n').find(x => x.startsWith('NEXT_PUBLIC_PORTAL_ANDROID_DOWNLOAD_URL='));
      const target = line?.slice(line.indexOf('=') + 1).replace(/^"|"$/g, '');
      if (!target || await link.getAttribute('href') !== target) throw new Error('target_mismatch');
    } },
    { phase: 'click-download', run: async () => {
      const pending = page.waitForEvent('download', { timeout: 30000 });
      await page.getByRole('link', { name: 'Download Android app', exact: true }).click();
      await (await pending).saveAs(join(output, 'authenticated-click.apk'));
    } },
    { phase: 'candidate-hash', run: async () => { downloadedHash = createHash('sha256').update(readFileSync(join(output, 'authenticated-click.apk'))).digest('hex'); if (downloadedHash !== expectedHash) throw new Error('candidate_mismatch'); } },
  ], async () => {
    const errors = [];
    try { if (browser) await browser.close(); } catch (e) { errors.push(e); }
    try { if (user) await user.cleanup('Android download verification complete'); } catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors);
  }, async () => ({ navigationStatus, pagePresent: !!page, welcomeVisible: page ? await page.getByRole('heading', { name: 'Welcome to Papercusp', exact: true }).isVisible() : false, androidLinks: page ? await page.getByRole('link', { name: 'Download Android app', exact: true }).count() : 0 }));
  const evidence = { ...receipt, release: expectedRelease, downloadedHash, fixtureReturned: !!user };
  writeFileSync(join(output, 'authenticated-click-phases.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
  if (!receipt.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) void main().catch(() => { console.error('android_download_precondition_failed'); process.exitCode = 1; });
