/** Real provider proof, separate from the schema-derived simulations.
 * Run through scripts/with-documenso-sandbox.mjs; all accounts, email and
 * signatures belong to that disposable NON-BINDING fixture.
 * This verifies the provider boundary, not the full P012 desktop journey.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { contractPdf } from './contracts-esign';
import { DocumensoAdapter, type SigningPerson } from './documenso';

const enabled = Boolean(process.env.DOCUMENSO_TEST_RUNTIME);
const baseUrl = process.env.DOCUMENSO_URL ?? '';
const mailUrl = process.env.DOCUMENSO_TEST_MAIL_URL ?? '';

async function uiPhase<T>(page: Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch {
    // Do not include URLs, values, page text or Playwright call logs: they may
    // contain verification links, signing links, passwords or a new API token.
    const controls = await page.locator('input,button,[role="tab"]').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, name: element.getAttribute('name'), type: element.getAttribute('type'),
      testId: element.getAttribute('data-testid'), invalid: element.getAttribute('aria-invalid'),
      label: element.tagName === 'INPUT' ? element.getAttribute('aria-label') : element.textContent?.slice(0,80),
    }))).catch(() => []);
    throw new Error('Documenso UI phase failed: ' + name + '; controls=' + JSON.stringify(controls));
  }
}

async function savedSignature(page: Page, name: string) {
  // Upstream packages/app-tests/e2e/fixtures/signature.ts uses these maintained
  // test ids. Use UI input and the dialog action, rather than injecting state.
  await page.getByTestId('signature-pad-dialog-button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await dialog.getByTestId('signature-pad-type-input').fill(name);
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
}

async function verifyEmail(page: Page, email: string) {
  let messageId: string | undefined;
  await expect.poll(async () => {
    const response = await fetch(mailUrl + '/email', { signal: AbortSignal.timeout(5000) });
    expect(response.ok).toBe(true);
    const messages = await response.json() as Array<{ id: string; to: Array<{ address: string }> }>;
    messageId = messages.find(message => message.to.some(recipient => recipient.address === email))?.id;
    return Boolean(messageId);
  }, { timeout: 30_000 }).toBe(true);
  const response = await fetch(mailUrl + '/email/' + encodeURIComponent(messageId!), { signal: AbortSignal.timeout(5000) });
  expect(response.ok).toBe(true);
  const message = await response.json() as { html: string };
  const links = [...message.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]!.replaceAll('&amp;', '&'));
  const verification = links.find(link => {
    const url = new URL(link, baseUrl);
    return url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/verify-email/');
  });
  expect(Boolean(verification)).toBe(true);
  await page.goto(verification!);
  await expect.poll(() => page.locator('body').innerText(), { timeout: 30_000 }).toMatch(/Email Confirmed|Email already confirmed/i);
}

async function register(browser: Browser, person: SigningPerson) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const password = randomBytes(24).toString('base64url') + 'Aa1!';
  await uiPhase(page, 'register account with required signature', async () => {
    await page.goto(baseUrl + '/signup');
    await page.locator('input[name="name"]').fill(person.name);
    await page.locator('input[name="email"]').fill(person.email);
    await page.locator('input[name="password"]').fill(password);
    await savedSignature(page, person.name);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toBe('/signup');
  });
  await uiPhase(page, 'verify fixture email through provider UI', () => verifyEmail(page, person.email));
  return { context, page };
}

async function authenticatedAccount(page: Page, email: string) {
  // Signup establishes the session, and verification keeps it. Confirm the
  // account rather than navigating to /signin, which redirects signed-in users.
  // This reads the provider session; it does not create/authenticate a fixture.
  const response = await page.context().request.get(baseUrl + '/api/auth/session');
  expect(response.ok()).toBe(true);
  const session = await response.json();
  expect(session.isAuthenticated).toBe(true);
  expect(session.user?.email === email).toBe(true);
}

async function accountToken(page: Page) {
  return uiPhase(page, 'create team-scoped provider API token', async () => {
    await page.goto(baseUrl + '/');
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toMatch(/^\/t\/[^/]+\//);
    const team = new URL(page.url()).pathname.match(/^\/t\/([^/]+)\//)![1]!;
    await page.goto(baseUrl + '/t/' + team + '/settings/tokens');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="tokenName"]').fill('DAO HR non-binding sandbox');
    await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
    const token = await dialog.locator('input[name="createdToken"]').inputValue();
    expect(token.length).toBeGreaterThan(20);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    return token;
  });
}

async function sign(page: Page, url: string) {
  await uiPhase(page, 'insert signature and confirm signing consent', async () => {
    await page.goto(url);
    const signature = page.locator('[data-field-type="SIGNATURE"][data-inserted="false"]');
    await signature.click();
    await expect.poll(async () => await page.locator('[data-field-type="SIGNATURE"][data-inserted="true"]').count() > 0 ||
      await page.getByRole('dialog').isVisible(), { timeout: 30_000 }).toBe(true);
    if (await page.getByRole('dialog').isVisible()) {
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
      await dialog.getByTestId('signature-pad-type-input').fill('NON-BINDING TEST SIGNATURE');
      await dialog.getByRole('button', { name: 'Sign', exact: true }).click();
    }
    await expect.poll(() => page.locator('[data-field-type="SIGNATURE"][data-inserted="true"]').count(), { timeout: 30_000 }).toBe(1);
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    const confirmation = page.getByRole('dialog');
    await confirmation.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect.poll(() => confirmation.isVisible(), { timeout: 30_000 }).toBe(false);
  });
}

describe.skipIf(!enabled)('P006 real Documenso sandbox — authenticated sequential signing', () => {
  it('requires both accounts to sign before retrieving the sealed contract and audit certificate', async () => {
    const runtime = JSON.parse(process.env.DOCUMENSO_TEST_RUNTIME!);
    expect(runtime).toMatchObject({ kind: 'documenso-sandbox', isolatedDatabase: true, externalMail: false, testCertificate: true });
    expect(new URL(baseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(mailUrl).hostname).toBe('127.0.0.1');
    expect(runtime.appUrl).toBe(baseUrl);
    const suffix = randomUUID();
    const signers: [SigningPerson, SigningPerson] = [
      { personId: 'PER-test-candidate', name: 'DAO HR test candidate', email: 'candidate-' + suffix + '@daohr.example.test' },
      { personId: 'PER-test-company', name: 'DAO HR test company signer', email: 'company-' + suffix + '@daohr.example.test' },
    ];
    const browser = await chromium.launch({ headless: true });
    const contexts: BrowserContext[] = [];
    try {
      const candidate = await register(browser, signers[0]); contexts.push(candidate.context);
      const company = await register(browser, signers[1]); contexts.push(company.context);
      await authenticatedAccount(company.page, signers[1].email);
      const secret = randomBytes(32).toString('hex');
      const adapter = new DocumensoAdapter({ baseUrl, apiKey: await accountToken(company.page), webhookSecret: secret });
      const contractId = 'daohr-nonbinding-' + suffix;
      const pdf = await contractPdf(['NON-BINDING SANDBOX TEST. No employment, membership, shares or legal obligations are created.']);
      const envelopeId = await adapter.create({ contractId, ...pdf, signers });
      const links = await adapter.distribute(envelopeId);
      expect(await adapter.reconcile({ contractId, envelopeId, signers, pdf: pdf.pdf })).toBe('PENDING');
      const event = adapter.verifyWebhook(secret, { event: 'DOCUMENT_COMPLETED', createdAt: new Date().toISOString(),
        payload: { envelopeId, externalId: contractId, status: 'COMPLETED' } });
      await expect(adapter.completed(event, { contractId, envelopeId, signers })).rejects.toMatchObject({ code: 'invalid_completion' });
      await authenticatedAccount(candidate.page, signers[0].email);
      await sign(candidate.page, links.find(link => link.email === signers[0].email)!.signingUrl);
      await expect(adapter.completed(event, { contractId, envelopeId, signers })).rejects.toMatchObject({ code: 'invalid_completion' });
      await sign(company.page, links.find(link => link.email === signers[1].email)!.signingUrl);
      await expect.poll(() => adapter.reconcile({ contractId, envelopeId, signers, pdf: pdf.pdf }), { timeout: 30_000 }).toBe('COMPLETED');
      const result = await adapter.completed(event, { contractId, envelopeId, signers });
      expect(result.signers.map(signer => signer.email).sort()).toEqual(signers.map(signer => signer.email).sort());
      expect(Buffer.from(result.document.subarray(0, 5)).toString()).toBe('%PDF-');
      expect(Buffer.from(result.certificate.subarray(0, 5)).toString()).toBe('%PDF-');
      expect(Buffer.from(result.document).equals(Buffer.from(pdf.pdf))).toBe(false);
      expect(result.document.length).toBeGreaterThan(pdf.pdf.length);
    } finally {
      for (const context of contexts) await context.close();
      await browser.close();
    }
  }, 240_000);
});
