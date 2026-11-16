/** Read-only physical-host observation. This never approves or establishes access. */
import { chromium, type Page } from 'playwright-core';

export const installedAttemptInstrument = {
  path: 'packages/operator-core/lib/workspace-host/installed-computer-attempt.fixture.ts',
  testPath: 'packages/operator-core/lib/workspace-host/installed-computer-attempt.test.ts',
};

type Options = {
  localOrigin: string;
  portalOrigin: string;
  timeoutMs?: number;
  runtimeIdentity: { sha: string; evidenceRef: string; observedAt: string };
};

function entryOrigin(value: string, local: boolean) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !['http:', 'https:'].includes(url.protocol) || (local && !loopback)
    || (!local && url.protocol !== 'https:' && !loopback)) {
    throw new Error(local ? 'physical_attempt_requires_loopback_origin' : 'physical_attempt_requires_portal_origin');
  }
  return url.origin;
}

async function observeEntry(page: Page, url: string, marker: string, timeout: number) {
  let httpStatus: number | null = null;
  let markerVisible = false;
  try {
    httpStatus = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout }))?.status() ?? null;
    if (httpStatus === 200) {
      await page.getByText(marker, { exact: true }).first().waitFor({ state: 'visible', timeout });
      markerVisible = true;
    }
  } catch { /* Keep an incomplete observation; never turn navigation failure into a pass. */ }
  return { requested: url, httpStatus, marker, markerVisible };
}

export async function observeInstalledComputerAttempt(options: Options) {
  // Validate destinations before creating a browser or sending any request.
  const localOrigin = entryOrigin(options.localOrigin, true);
  const portalOrigin = entryOrigin(options.portalOrigin, false);
  const timeout = options.timeoutMs ?? 20_000;
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const blockedMethods: string[] = [];
    await context.route('**/*', async route => {
      const method = route.request().method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method)) await route.continue();
      else { blockedMethods.push(method); await route.abort('blockedbyclient'); }
    });
    const [localPage, portalPage] = await Promise.all([context.newPage(), context.newPage()]);
    const [local, portal] = await Promise.all([
      observeEntry(localPage, `${localOrigin}/settings/remote-access#connect-computer`, 'Papercusp relay', timeout),
      observeEntry(portalPage, portalOrigin, 'Sign in or sign up', timeout),
    ]);
    let status: { httpStatus: number; parsed: boolean; state?: string; installationIdentityPresent?: boolean;
      consentAgreed?: boolean; linkedAccountPresent?: boolean; desktopGrantPresent?: boolean; connectorPresent?: boolean }
      = { httpStatus: 0, parsed: false };
    try {
      const response = await context.request.get(`${localOrigin}/api/remote-access/portal-relay`, { timeout });
      status.httpStatus = response.status();
      const body = await response.json();
      const raw = body?.ok === true ? body.relay : null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.state === 'string') {
        // Allowlist only state and presence bits. Never retain account, token, grant or connector objects.
        status = { httpStatus: response.status(), parsed: true,
          state: ['off', 'linking', 'linked', 'connecting', 'connected', 'error'].includes(raw.state) ? raw.state : 'unknown',
          installationIdentityPresent: Boolean(raw.installId), consentAgreed: raw.consent?.agreed === true,
          linkedAccountPresent: raw.linked != null, desktopGrantPresent: raw.desktop?.grant != null,
          connectorPresent: raw.connector != null };
      }
    } catch { /* Retain the HTTP status when JSON decoding fails. */ }
    const complete = local.httpStatus === 200 && local.markerVisible && portal.httpStatus === 200
      && portal.markerVisible && status.httpStatus === 200 && status.parsed;
    const requiredHumanActions = portal.markerVisible
      ? ['Choose the receiving Portal account and organization.', 'Sign in to that account.',
        'Review the local relay consent and receiving Portal approval.', 'Review the separate desktop view/control request.']
      : ['Resolve the incomplete entry observation before approving access.'];
    return {
      schemaVersion: 1, kind: 'operational-test-evidence', framework: 'operational',
      name: 'Existing installation: physical-host entry and authority boundary',
      command: ['node', '--import', 'tsx', '--input-type=module'], exitCode: complete ? 0 : 1,
      startedAt, finishedAt: new Date().toISOString(),
      summary: 'Fresh Chromium observed the installed entry and Portal without signing in or approving access. This records prerequisites only; no desktop connection was established.',
      instrument: installedAttemptInstrument,
      execution: { host: 'this physical host', browser: 'fresh nonpersistent Chromium', localOrigin, portalOrigin,
        runtimeIdentity: options.runtimeIdentity, mutationPolicy: 'Only GET, HEAD and OPTIONS browser requests are forwarded.' },
      assertions: [
        { id: 'physical-local-entry-opened', passed: local.httpStatus === 200 && local.markerVisible,
          evidence: JSON.stringify(local) },
        { id: 'physical-portal-sign-in-boundary', passed: portal.httpStatus === 200 && portal.markerVisible,
          evidence: JSON.stringify(portal) },
        { id: 'physical-authority-observed', passed: status.httpStatus === 200 && status.parsed,
          evidence: JSON.stringify(status) },
        { id: 'physical-required-human-action-recorded', passed: complete,
          evidence: requiredHumanActions.join(' ') },
        { id: 'physical-no-healthy-stream-claim', passed: true,
          evidence: 'No sign-in, approval or desktop operation was performed. Connector authorization, Noise, roster, frames and input were not exercised.' },
      ],
      observations: { local, portal, localStatus: status, blockedMethods: [...new Set(blockedMethods)].sort(),
        account: null, organization: null, desktopTransport: 'not exercised' },
      result: { disposition: complete ? 'human-prerequisites-required' : 'observation-incomplete',
        connectionEstablished: false, requiredHumanActions,
        scopeLimit: 'An entry observation cannot prove a healthy desktop connection or full served Portal acceptance.' },
    };
  } finally { await browser.close(); }
}
