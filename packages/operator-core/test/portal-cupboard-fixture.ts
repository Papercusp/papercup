/** Disposable real-SQLite catalog behind the maintained Cupboard listings route. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { makeSqliteDb } from '../../../apps/operator-public/src/__tests__/sqlite-d1';
import { makeEnv, makeListingRow } from '../../../apps/operator-public/src/__tests__/fake-d1';
import { listingsRoute } from '../../../apps/operator-public/src/routes/listings';

export async function startPrivateCupboardCatalog(evidence: string) {
  const { db, raw } = makeSqliteDb();
  const { env } = makeEnv({ DB: db });
  const marker = `private-cupboard-${process.pid}`;
  const selectedTitle = marker + ' pack', neighborTitle = marker + ' plugin', hiddenTitle = marker + ' private';
  const columns = new Set((raw.prepare('PRAGMA table_info(harnesses)').all() as Array<{ name: string }>).map(row => row.name));
  for (const [id, title, kind, visibility] of [
    [marker + '-selected', selectedTitle, 'pack', 'public'],
    [marker + '-neighbor', neighborTitle, 'plugin', 'public'],
    [marker + '-hidden', hiddenTitle, 'pack', 'private'],
  ]) {
    const row = Object.entries(makeListingRow({ id, title, listing_kind: kind, visibility, review_status: 'approved',
      claim_status: 'unclaimed', github_repository_id: id === marker + '-selected' ? 901 : id === marker + '-neighbor' ? 902 : 903,
      github_name: id, description: 'Disposable catalog acceptance input' })).filter(([key]) => columns.has(key));
    raw.prepare(`INSERT INTO harnesses (${row.map(([key]) => key).join(',')}) VALUES (${row.map(() => '?').join(',')})`)
      .run(...row.map(([, value]) => value as never));
  }
  const api = listingsRoute();
  const observations: Array<{ url: string; status: number; body: string }> = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'GET', 'private catalog must never publish, claim or install');
      const url = new URL(request.url!, 'http://private-cupboard.invalid');
      assert.equal(url.pathname, '/listings');
      const result = await api.fetch(new Request(url), env);
      const body = await result.text();
      observations.push({ url: url.href, status: result.status, body });
      writeFileSync(join(evidence, 'portal-cupboard-upstream.json'), JSON.stringify(observations, null, 2));
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(body);
    } catch (error) { response.writeHead(503); response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const initial = await fetch(base + '/listings?limit=100');
    const body = await initial.json() as { results: Array<{ title: string }> };
    assert.equal(initial.status, 200);
    assert.deepEqual(body.results.map(row => row.title).sort(), [selectedTitle, neighborTitle].sort());
  } catch (error) {
    await new Promise<void>(done => server.close(() => done())); raw.close(); throw error;
  }
  return { base, marker, selectedTitle, neighborTitle, hiddenTitle,
    close: async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); raw.close(); } };
}

export async function runPrivateCupboardPage(page: Page, context: BrowserContext, input: {
  evidence: string; workspace: string; selected: string;
  cupboardSeed: { marker: string; selectedTitle: string; neighborTitle: string; hiddenTitle: string };
}, url: URL) {
  const seed = input.cupboardSeed;
  url.searchParams.set('slug', input.selected);
  url.searchParams.set('q', seed.marker);
  const reads: Array<{ url: string; status: number; body: string }> = [], writes: string[] = [];
  const captures = new Set<Promise<void>>();
  let denied = false;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') writes.push(request.url()); });
  page.on('response', response => {
    if (new URL(response.url()).pathname !== '/api/cupboard/listings') return;
    const capture = response.text().then(body => {
      reads.push({ url: response.url(), status: response.status(), body });
      writeFileSync(join(input.evidence, 'portal-cupboard-reads.json'), JSON.stringify(reads, null, 2));
    });
    captures.add(capture); void capture.catch(() => {});
    void capture.then(() => captures.delete(capture), () => captures.delete(capture));
  });
  await context.route('**/api/cupboard/listings?*', async route => {
    if (!denied) { await route.continue(); return; }
    const response = await context.request.get(route.request().url(), { headers: { host: 'foreign-cupboard.invalid' } });
    assert.equal(response.status(), 403);
    assert.equal((await response.json()).error.code, 'host_not_allowed');
    await route.fulfill({ response });
  });
  await page.goto(url.href);
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor();
  await page.getByText(seed.neighborTitle, { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.hiddenTitle, { exact: true }).count(), 0);
  const packs = page.getByRole('button', { name: /^Packs\b/ });
  await packs.focus(); await page.keyboard.press('Enter');
  await page.getByRole('textbox').fill(seed.marker);
  const unclaimed = page.getByRole('button', { name: 'unclaimed', exact: true });
  await unclaimed.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(marker => new URL(location.href).searchParams.get('q') === marker
    && new URL(location.href).searchParams.get('kind') === 'pack'
    && new URL(location.href).searchParams.get('claim') === 'unclaimed', seed.marker);
  const assertScope = () => {
    const params = new URL(page.url()).searchParams;
    for (const [key, value] of Object.entries({ app: 'cupboard', ws: input.workspace, slug: input.selected,
      q: seed.marker, kind: 'pack', claim: 'unclaimed' })) assert.equal(params.get(key), value);
  };
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.neighborTitle, { exact: true }).count(), 0);
  assertScope(); await page.reload(); await page.getByText(seed.selectedTitle, { exact: true }).waitFor(); assertScope();
  denied = true;
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  await refresh.focus(); await page.keyboard.press('Enter');
  await page.getByTestId('cupboard-error-state').getByText("Couldn't load listings (HTTP 403).", { exact: true }).waitFor();
  assert.equal(await page.getByText(seed.selectedTitle, { exact: true }).count(), 0);
  assertScope(); await page.reload(); await page.getByTestId('cupboard-error-state').waitFor(); assertScope();
  denied = false;
  await page.getByTestId('cupboard-error-retry').focus(); await page.keyboard.press('Enter');
  await page.getByText(seed.selectedTitle, { exact: true }).waitFor(); assertScope();
  await Promise.all([...captures]);
  assert.ok(reads.filter(read => read.status === 403).length >= 2);
  const filtered = reads.filter(read => read.status === 200 && new URL(read.url).searchParams.get('kind') === 'pack'
    && new URL(read.url).searchParams.get('q') === seed.marker && new URL(read.url).searchParams.get('claim') === 'unclaimed');
  assert.ok(filtered.length >= 2, 'real filtered reads must survive reload and retry');
  for (const read of filtered) assert.deepEqual(JSON.parse(read.body).listings.map((row: { title: string }) => row.title), [seed.selectedTitle]);
  assert.deepEqual(writes, []);
  return { workspace: input.workspace, privateSqliteCatalog: true, publicOperatorProxy: true, keyboardFilters: true,
    filterReload: true, warmHostDenialRecovery: true, coldHostDenialRecovery: true, hiddenListingExcluded: true, writes,
    scope: 'Actual Cupboard page and public proxy with maintained worker listings handler on migrated private SQLite; seeded catalog and test KV, actual Host denials. No workerd, production Cupboard, hosted tenant, install or shipment proof.' };
}
