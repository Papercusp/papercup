/** Real provider proof, separate from the schema-derived simulations.
 * Run through scripts/with-documenso-sandbox.mjs; all accounts, email and
 * signatures belong to that disposable NON-BINDING fixture.
 * This verifies the provider boundary, not the full P012 desktop journey.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { contractPdf } from './contracts-esign';
import { DocumensoAdapter, type SigningPerson } from './documenso';

const enabled = Boolean(process.env.DOCUMENSO_TEST_RUNTIME);
const baseUrl = process.env.DOCUMENSO_URL ?? '';
const mailUrl = process.env.DOCUMENSO_TEST_MAIL_URL ?? '';

async function register(browser: Browser, person: SigningPerson) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const password = randomBytes(24).toString('base64url') + 'Aa1!';
  await page.goto(baseUrl + '/signup');
  await page.locator('input[name="name"]').fill(person.name);
  await page.locator('input[name="email"]').fill(person.email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toBe('/signup');
  return { context, page, password };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(baseUrl + '/signin');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).not.toBe('/signin');
}

async function accountToken(page: Page) {
  await page.goto(baseUrl + '/settings/tokens');
  await page.getByRole('button', { name: /create.*token/i }).click();
  await page.getByLabel(/name/i).fill('DAO HR non-binding sandbox');
  await page.getByRole('button', { name: /create.*token/i }).last().click();
  const token = await page.locator('input[readonly]').inputValue();
  expect(token.length).toBeGreaterThan(20);
  return token;
}

async function sign(page: Page, url: string) {
  await page.goto(url);
  const signature = page.locator('[data-field-type="SIGNATURE"]');
  await signature.click();
  await page.getByRole('button', { name: /sign/i }).last().click();
  await page.getByRole('button', { name: /complete|finish/i }).click();
  await expect.poll(() => page.locator('body').innerText(), { timeout: 30_000 }).toMatch(/signed|completed/i);
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
      await signIn(company.page, signers[1].email, company.password);
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
      await signIn(candidate.page, signers[0].email, candidate.password);
      await sign(candidate.page, links.find(link => link.email === signers[0].email)!.signingUrl);
      await expect(adapter.completed(event, { contractId, envelopeId, signers })).rejects.toMatchObject({ code: 'invalid_completion' });
      await sign(company.page, links.find(link => link.email === signers[1].email)!.signingUrl);
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
